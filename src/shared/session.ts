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
/** A widget that has not polled for this long is probably gone. */
export const SESSION_WIDGET_STALE_MS = 60_000;
/** Events kept per session (oldest dropped first). */
export const SESSION_MAX_EVENTS = 400;
/** Code edits whose full text is kept (older ones keep only their size). */
export const SESSION_MAX_EDIT_BODIES = 3;
export const SESSION_MAX_CODE_CHARS = 64 * 1024;
export const SESSION_MAX_TEXT_CHARS = 2000;
/** Quantize to at most this many cycles ahead. */
export const SESSION_MAX_QUANTIZE = 32;

export type SessionEvent =
  | { seq: number; at: number; t: "joined"; host?: string; platform?: string; caps?: string[] }
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
  | { seq: number; at: number; t: "control"; name: string; kind: string; value: number | [number, number]; cycle: number | null }
  | { seq: number; at: number; t: "controls"; list: ControlState[] }
  | { seq: number; at: number; t: "update"; rev: number; quantize: number };

/** One control on the player's strip, as the model sees it. */
export interface ControlState {
  name: string;
  kind: string;
  value: number | [number, number];
  min?: number;
  max?: number;
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
}

export function newSession(id: string, now: number): SessionData {
  return {
    id,
    created: now,
    lastActivity: now,
    seq: 0,
    readSeq: 0,
    events: [],
    rev: 0,
    pattern: null,
    heartbeat: null,
  };
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
        });
        break;
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
        if (name && value !== null) out.push({ t: "control", name, kind: text(e.kind, 8) ?? "?", value, cycle: finite(e.cycle) });
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
  if (added.length) data.lastActivity = now;
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
export function describeSession(data: SessionData, now: number, since = data.readSeq): string {
  const lines: string[] = [];
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
    const state = hb
      ? stale
        ? ` — it may be closed, scrolled away or the app backgrounded (last state: ${hb.state})`
        : ` — ${hb.state}${est !== null ? `, around cycle ${cyc(est)}` : ""}${hb.cps ? ` at cps ${Math.round(hb.cps * 1000) / 1000}` : ""}`
      : "";
    lines.push(`Session ${data.id}: player on ${where}${caps}, joined ${join ? ago(now - join.at) : "?"}, ${heard}${state}.`);
  }

  if (data.pattern) {
    const applied = [...data.events]
      .reverse()
      .find((e): e is Extract<SessionEvent, { t: "applied" }> => e.t === "applied" && e.rev === data.pattern!.rev);
    lines.push(
      applied
        ? applied.ok
          ? `Your latest update (rev ${applied.rev}) applied at cycle ${cyc(applied.cycle)}.`
          : `Your latest update (rev ${applied.rev}) FAILED in the widget: ${applied.error ?? "unknown error"} — the previous pattern kept playing.`
        : `Your latest update (rev ${data.pattern.rev}) is queued and not applied yet.`,
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
              c.kind === "pad"
                ? `${c.name} (pad) ${c.value === 1 ? "on" : "off"}`
                : c.kind === "fader"
                  ? `${c.name} (fader ${c.min ?? 0}–${c.max ?? 1}) ${showValue(c.value)}`
                  : `${c.name} (xy) ${showValue(c.value)}`,
            )
            .join("; ") +
          ". Read them in code with fader('name') / pad('name') / xy('name') — same names keep their values across updates.",
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
    const span = first.cycle === last.cycle ? `cycle ${cyc(first.cycle)}` : `cycles ${cyc(first.cycle)}–${cyc(last.cycle)}`;
    if (first.kind === "pad") {
      const presses = moves.filter((m) => m.value === 1);
      lines.push(
        `- the human pressed pad '${first.name}' ${presses.length} time${presses.length === 1 ? "" : "s"} ` +
          `(${presses.map((m) => cyc(m.cycle)).join(", ") || span}); now ${last.value === 1 ? "on" : "off"}.`,
      );
    } else {
      lines.push(`- the human moved ${first.kind} '${first.name}' ${moves.length === 1 ? "to" : `${moves.length} times, ending at`} ${showValue(last.value)} (${span}).`);
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
            ? `- rev ${e.rev} applied at cycle ${cyc(e.cycle)}${e.report ? `: ${e.report}` : "."}`
            : `- rev ${e.rev} failed: ${e.error ?? "unknown error"} (the previous pattern kept playing).`,
        );
        break;
      case "edit":
        lines.push(
          `- cycle ${cyc(e.cycle)}: the human edited the code and ran it (${e.chars} chars)` +
            (e === lastEdit ? " — their version is below." : e.code === null ? " (text no longer kept)." : "."),
        );
        break;
      case "pass":
        lines.push(`- cycle ${cyc(e.cycle)}: the human passed the turn to you.`);
        break;
    }
  }
  flushTaps();
  if (lastEdit && lastEdit.t === "edit" && lastEdit.code) {
    lines.push("", "The human's code as they last ran it:", "```js", lastEdit.code, "```");
  }
  return lines.join("\n");
}
