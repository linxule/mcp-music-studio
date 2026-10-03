// =============================================================================
// Live sessions — one player that stays open, read and written by the model
//
// The 2026-10-02 field test on claude.ai (iPhone) found the feedback loop
// still open: the widget reports through ui/update-model-context, but the
// chat had no tool to read widget context, so the user was the only channel
// back. And every play-live-pattern call made a NEW player, so a back-to-back
// set could not keep playing through a handover.
//
// A session closes both with plain HTTPS, which the widget can already reach
// (say() clips come from the same Worker):
//
//   play-live-pattern(session: true) → a session id, in the text and _meta
//   the widget joins it               → posts its runtime reports, the human's
//                                       taps, code edits and "your turn"
//   get-session(id)                   → the model reads all of that
//   update-session(id, code)          → the widget swaps the pattern in on the
//                                       next bar (no new player) and reports
//                                       whether it ran
//
// This module is the pure part: ids, the event log, coercion of what the
// widget sends (untrusted), and the text the model reads. The Worker's
// Durable Object (worker/src/session-do.ts) stores it; nothing here does I/O.
// =============================================================================

/** 16 chars of base32: 80 random bits. The id is a bearer capability. */
export const SESSION_ID_RE = /^[a-z2-7]{16}$/;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export function mintSessionId(
  random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (b) => crypto.getRandomValues(b),
): string {
  const bytes = random(new Uint8Array(16));
  let id = "";
  for (let i = 0; i < 16; i++) id += BASE32[bytes[i] & 31];
  return id;
}

/** How long an idle session lives (no widget poll, no model call). */
export const SESSION_IDLE_TTL_MS = 2 * 60 * 60 * 1000;
/**
 * How long an ENDED session is kept (the listener pressed End session): long
 * enough for the model's next get-session to read why the player went quiet,
 * then everything is deleted.
 */
export const SESSION_ENDED_TTL_MS = 10 * 60 * 1000;
/** A widget that has not polled for this long is probably gone. */
export const SESSION_WIDGET_STALE_MS = 60_000;
/** How long the Durable Object holds a player's poll open (the poll IS its heartbeat). */
export const SESSION_POLL_WAIT_MS = 20_000;
/**
 * A player re-polls the moment a poll returns, and at once on any change of
 * state, so a live one checks in at least every SESSION_POLL_WAIT_MS plus a
 * round trip. A "playing" heartbeat older than this means the player has gone
 * quiet — on a phone, usually an app in the background or a locked screen,
 * which suspends it — so the clock is no longer extrapolated from it.
 */
export const SESSION_HEARTBEAT_LATE_MS = SESSION_POLL_WAIT_MS + 10_000;
/** Events kept per session (oldest dropped first). */
export const SESSION_MAX_EVENTS = 400;
/** Code edits whose full text is kept (older ones keep only their size). */
export const SESSION_MAX_EDIT_BODIES = 3;
export const SESSION_MAX_CODE_CHARS = 64 * 1024;
export const SESSION_MAX_TEXT_CHARS = 2000;
/**
 * The whole session is one Durable Object value, and a value is capped at
 * 2 MB (Codex review: a worst-case log serialized to 5.2 MB). Keep the JSON
 * under this, dropping the oldest events (then edit bodies) to make room.
 */
export const SESSION_MAX_BYTES = 1_200_000;
/**
 * How far ahead of a boundary a swap must be decided, in seconds: the widget
 * evaluates 0.6 s before the bar, plus 0.25 s of slack. The server's "queued
 * for cycle N" uses the same lead, so it names the bar the widget will pick.
 */
export const SESSION_SWAP_LEAD_S = 0.85;
/** What get-session(wait) waits for. */
export type ListenMode = "pass" | "activity";
/** How long get-session(wait) may hold, in ms — under host tool-call timeouts. */
export const LISTEN_DEFAULT_MS = 40_000;
export const LISTEN_MAX_MS = 55_000;
/** After the first move, "activity" keeps listening this long to catch the phrase. */
export const LISTEN_SETTLE_MS = 4_000;

/** Did the listener do something (not the player reporting, not you)? */
export function isHumanEvent(e: { t: string }): boolean {
  return e.t === "tap" || e.t === "control" || e.t === "edit" || e.t === "pass";
}

/** Quantize to at most this many cycles ahead. */
export const SESSION_MAX_QUANTIZE = 32;

export type SessionEvent =
  | { seq: number; at: number; t: "joined"; host?: string; platform?: string; caps?: string[]; widget?: string }
  | { seq: number; at: number; t: "report"; text: string }
  | { seq: number; at: number; t: "tap"; cycle: number; x: number; y: number }
  | { seq: number; at: number; t: "edit"; cycle: number | null; code: string | null; chars: number }
  | {
      seq: number;
      at: number;
      t: "applied";
      rev: number;
      ok: boolean;
      cycle: number | null;
      error?: string;
      report?: string;
    }
  | { seq: number; at: number; t: "pass"; cycle: number | null }
  | { seq: number; at: number; t: "control"; name: string; kind: string; value: number | [number, number]; cycle: number | null; source?: string }
  | { seq: number; at: number; t: "controls"; list: ControlState[] }
  | { seq: number; at: number; t: "update"; rev: number; quantize: number }
  /** The player picked the bar an update lands on (sent before it waits for it). */
  | { seq: number; at: number; t: "scheduled"; rev: number; boundary: number }
  /** The listener closed the session (server-written by the `end` op, never coerced from a widget batch). */
  | { seq: number; at: number; t: "ended"; cycle: number | null };

/** One control on the player's strip, as the model sees it. */
export interface ControlState {
  name: string;
  kind: string;
  value: number | [number, number];
  min?: number;
  max?: number;
  /** tilt()/mic(): the sensor behind it, and whether it (or a hand) is playing it. */
  sensor?: string;
  source?: string;
}

/** An event before the log stamps it. */
export type NewEvent = SessionEvent extends infer E ? (E extends SessionEvent ? Omit<E, "seq" | "at"> : never) : never;

export interface QueuedPattern {
  rev: number;
  code: string;
  /** 0 = now; n = the next cycle that is a multiple of n. */
  quantize: number;
  at: number;
}

export interface Heartbeat {
  at: number;
  cycle: number | null;
  cps: number | null;
  state: string;
}

export interface SessionData {
  id: string;
  created: number;
  lastActivity: number;
  seq: number;
  /** The model has read every event up to and including this seq. */
  readSeq: number;
  events: SessionEvent[];
  rev: number;
  pattern: QueuedPattern | null;
  heartbeat: Heartbeat | null;
  /** The code the session opened with, so a second screen has something to load. */
  seed?: string | null;
  /** The widget's answer for the newest rev — kept apart from the log, which is trimmed. */
  lastApplied?: Extract<SessionEvent, { t: "applied" }> | null;
  /** When the listener ended the session (End session); null/absent while it is open. */
  endedAt?: number | null;
  endedCycle?: number | null;
}

/** When this session's storage is deleted: 2 h after the last activity, or 10 min after it was ended. */
export function sessionExpiresAt(data: SessionData): number {
  return typeof data.endedAt === "number" ? data.endedAt + SESSION_ENDED_TTL_MS : data.lastActivity + SESSION_IDLE_TTL_MS;
}

/**
 * Close the session (the listener pressed End session). Idempotent: returns
 * false if it was already ended. The `ended` event goes into the log so the
 * model reads where the set stopped.
 */
export function endSession(data: SessionData, cycle: unknown, now: number): boolean {
  if (typeof data.endedAt === "number") return false;
  const at = finite(cycle);
  appendEvents(data, [{ t: "ended", cycle: at }], now);
  data.endedAt = now;
  data.endedCycle = at;
  return true;
}

export function newSession(id: string, now: number, seed?: string): SessionData {
  return {
    seed: typeof seed === "string" && seed.trim() ? seed.slice(0, SESSION_MAX_CODE_CHARS) : null,
    id,
    created: now,
    lastActivity: now,
    seq: 0,
    readSeq: 0,
    events: [],
    rev: 0,
    pattern: null,
    heartbeat: null,
    lastApplied: null,
  };
}

const encoder = new TextEncoder();
export const sessionBytes = (data: SessionData): number => encoder.encode(JSON.stringify(data)).length;

/** Trim the oldest events, then edit bodies, until the session fits one storage value. */
export function enforceSessionBudget(data: SessionData, max = SESSION_MAX_BYTES): void {
  let size = sessionBytes(data);
  while (size > max && data.events.length) {
    // Drop in chunks: re-measuring after every single event is quadratic.
    const drop = Math.max(1, Math.ceil(data.events.length * Math.min(0.5, (size - max) / size + 0.05)));
    data.events.splice(0, drop);
    size = sessionBytes(data);
  }
}

const finite = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const clamp01 = (v: unknown): number => {
  const n = finite(v);
  return n === null ? 0 : Math.min(1, Math.max(0, n));
};
const text = (v: unknown, max = SESSION_MAX_TEXT_CHARS): string | null =>
  typeof v === "string" ? v.slice(0, max) : null;

type Incoming = Record<string, unknown>;

function controlValue(v: unknown): number | [number, number] | null {
  if (Array.isArray(v) && v.length === 2) {
    const x = finite(v[0]);
    const y = finite(v[1]);
    return x === null || y === null ? null : [x, y];
  }
  return finite(v);
}

const showValue = (v: number | [number, number]): string =>
  Array.isArray(v) ? `x ${v[0].toFixed(2)}, y ${v[1].toFixed(2)}` : String(Math.round(v * 1000) / 1000);

/**
 * Turn what a widget posted into log events. The widget is untrusted (anyone
 * holding the id can post), so every field is re-typed and bounded; unknown
 * kinds are dropped.
 */
export function coerceEvents(raw: unknown, max = 64): NewEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: NewEvent[] = [];
  for (const item of raw.slice(0, max)) {
    if (!item || typeof item !== "object") continue;
    const e = item as Incoming;
    switch (e.t) {
      case "joined":
        out.push({
          t: "joined",
          host: text(e.host, 80) ?? undefined,
          platform: text(e.platform, 40) ?? undefined,
          caps: Array.isArray(e.caps)
            ? e.caps.filter((c): c is string => typeof c === "string").slice(0, 20).map((c) => c.slice(0, 40))
            : undefined,
          widget: typeof e.widget === "string" && /^\d+\.\d+\.\d+[\w.-]{0,16}$/.test(e.widget) ? e.widget : undefined,
        });
        break;
      case "scheduled": {
        const rev = finite(e.rev);
        const boundary = finite(e.boundary);
        if (rev !== null && boundary !== null && rev >= 0 && boundary >= 0) {
          out.push({ t: "scheduled", rev: Math.floor(rev), boundary });
        }
        break;
      }
      case "report": {
        const t = text(e.text);
        if (t) out.push({ t: "report", text: t });
        break;
      }
      case "tap": {
        const cycle = finite(e.cycle);
        if (cycle !== null) out.push({ t: "tap", cycle, x: clamp01(e.x), y: clamp01(e.y) });
        break;
      }
      case "edit": {
        const code = typeof e.code === "string" ? e.code.slice(0, SESSION_MAX_CODE_CHARS) : null;
        if (code !== null) out.push({ t: "edit", cycle: finite(e.cycle), code, chars: code.length });
        break;
      }
      case "applied": {
        const rev = finite(e.rev);
        if (rev === null) break;
        out.push({
          t: "applied",
          rev,
          ok: e.ok === true,
          cycle: finite(e.cycle),
          error: text(e.error, 600) ?? undefined,
          report: text(e.report) ?? undefined,
        });
        break;
      }
      case "pass":
        out.push({ t: "pass", cycle: finite(e.cycle) });
        break;
      case "control": {
        const name = text(e.name, 32);
        const value = controlValue(e.value);
        const source = e.source === "sensor" || e.source === "manual" ? e.source : undefined;
        if (name && value !== null) {
          out.push({ t: "control", name, kind: text(e.kind, 8) ?? "?", value, cycle: finite(e.cycle), ...(source ? { source } : {}) });
        }
        break;
      }
      case "controls": {
        if (!Array.isArray(e.list)) break;
        const list: ControlState[] = [];
        for (const c of e.list.slice(0, 12)) {
          const item = c as Incoming;
          const name = text(item?.name, 32);
          const value = controlValue(item?.value);
          if (!name || value === null) continue;
          list.push({
            name,
            kind: text(item.kind, 8) ?? "?",
            value,
            min: finite(item.min) ?? undefined,
            max: finite(item.max) ?? undefined,
            sensor: item.sensor === "tilt" || item.sensor === "mic" ? item.sensor : undefined,
            source: item.source === "sensor" || item.source === "manual" ? item.source : undefined,
          });
        }
        out.push({ t: "controls", list });
        break;
      }
    }
  }
  return out;
}

/** Append events, enforcing the caps. Returns the events as stored. */
export function appendEvents(
  data: SessionData,
  incoming: NewEvent[],
  now: number,
): SessionEvent[] {
  const added: SessionEvent[] = [];
  for (const e of incoming) {
    const event = { ...e, seq: ++data.seq, at: now } as SessionEvent;
    data.events.push(event);
    added.push(event);
  }
  if (data.events.length > SESSION_MAX_EVENTS) {
    data.events.splice(0, data.events.length - SESSION_MAX_EVENTS);
  }
  // Keep the full text of the newest edits only; the rest keep their size.
  let bodies = 0;
  for (let i = data.events.length - 1; i >= 0; i--) {
    const e = data.events[i];
    if (e.t !== "edit" || e.code === null) continue;
    if (++bodies > SESSION_MAX_EDIT_BODIES) e.code = null;
  }
  for (const e of added) {
    if (e.t !== "applied") continue;
    const prev = data.lastApplied;
    // A stopped second screen's "loaded" never overwrites a playing player's
    // answer for the same rev.
    const weaker = prev && prev.rev === e.rev && prev.ok && prev.cycle !== null && e.cycle === null;
    if (!prev || (e.rev >= prev.rev && !weaker)) data.lastApplied = e;
  }
  if (added.length) data.lastActivity = now;
  enforceSessionBudget(data);
  return added;
}

export function recordHeartbeat(data: SessionData, hb: Omit<Heartbeat, "at">, now: number): void {
  data.heartbeat = { ...hb, at: now };
  data.lastActivity = now;
}

export function clampQuantize(q: unknown): number {
  const n = finite(q);
  if (n === null) return 1;
  return Math.min(SESSION_MAX_QUANTIZE, Math.max(0, Math.round(n)));
}

/** Queue the model's next pattern; it supersedes any not yet applied. */
export function queuePattern(data: SessionData, code: string, quantize: number, now: number): QueuedPattern {
  const pattern: QueuedPattern = {
    rev: ++data.rev,
    code: code.slice(0, SESSION_MAX_CODE_CHARS),
    quantize: clampQuantize(quantize),
    at: now,
  };
  data.pattern = pattern;
  appendEvents(data, [{ t: "update", rev: pattern.rev, quantize: pattern.quantize }], now);
  return pattern;
}

/** The first cycle at or after `cycle + lead` that is a multiple of `quantize`. */
export function nextBoundary(cycle: number, quantize: number, lead = 0): number {
  if (quantize <= 0) return cycle + lead;
  return Math.ceil((cycle + lead) / quantize - 1e-9) * quantize;
}

/** Where the widget's clock is now, extrapolated from its last check-in. */
export function estimatedCycle(hb: Heartbeat | null, now: number): number | null {
  if (!hb || hb.cycle === null) return null;
  if (hb.state !== "playing" || hb.cps === null) return hb.cycle;
  return hb.cycle + ((now - hb.at) / 1000) * hb.cps;
}

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
const cyc = (c: number | null | undefined): string =>
  c === null || c === undefined ? "?" : (Math.round(c * 10) / 10).toFixed(1);
/** "cycle 12.0", or what a null cycle means: the player was stopped. */
const atCycle = (c: number | null | undefined): string => (c == null ? "while the player was stopped" : `cycle ${cyc(c)}`);
/** A swap answered with no cycle: the player is stopped, so it plays from Play. */
export const LOADED_STOPPED = "is loaded in the player, which is stopped — it starts when Play is pressed";
/** The same answer as history: true when it arrived, not necessarily now. */
export const ARRIVED_STOPPED = "arrived while the player was stopped, so no bar applied — it was loaded to start on Play";

function describeTaps(taps: Array<Extract<SessionEvent, { t: "tap" }>>): string {
  const n = taps.length;
  const xs = taps.reduce((s, t) => s + t.x, 0) / n;
  const ys = taps.reduce((s, t) => s + t.y, 0) / n;
  const where = [
    xs < 0.38 ? "mostly left" : xs > 0.62 ? "mostly right" : "across the middle",
    ys < 0.38 ? "high" : ys > 0.62 ? "low" : "mid-height",
  ].join(", ");
  const first = taps[0].cycle;
  const last = taps[n - 1].cycle;
  return `the human tapped ${n} time${n === 1 ? "" : "s"}, cycles ${cyc(first)}–${cyc(last)} (${where}; x/y are 0..1 from the top left)`;
}

/**
 * The model-facing state of a session. `since` is the last seq the model has
 * read (events after it are "new"); the caller advances readSeq.
 */
/**
 * Pattern functions the widget gained in a given release. A host that caches
 * the widget by URI can run an older one than the server documents (claude.ai
 * served a pre-0.9 widget: "tilt is not defined", 2026-10-02).
 */
export const WIDGET_FUNCTION_SINCE: Readonly<Record<string, string>> = {
  say: "0.7.0", onFrame: "0.7.0", onEvent: "0.7.0", onTap: "0.7.0", cycle: "0.7.0",
  fader: "0.8.0", pad: "0.8.0", xy: "0.8.0",
  tilt: "0.9.0", mic: "0.9.0",
};

/** -1 / 0 / 1 for dotted numeric versions; unknown parts compare as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  return 0;
}

/** The player's widget version as it reported it when it joined (absent before 0.10.1). */
export function widgetVersion(data: SessionData): string | null {
  for (let i = data.events.length - 1; i >= 0; i--) {
    const e = data.events[i];
    if (e.t === "joined") return e.widget ?? null;
  }
  return null;
}

/**
 * An error naming a function the widget only gained in a later release means
 * the host is running an older, cached widget. Say so plainly, with the fix.
 */
export function staleWidgetHint(error: string | undefined | null, widget: string | null): string | null {
  const m = error ? /\b([A-Za-z_$][\w$]*) is not defined\b/.exec(error) : null;
  if (!m) return null;
  const since = WIDGET_FUNCTION_SINCE[m[1]];
  if (!since) return null;
  if (widget && compareVersions(widget, since) >= 0) return null;
  return (
    `${m[1]}() exists since widget ${since}, so this player is an OLDER widget (${widget ? `version ${widget}` : "too old to report its version"}) ` +
    "that its host cached. Open a new player with play-live-pattern (session: true to keep jamming); the host then loads the current widget."
  );
}

/**
 * The newest update was answered by a STOPPED player. That was true when it
 * arrived; say what is true now. Once a fresh check-in after that answer says
 * "playing", Play has started it since (claude.ai field test, 2026-10-03: the
 * header read "playing, around cycle 12.8" over "rev 1 … is stopped").
 */
function describeLoadedStopped(
  data: SessionData,
  applied: Extract<SessionEvent, { t: "applied" }>,
  now: number,
): string {
  const hb = data.heartbeat;
  const playingSince =
    hb !== null && hb.state === "playing" && hb.at > applied.at && now - hb.at <= SESSION_HEARTBEAT_LATE_MS;
  if (!playingSince) return `Your latest update (rev ${applied.rev}) ${LOADED_STOPPED}.`;
  const editedSince = data.events.some((e) => e.t === "edit" && e.at > applied.at);
  return (
    `Your latest update (rev ${applied.rev}) arrived while the player was stopped; Play has started it since` +
    (editedSince ? ", and the human has run their own edit since (below)." : " — it is what is playing now.")
  );
}

export function describeSession(data: SessionData, now: number, since = data.readSeq, serviceVersion?: string): string {
  const lines: string[] = [];
  if (typeof data.endedAt === "number") {
    const left = Math.max(1, Math.round((data.endedAt + SESSION_ENDED_TTL_MS - now) / 60_000));
    lines.push(
      `The listener ENDED this session ${ago(now - data.endedAt)}` +
        (data.endedCycle != null ? ` (at cycle ${cyc(data.endedCycle)})` : "") +
        ". The player keeps playing its last pattern on its own, but the session is closed: update-session can no longer " +
        `reach it, and this log is deleted in about ${left} min. To play on together, open a new one with play-live-pattern(session: true).`,
    );
  }
  const joins = data.events.filter((e): e is Extract<SessionEvent, { t: "joined" }> => e.t === "joined");
  const hb = data.heartbeat;
  const join = joins[joins.length - 1];

  if (!join && !hb) {
    lines.push(
      `Session ${data.id}: no player has joined yet (created ${ago(now - data.created)}). ` +
        "A widget joins when it renders; a host that shows no widgets (a terminal client) never will, " +
        "and on a phone the widget may not render until the user scrolls to it.",
    );
  } else {
    const where = join
      ? [join.host, join.platform].filter(Boolean).join(" · ") || "a widget"
      : "a widget";
    const caps = join?.caps?.length ? ` (host offers: ${join.caps.join(", ")})` : "";
    const heard = hb ? `last checked in ${ago(now - hb.at)}` : "has not checked in since";
    const stale = hb && now - hb.at > SESSION_WIDGET_STALE_MS;
    const est = estimatedCycle(hb, now);
    const late = hb && !stale && hb.state === "playing" && now - hb.at > SESSION_HEARTBEAT_LATE_MS;
    const state = hb
      ? stale
        ? ` — it may be closed, scrolled away or the app backgrounded (last state: ${hb.state})`
        : late
          ? ` — last reported playing ${ago(now - hb.at)}${hb.cycle !== null ? ` (at cycle ${cyc(hb.cycle)})` : ""}, ` +
            "and a live player checks in every ~20 s, so it is probably suspended or stopped now " +
            "(on a phone: the app in the background or the screen locked)"
          : ` — ${hb.state}${est !== null ? `, around cycle ${cyc(est)}` : ""}${hb.cps ? ` at cps ${Math.round(hb.cps * 1000) / 1000}` : ""}`
      : "";
    const widget = join?.widget ?? null;
    const build = widget
      ? ` (widget ${widget}${serviceVersion ? `, service ${serviceVersion}` : ""})`
      : serviceVersion
        ? ` (widget older than 0.10.1 — it does not report its version; service ${serviceVersion})`
        : "";
    lines.push(`Session ${data.id}: player on ${where}${caps}${build}, joined ${join ? ago(now - join.at) : "?"}, ${heard}${state}.`);
    if (serviceVersion && (!widget || compareVersions(widget, serviceVersion) < 0)) {
      lines.push(
        "The player is an OLDER widget than this service (its host cached it): functions added since, like tilt() or mic(), " +
          "may be missing there. If that bites, open a new player with play-live-pattern(session: true).",
      );
    }
  }

  if (data.pattern) {
    const applied = data.lastApplied?.rev === data.pattern.rev ? data.lastApplied : null;
    lines.push(
      applied
        ? applied.ok
          ? applied.cycle === null
            ? describeLoadedStopped(data, applied, now)
            : `Your latest update (rev ${applied.rev}) applied at cycle ${cyc(applied.cycle)}.`
          : `Your latest update (rev ${applied.rev}) FAILED in the widget: ${applied.error ?? "unknown error"} — the previous pattern kept playing.`
        : (() => {
            const sched = [...data.events]
              .reverse()
              .find((e): e is Extract<SessionEvent, { t: "scheduled" }> => e.t === "scheduled" && e.rev === data.pattern!.rev);
            return sched
              ? `Your latest update (rev ${data.pattern.rev}) is scheduled by the player for cycle ${cyc(sched.boundary)} and not applied yet.`
              : `Your latest update (rev ${data.pattern.rev}) is queued and not applied yet.`;
          })(),
    );
  }

  // The strip as it stands: the last snapshot, moved by every control event since.
  let snapshotAt = -1;
  for (let i = data.events.length - 1; i >= 0; i--) {
    if (data.events[i].t === "controls") {
      snapshotAt = i;
      break;
    }
  }
  if (snapshotAt >= 0) {
    const snap = data.events[snapshotAt] as Extract<SessionEvent, { t: "controls" }>;
    const now = new Map(snap.list.map((c) => [c.name, { ...c }]));
    for (const e of data.events.slice(snapshotAt + 1)) {
      if (e.t === "control" && now.has(e.name)) now.get(e.name)!.value = e.value;
    }
    if (now.size) {
      lines.push(
        "Controls on the player now: " +
          [...now.values()]
            .map((c) =>
              c.sensor
                ? `${c.name} (${c.sensor === "tilt" ? "tilt: x left→right, y" : "mic loudness 0–1"}) ${showValue(c.value)}, ` +
                  (c.source === "sensor" ? "played by the device" : "played by hand — the sensor isn't available")
                : c.kind === "pad"
                  ? `${c.name} (pad) ${c.value === 1 ? "on" : "off"}`
                  : c.kind === "fader"
                    ? `${c.name} (fader ${c.min ?? 0}–${c.max ?? 1}) ${showValue(c.value)}`
                    : `${c.name} (xy) ${showValue(c.value)}`,
            )
            .join("; ") +
          ". Read them in code with fader('name') / pad('name') / xy('name') / tilt() / mic() — same names keep their values across updates.",
      );
    }
  }

  const fresh = data.events.filter((e) => e.seq > since);
  if (!fresh.length) {
    lines.push("Nothing new since your last read.");
    return lines.join("\n");
  }
  lines.push(since > 0 ? "Since your last read:" : "Log:");

  // Walk in order, folding runs of taps — and of moves on one control — into one line.
  let taps: Array<Extract<SessionEvent, { t: "tap" }>> = [];
  let moves: Array<Extract<SessionEvent, { t: "control" }>> = [];
  const flushMoves = () => {
    if (!moves.length) return;
    const first = moves[0];
    const last = moves[moves.length - 1];
    const span =
      first.cycle === last.cycle || first.cycle === null || last.cycle === null
        ? atCycle(last.cycle)
        : `cycles ${cyc(first.cycle)}–${cyc(last.cycle)}`;
    if (first.kind === "pad") {
      const presses = moves.filter((m) => m.value === 1);
      lines.push(
        `- the human pressed pad '${first.name}' ${presses.length} time${presses.length === 1 ? "" : "s"} ` +
          `(${presses.every((m) => m.cycle !== null) && presses.length ? presses.map((m) => cyc(m.cycle)).join(", ") : span}); now ${last.value === 1 ? "on" : "off"}.`,
      );
    } else {
      const who = first.source === "sensor" ? "the device moved" : "the human moved";
      lines.push(`- ${who} ${first.kind} '${first.name}' ${moves.length === 1 ? "to" : `${moves.length} times, ending at`} ${showValue(last.value)} (${span}).`);
    }
    moves = [];
  };
  const flushTaps = () => {
    flushMoves();
    if (taps.length) lines.push(`- ${describeTaps(taps)}`);
    taps = [];
  };
  const reports = new Set<string>();
  const editsWithCode = fresh.filter((e) => e.t === "edit" && e.code !== null);
  const lastEdit = editsWithCode[editsWithCode.length - 1];
  for (const e of fresh) {
    if (e.t === "tap") {
      flushMoves();
      taps.push(e);
      continue;
    }
    if (e.t === "control") {
      if (taps.length) flushTaps();
      if (moves.length && moves[0].name !== e.name) flushMoves();
      moves.push(e);
      continue;
    }
    if (e.t === "controls") continue;
    flushTaps();
    switch (e.t) {
      case "joined":
        lines.push(`- a player joined (${[e.host, e.platform].filter(Boolean).join(" · ") || "unknown host"}).`);
        break;
      case "report":
        // The widget repeats itself across re-renders; one line per distinct report.
        if (reports.has(e.text)) break;
        reports.add(e.text);
        lines.push(`- widget report: ${e.text}`);
        break;
      case "update":
        lines.push(
          `- you queued rev ${e.rev}` + (e.quantize ? ` for the next multiple of ${e.quantize} cycle${e.quantize === 1 ? "" : "s"}.` : " to apply now."),
        );
        break;
      case "applied":
        lines.push(
          e.ok
            ? e.cycle === null
              ? `- rev ${e.rev} ${ARRIVED_STOPPED}${e.report ? ` (${e.report})` : "."}`
              : `- rev ${e.rev} applied at cycle ${cyc(e.cycle)}${e.report ? `: ${e.report}` : "."}`
            : `- rev ${e.rev} failed: ${e.error ?? "unknown error"} (the previous pattern kept playing).`,
        );
        break;
      case "edit":
        lines.push(
          `- ${atCycle(e.cycle)}: the human edited the code and ran it (${e.chars} chars)` +
            (e === lastEdit ? " — their version is below." : e.code === null ? " (text no longer kept)." : "."),
        );
        break;
      case "pass":
        lines.push(`- ${atCycle(e.cycle)}: the human passed the turn to you.`);
        break;
      case "scheduled":
        lines.push(`- the player scheduled rev ${e.rev} for cycle ${cyc(e.boundary)}.`);
        break;
      case "ended":
        lines.push(`- ${atCycle(e.cycle)}: the listener ended the session.`);
        break;
    }
  }
  flushTaps();
  // An error naming a function this (cached, older) widget lacks: say why.
  const widget = widgetVersion(data);
  for (const e of fresh) {
    const err = e.t === "applied" ? e.error : e.t === "report" ? e.text : null;
    const hint = staleWidgetHint(err, widget);
    if (hint) {
      lines.push(hint);
      break;
    }
  }
  if (lastEdit && lastEdit.t === "edit" && lastEdit.code) {
    lines.push("", "The human's code as they last ran it:", "```js", lastEdit.code, "```");
  }
  return lines.join("\n");
}
