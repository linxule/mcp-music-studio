// =============================================================================
// JamSession — the Durable Object behind a live session (src/shared/session.ts)
//
// One object per session id. It holds the event log, the model's queued
// pattern and the widget's last check-in, and it is where the two sides meet:
//
//   widget  POST events  → reports, taps, edits, "applied", "pass"
//   widget  GET  next    → long-poll (≤ 20 s) for a pattern newer than it has;
//                          the query carries its clock, so a poll IS a heartbeat
//   model   GET  state   → describeSession(), advancing the read mark
//   model   POST update  → queue a pattern, wake the poll, and wait (≤ 9 s) for
//                          the widget's "applied" so the tool result can say
//                          whether it ran
//   widget  POST end     → the listener closed the session (End session): wake
//                          every listener, fail waiting updates, answer later
//                          polls/events 410, delete everything 10 min later
//
// Plain fetch() + HTTPS long-polling rather than WebSockets on purpose: the
// widget's CSP connect-src is proven to reach this origin over https (say()
// clips, 2026-10-02 on iPhone), wss is not.
//
// A session exists only after `init` (minted by play-live-pattern or
// POST /session/new): every other request to an unknown id answers 404 and
// writes nothing, so guessing ids cannot create storage. An alarm deletes
// everything after SESSION_IDLE_TTL_MS without activity (SESSION_ENDED_TTL_MS
// after an end).
//
// A plain class (no `cloudflare:workers` import) so tests drive it with a fake
// state; workerd accepts it as a Durable Object class all the same.
// =============================================================================

import {
  ingestWidgetBatch,
  describeSession,
  endSession,
  estimatedCycle,
  newSession,
  nextBoundary,
  queuePattern,
  recordHeartbeat,
  SESSION_ID_RE,
  sessionExpiresAt,
  widgetVersion,
  SESSION_MAX_CODE_CHARS,
  SESSION_SWAP_LEAD_S,
  SESSION_POLL_WAIT_MS,
  isHumanEvent,
  LISTEN_DEFAULT_MS,
  LISTEN_MAX_MS,
  LISTEN_SETTLE_MS,
  type ListenMode,
  type QueuedPattern,
  type SessionData,
  type SessionEvent,
} from "../../src/shared/session.js";
import type { SessionUpdateOutcome } from "../../src/shared/session-tools.js";
import { VERSION } from "../../src/version.js";

export interface SessionStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  deleteAll(): Promise<void>;
  setAlarm(time: number): Promise<void>;
  getAlarm(): Promise<number | null>;
}

export interface SessionState {
  storage: SessionStorage;
}

export const POLL_WAIT_MS = SESSION_POLL_WAIT_MS;
/** get-session(wait) calls one session holds at once. */
export const MAX_LISTENERS = 2;
/**
 * A stopped player answers "loaded, not playing" (cycle null). When a second
 * screen joins a session, a stopped page must not win the race against the
 * player that is actually playing: its answer waits this long for a better one.
 */
export const STOPPED_ACK_GRACE_MS = 1500;
/** Polls a session holds open at once; an older one is answered 204 to make room. */
export const MAX_POLL_WAITERS = 4;
export const ACK_WAIT_MS = 9_000;
export const EVENTS_MAX_BYTES = 256 * 1024;
export const UPDATE_MAX_BYTES = SESSION_MAX_CODE_CHARS * 4 + 1024;

type Applied = Extract<SessionEvent, { t: "applied" }>;
type Scheduled = Extract<SessionEvent, { t: "scheduled" }>;
/**
 * When nobody answered, the server's own guess at the landing bar errs LATE:
 * the player hears the update a poll round-trip later and decides with its
 * own (audible) clock, so add this much on top of the swap lead.
 */
export const SERVER_ETA_MARGIN_S = 1.5;
type WakeReason = "pass" | "activity" | "ended";

const json = (body: unknown, status = 200, listening?: boolean): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(listening === undefined ? {} : { "x-session-listening": listening ? "1" : "0" }),
    },
  });

async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new Error("too large");
  const body = await request.text();
  if (body.length > maxBytes) throw new Error("too large");
  return body ? JSON.parse(body) : null;
}

export class JamSession {
  private data: SessionData | null | undefined = undefined;
  private pollWaiters = new Set<(p: QueuedPattern | null) => void>();
  private ackWaiters = new Map<number, Array<(e: Applied) => void>>();
  /** update-session calls waiting to hear which bar the player picked. */
  private schedWaiters = new Map<number, Array<(e: Scheduled) => void>>();
  /** get-session(wait) calls holding for the listener. */
  private listeners = new Set<{ mode: ListenMode; wake: (why: WakeReason) => void }>();

  /** Is the model waiting for the listener right now? (The widget's Pass skips the chat then.) */
  private get listening(): boolean {
    return this.listeners.size > 0;
  }

  /** Release held polls so the widget hears a change in `listening` now, not in 20 s. */
  private releasePolls(): void {
    this.pollWaiters.forEach((w) => w(null));
    this.pollWaiters.clear();
  }

  constructor(
    private readonly state: SessionState,
    _env?: unknown,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  private async load(): Promise<SessionData | null> {
    if (this.data === undefined) this.data = (await this.state.storage.get<SessionData>("data")) ?? null;
    return this.data;
  }

  private persistedAt = 0;

  private async save(): Promise<void> {
    if (!this.data) return;
    this.persistedAt = this.now();
    await this.state.storage.put("data", this.data);
    const due = sessionExpiresAt(this.data);
    const alarm = await this.state.storage.getAlarm();
    // An end moves the deadline EARLIER (10 min), so re-arm in both directions.
    if (alarm === null || alarm < due - 60_000 || alarm > due + 60_000) await this.state.storage.setAlarm(due);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const op = url.pathname.split("/").pop();
    const now = this.now();

    if (op === "init" && request.method === "POST") {
      const id = url.searchParams.get("id") ?? "";
      if (!SESSION_ID_RE.test(id)) return json({ error: "bad id" }, 400);
      if (!(await this.load())) {
        let seed: string | undefined;
        try {
          const body = (await readJson(request, UPDATE_MAX_BYTES)) as { seed?: unknown } | null;
          if (typeof body?.seed === "string") seed = body.seed;
        } catch { /* no seed */ }
        this.data = newSession(id, now, seed);
        await this.save();
      }
      return json({ id });
    }

    const data = await this.load();
    if (!data) return json({ error: "unknown session" }, 404);
    const ended = typeof data.endedAt === "number";

    if (op === "end" && request.method === "POST") {
      let cycle: unknown = null;
      try {
        cycle = ((await readJson(request, 4096)) as { cycle?: unknown } | null)?.cycle ?? null;
      } catch { /* an end without a cycle */ }
      if (!endSession(data, cycle, now)) return json({ ok: true, ended: true, already: true });
      // Everyone waiting hears it now, not at their deadline.
      for (const listener of [...this.listeners]) listener.wake("ended");
      this.schedWaiters.clear();
      for (const [rev, waiters] of [...this.ackWaiters]) {
        this.ackWaiters.delete(rev);
        const failed: Applied = { seq: 0, at: now, t: "applied", rev, ok: false, cycle: null, error: "the listener ended the session" };
        waiters.forEach((w) => w(failed));
      }
      this.releasePolls();
      await this.save();
      return json({ ok: true, ended: true });
    }

    // Closed: the players (and any second screen) stop; nothing more is logged.
    if (ended && (op === "events" || op === "next" || op === "current")) {
      return json({ error: "session ended" }, 410);
    }

    if (op === "events" && request.method === "POST") {
      let raw: unknown;
      try {
        raw = await readJson(request, EVENTS_MAX_BYTES);
      } catch {
        return json({ error: "bad body" }, 400);
      }
      const events = (raw as { events?: unknown } | null)?.events;
      // Remembered state replaces its field (never the log); the rest are ring events.
      const added = ingestWidgetBatch(data, events, now);
      // Asked before waking anyone: was a model there to hear this?
      const heard = this.listening;
      for (const listener of [...this.listeners]) {
        if (added.some((e) => e.t === "pass")) listener.wake("pass");
        else if (listener.mode === "activity" && added.some(isHumanEvent)) listener.wake("activity");
      }
      for (const e of added) {
        if (e.t === "scheduled") {
          const waiters = this.schedWaiters.get(e.rev);
          waiters?.forEach((w) => w(e));
          continue;
        }
        if (e.t !== "applied") continue;
        if (e.ok && e.cycle === null) {
          // A stopped player's answer: give a playing one a moment to beat it.
          void this.sleep(STOPPED_ACK_GRACE_MS).then(() => this.resolveAck(e));
          continue;
        }
        this.resolveAck(e);
      }
      await this.save();
      // A Pass that a listening model will read needs no chat message.
      return json({ ok: true, seq: data.seq, listening: heard });
    }

    if (op === "next" && request.method === "GET") {
      const after = Number(url.searchParams.get("after") ?? "0");
      const num = (k: string) => {
        const v = url.searchParams.get(k);
        const n = v === null ? NaN : Number(v);
        return Number.isFinite(n) ? n : null;
      };
      const previous = data.heartbeat;
      recordHeartbeat(
        data,
        { cycle: num("cycle"), cps: num("cps"), state: (url.searchParams.get("state") ?? "unknown").slice(0, 24) },
        now,
      );
      // Every poll is a heartbeat, but not every one needs a storage write:
      // the object stays in memory while polls arrive. Persist a change of
      // state, or once a minute.
      if (!previous || previous.state !== data.heartbeat!.state || now - this.persistedAt > 60_000) await this.save();
      if (data.pattern && data.pattern.rev > after) return json(data.pattern, 200, this.listening);
      const wait = Math.min(POLL_WAIT_MS, Math.max(0, Number(url.searchParams.get("wait") ?? POLL_WAIT_MS) || 0));
      // Bounded: an id-holder opening many polls can't pile up held requests
      // (Codex review). The oldest is released empty; a real widget re-polls.
      while (this.pollWaiters.size >= MAX_POLL_WAITERS) {
        const oldest = this.pollWaiters.values().next().value!;
        this.pollWaiters.delete(oldest);
        oldest(null);
      }
      const pattern = await this.waitFor<QueuedPattern | null>((resolve) => {
        this.pollWaiters.add(resolve);
        return () => this.pollWaiters.delete(resolve);
      }, wait, request.signal);
      if (typeof data.endedAt === "number") return json({ error: "session ended" }, 410);
      return pattern
        ? json(pattern, 200, this.listening)
        : new Response(null, { status: 204, headers: { "cache-control": "no-store", "x-session-listening": this.listening ? "1" : "0" } });
    }

    // Read-only: the pattern a newly joining page should load — the model's
    // newest update, or else the code the human last ran. Writes nothing.
    if (op === "current" && request.method === "GET") {
      const edit = [...data.events]
        .reverse()
        .find((e): e is Extract<SessionEvent, { t: "edit" }> => e.t === "edit" && e.code !== null);
      const fromUpdate = data.pattern ? { code: data.pattern.code, at: data.pattern.at, source: "update" } : null;
      const fromEdit = edit?.code ? { code: edit.code, at: edit.at, source: "edit" } : null;
      const pick = fromUpdate && fromEdit ? (fromEdit.at > fromUpdate.at ? fromEdit : fromUpdate) : fromUpdate ?? fromEdit;
      if (pick) return json({ ...pick, rev: data.pattern?.rev ?? 0 });
      // Nothing sent or edited yet: the piece the session opened with.
      if (data.seed) return json({ code: data.seed, at: data.created, source: "seed", rev: 0 });
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }

    if (op === "state" && request.method === "GET") {
      const mode = url.searchParams.get("wait");
      if ((mode === "pass" || mode === "activity") && !ended) {
        const fresh = data.events.filter((e) => e.seq > data.readSeq);
        const ready = mode === "pass" ? fresh.some((e) => e.t === "pass") : fresh.some(isHumanEvent);
        if (!ready && this.listeners.size >= MAX_LISTENERS) {
          // Only the model listens; a pile of held reads is an id-holder's
          // flood (Kimi review). Answer at once instead.
        } else if (!ready) {
          const timeout = Math.min(LISTEN_MAX_MS, Math.max(1000, Number(url.searchParams.get("timeout")) || LISTEN_DEFAULT_MS));
          const why = await this.listen(mode, timeout, request.signal);
          // The caller went away (a cancelled tool call): leave the events
          // unread for the next read (Codex + Kimi review).
          if (request.signal?.aborted) return json({ error: "cancelled" }, 499);
          const after = (await this.load()) ?? null;
          if (!after) return json({ error: "unknown session" }, 404);
          const head =
            why === "ended"
              ? "The listener ended the session.\n"
              : why === null
                ? `Still listening — the listener did nothing ${mode === "pass" ? "that passes the turn " : ""}for ${Math.round(timeout / 1000)} s. ` +
                  "Call get-session with wait again to keep listening, or update-session to play something.\n"
                : why === "pass"
                  ? "The listener passed the turn to you.\n"
                  : "The listener is playing:\n";
          const text = head + describeSession(after, this.now(), after.readSeq, VERSION);
          after.readSeq = after.seq;
          after.lastActivity = this.now();
          await this.save();
          return json({ text, seq: after.seq });
        }
      }
      const since = data.readSeq;
      const text = describeSession(data, now, since, VERSION);
      if (url.searchParams.get("peek") !== "1") data.readSeq = data.seq;
      data.lastActivity = now;
      await this.save();
      return json({ text, seq: data.seq });
    }

    if (op === "update" && request.method === "POST") {
      if (ended) return json({ error: "session ended" }, 410);
      let raw: { code?: unknown; quantize?: unknown } | null;
      try {
        raw = (await readJson(request, UPDATE_MAX_BYTES)) as typeof raw;
      } catch {
        return json({ error: "bad body" }, 400);
      }
      if (!raw || typeof raw.code !== "string" || !raw.code.trim()) return json({ error: "no code" }, 400);
      const pattern = queuePattern(data, raw.code, Number(raw.quantize ?? 1), now);
      await this.save();
      // An older update still waiting for its answer never will: the widget
      // only ever applies the newest. Say so instead of "not confirmed yet".
      for (const [rev, waiters] of [...this.ackWaiters]) {
        if (rev >= pattern.rev) continue;
        this.ackWaiters.delete(rev);
        const replaced: Applied = {
          seq: 0,
          at: now,
          t: "applied",
          rev,
          ok: false,
          cycle: null,
          error: `replaced by your next update (rev ${pattern.rev}) before it played`,
        };
        waiters.forEach((w) => w(replaced));
      }
      this.pollWaiters.forEach((w) => w(pattern));
      this.pollWaiters.clear();

      const hb = data.heartbeat;
      const widgetSeenMsAgo = hb ? now - hb.at : null;
      const estCycle = estimatedCycle(hb, now);
      const boundary =
        estCycle === null
          ? null
          : nextBoundary(estCycle, pattern.quantize, (SESSION_SWAP_LEAD_S + SERVER_ETA_MARGIN_S) * (hb?.cps ?? 0.5));
      let applied: Applied | null = null;
      let scheduled: Scheduled | null = null;
      // Only wait for a player that is actually there.
      if (widgetSeenMsAgo !== null && widgetSeenMsAgo <= 60_000) {
        const deadline = now + ACK_WAIT_MS;
        const answer = await this.waitFor<Applied | Scheduled>((resolve) => {
          const list = this.ackWaiters.get(pattern.rev) ?? [];
          list.push(resolve);
          this.ackWaiters.set(pattern.rev, list);
          // The player says which bar it picked: if that bar comes before our
          // deadline, keep waiting for "applied"; if not, answer with it now.
          const onScheduled = (e: Scheduled) => {
            scheduled = e;
            const cps = data.heartbeat?.cps ?? null;
            const est = estimatedCycle(data.heartbeat, this.now());
            const etaMs = cps && est !== null ? ((e.boundary - est) / cps) * 1000 : Infinity;
            if (this.now() + etaMs + 1000 > deadline) resolve(e);
          };
          const sched = this.schedWaiters.get(pattern.rev) ?? [];
          sched.push(onScheduled);
          this.schedWaiters.set(pattern.rev, sched);
          return () => {
            const rest = (this.ackWaiters.get(pattern.rev) ?? []).filter((w) => w !== resolve);
            if (rest.length) this.ackWaiters.set(pattern.rev, rest);
            else this.ackWaiters.delete(pattern.rev);
            const restS = (this.schedWaiters.get(pattern.rev) ?? []).filter((w) => w !== onScheduled);
            if (restS.length) this.schedWaiters.set(pattern.rev, restS);
            else this.schedWaiters.delete(pattern.rev);
          };
        }, ACK_WAIT_MS, request.signal);
        if (answer?.t === "applied") applied = answer;
      }
      const outcome: SessionUpdateOutcome = {
        pattern: { ...pattern, code: "" },
        applied,
        widgetSeenMsAgo,
        widgetState: hb?.state ?? null,
        joins: data.events.filter((e) => e.t === "joined").length,
        estCycle,
        boundary,
        cps: hb?.cps ?? null,
        widget: widgetVersion(data),
        scheduled: scheduled ? { boundary: (scheduled as Scheduled).boundary } : null,
      };
      return json(outcome);
    }

    return json({ error: "not found" }, 404);
  }

  /** Hold until the listener passes (or, for "activity", plays a little), or `ms`. */
  private async listen(mode: ListenMode, ms: number, signal?: AbortSignal): Promise<WakeReason | null> {
    let settling = false;
    const result = await this.waitFor<WakeReason>((resolve) => {
      const listener = {
        mode,
        wake: (why: WakeReason) => {
          if (why === "pass" || why === "ended") return resolve(why);
          // Catch the whole phrase, not its first tap.
          if (!settling) {
            settling = true;
            void this.sleep(LISTEN_SETTLE_MS).then(() => resolve("activity"));
          }
        },
      };
      this.listeners.add(listener);
      this.releasePolls();
      return () => {
        this.listeners.delete(listener);
        this.releasePolls();
      };
    }, ms, signal);
    return result;
  }

  private resolveAck(e: Applied): void {
    const waiters = this.ackWaiters.get(e.rev);
    this.ackWaiters.delete(e.rev);
    waiters?.forEach((w) => w(e));
  }

  /**
   * Resolve with what `subscribe` delivers, or null after `ms` — or at once
   * when the caller goes away (an aborted poll must not hold its waiter until
   * the deadline; Codex review).
   */
  private async waitFor<T>(
    subscribe: (resolve: (v: T) => void) => () => void,
    ms: number,
    signal?: AbortSignal,
  ): Promise<T | null> {
    if (ms <= 0 || signal?.aborted) return null;
    let unsubscribe = () => {};
    let onAbort = () => {};
    const delivered = new Promise<T | null>((resolve) => {
      unsubscribe = subscribe(resolve);
      onAbort = () => resolve(null);
      signal?.addEventListener("abort", onAbort);
    });
    const result = await Promise.race([delivered, this.sleep(ms).then(() => null)]);
    unsubscribe();
    signal?.removeEventListener("abort", onAbort);
    return result;
  }

  async alarm(): Promise<void> {
    const data = await this.load();
    if (!data) return;
    const due = sessionExpiresAt(data);
    if (this.now() >= due) {
      await this.state.storage.deleteAll();
      this.data = null;
      return;
    }
    await this.state.storage.setAlarm(due);
  }
}
