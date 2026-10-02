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
//
// Plain fetch() + HTTPS long-polling rather than WebSockets on purpose: the
// widget's CSP connect-src is proven to reach this origin over https (say()
// clips, 2026-10-02 on iPhone), wss is not.
//
// A session exists only after `init` (minted by play-live-pattern or
// POST /session/new): every other request to an unknown id answers 404 and
// writes nothing, so guessing ids cannot create storage. An alarm deletes
// everything after SESSION_IDLE_TTL_MS without activity.
//
// A plain class (no `cloudflare:workers` import) so tests drive it with a fake
// state; workerd accepts it as a Durable Object class all the same.
// =============================================================================

import {
  appendEvents,
  coerceEvents,
  describeSession,
  estimatedCycle,
  newSession,
  nextBoundary,
  queuePattern,
  recordHeartbeat,
  SESSION_ID_RE,
  SESSION_IDLE_TTL_MS,
  SESSION_MAX_CODE_CHARS,
  SESSION_SWAP_LEAD_S,
  type QueuedPattern,
  type SessionData,
  type SessionEvent,
} from "../../src/shared/session.js";
import type { SessionUpdateOutcome } from "../../src/shared/session-tools.js";

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

export const POLL_WAIT_MS = 20_000;
/** Polls a session holds open at once; an older one is answered 204 to make room. */
export const MAX_POLL_WAITERS = 4;
export const ACK_WAIT_MS = 9_000;
export const EVENTS_MAX_BYTES = 256 * 1024;
export const UPDATE_MAX_BYTES = SESSION_MAX_CODE_CHARS * 4 + 1024;

type Applied = Extract<SessionEvent, { t: "applied" }>;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
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
    const due = this.data.lastActivity + SESSION_IDLE_TTL_MS;
    const alarm = await this.state.storage.getAlarm();
    if (alarm === null || alarm < due - 60_000) await this.state.storage.setAlarm(due);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const op = url.pathname.split("/").pop();
    const now = this.now();

    if (op === "init" && request.method === "POST") {
      const id = url.searchParams.get("id") ?? "";
      if (!SESSION_ID_RE.test(id)) return json({ error: "bad id" }, 400);
      if (!(await this.load())) {
        this.data = newSession(id, now);
        await this.save();
      }
      return json({ id });
    }

    const data = await this.load();
    if (!data) return json({ error: "unknown session" }, 404);

    if (op === "events" && request.method === "POST") {
      let raw: unknown;
      try {
        raw = await readJson(request, EVENTS_MAX_BYTES);
      } catch {
        return json({ error: "bad body" }, 400);
      }
      const events = (raw as { events?: unknown } | null)?.events;
      const added = appendEvents(data, coerceEvents(events), now);
      for (const e of added) {
        if (e.t !== "applied") continue;
        const waiters = this.ackWaiters.get(e.rev);
        this.ackWaiters.delete(e.rev);
        waiters?.forEach((w) => w(e));
      }
      await this.save();
      return json({ ok: true, seq: data.seq });
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
      if (data.pattern && data.pattern.rev > after) return json(data.pattern);
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
      return pattern ? json(pattern) : new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }

    if (op === "state" && request.method === "GET") {
      const since = data.readSeq;
      const text = describeSession(data, now, since);
      if (url.searchParams.get("peek") !== "1") data.readSeq = data.seq;
      data.lastActivity = now;
      await this.save();
      return json({ text, seq: data.seq });
    }

    if (op === "update" && request.method === "POST") {
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
        estCycle === null ? null : nextBoundary(estCycle, pattern.quantize, SESSION_SWAP_LEAD_S * (hb?.cps ?? 0.5));
      let applied: Applied | null = null;
      // Only wait for a player that is actually there.
      if (widgetSeenMsAgo !== null && widgetSeenMsAgo <= 60_000) {
        applied = await this.waitFor<Applied>((resolve) => {
          const list = this.ackWaiters.get(pattern.rev) ?? [];
          list.push(resolve);
          this.ackWaiters.set(pattern.rev, list);
          return () => {
            const rest = (this.ackWaiters.get(pattern.rev) ?? []).filter((w) => w !== resolve);
            if (rest.length) this.ackWaiters.set(pattern.rev, rest);
            else this.ackWaiters.delete(pattern.rev);
          };
        }, ACK_WAIT_MS, request.signal);
      }
      const outcome: SessionUpdateOutcome = {
        pattern: { ...pattern, code: "" },
        applied,
        widgetSeenMsAgo,
        estCycle,
        boundary,
        cps: hb?.cps ?? null,
      };
      return json(outcome);
    }

    return json({ error: "not found" }, 404);
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
    const due = data.lastActivity + SESSION_IDLE_TTL_MS;
    if (this.now() >= due) {
      await this.state.storage.deleteAll();
      this.data = null;
      return;
    }
    await this.state.storage.setAlarm(due);
  }
}
