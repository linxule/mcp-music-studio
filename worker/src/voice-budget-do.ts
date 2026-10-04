// =============================================================================
// VoiceBudget — the one Durable Object that holds the month's voice spend
//
// A single instance (idFromName("global")). A Durable Object handles one
// request at a time, so two cache misses can't both read "under budget" and
// both render — the race the old KV tripwire had (it also failed open when KV
// was down). Logic: src/shared/voice-budget.ts.
//
//   POST /reserve {chars, budgetMicro, key?} → {ok, reason?, ledger}
//   POST /refund  {chars, month, day, key?}  → {ledger}   (only from that period)
//   POST /done    x-line-key: <key>, body = the clip (empty: the render failed) → {}
//   POST /wait    {key}                      → 200 the clip | 204 none
//   GET  /status?budgetMicro=                → {ledger, budgetMicro, dayCapMicro}
//
// `key` is the line's cache key. While one caller renders a line, a second
// reserve for the same key answers "inflight" without charging: the tool-time
// prerender (from claude.ai's servers) and the player's GET /tts (from the
// user's browser) reach different isolates and usually different colos, so
// only this singleton sees both — and KV can't hand the clip over (a miss is
// cached per colo). The renderer posts the finished clip to /done; /wait holds
// the second caller until then (≤ WAIT_MS) and answers with those bytes. A
// finished clip is kept for INFLIGHT_TTL_MS, so a caller whose colo still
// reads a stale KV miss gets it here instead of paying again.
//
// All of it lives in memory only — an evicted object forgets it, which costs
// at worst a second render, never a stuck line — and every entry expires after
// INFLIGHT_TTL_MS even if /done never arrives.
//
// A plain class (no `cloudflare:workers` import), like JamSession, so tests
// drive it with a fake state.
// =============================================================================

import {
  AURA2_MICRO_USD_PER_CHAR,
  current,
  dayCapMicro,
  refund,
  reserve,
  type VoiceLedger,
} from "../../src/shared/voice-budget.js";
import { TTS_MAX_BYTES } from "../../src/shared/tts.js";

export interface BudgetState {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const chars = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 10_000 ? v : null;

const lineKey = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length <= 128 ? v : null);

/** Longest a line counts as being rendered without a /done (a render is ~1.5 s),
 *  and how long a finished clip is kept for late callers. */
export const INFLIGHT_TTL_MS = 15_000;
/** Longest /wait holds a caller (the widget waits ≤ 4 s for a line). */
export const WAIT_MS = 3_000;
/** Callers held per line; more get 204 and render it themselves. */
export const MAX_WAITERS_PER_KEY = 4;
/** Finished clips held in memory at once (~9 KB each); the oldest go first. */
export const HELD_BYTES_CAP = 2 * 1024 * 1024;

type Waiter = (clip: Uint8Array | null) => void;

export class VoiceBudget {
  private ledger: VoiceLedger | undefined;
  /** One shared first read: concurrent requests must not each reload storage
   *  and overwrite a reservation another made in between. */
  private loading: Promise<void> | undefined;
  /** Lines being rendered right now: cache key → expiry (ms). Memory only. */
  private readonly inflight = new Map<string, number>();
  /** Lines just rendered: cache key → the clip, until expiry. Oldest first. */
  private readonly finished = new Map<string, { bytes: Uint8Array; until: number }>();
  private heldBytes = 0;
  /** Callers held by /wait, per key. */
  private readonly waiters = new Map<string, Waiter[]>();

  constructor(
    private readonly state: BudgetState,
    _env?: unknown,
    private readonly now: () => Date = () => new Date(),
    private readonly waitMs = WAIT_MS,
  ) {}

  private load(): Promise<void> {
    this.loading ??= this.state.storage.get<VoiceLedger>("ledger").then((stored) => {
      this.ledger = stored;
    });
    return this.loading;
  }

  // The in-memory ledger changes synchronously, before the write is awaited,
  // so the next request already sees this reservation.
  private async save(ledger: VoiceLedger): Promise<void> {
    this.ledger = ledger;
    await this.state.storage.put("ledger", ledger);
  }

  private prune(nowMs: number): void {
    for (const [k, until] of this.inflight) if (until <= nowMs) this.inflight.delete(k);
    for (const [k, f] of this.finished) if (f.until <= nowMs) this.drop(k);
  }

  private drop(key: string): void {
    const f = this.finished.get(key);
    if (!f) return;
    this.heldBytes -= f.bytes.byteLength;
    this.finished.delete(key);
  }

  /** The render ended: hand waiters the clip (or null), keep a good one a while. */
  private settle(key: string, clip: Uint8Array | null): void {
    this.inflight.delete(key);
    const held = this.waiters.get(key) ?? [];
    this.waiters.delete(key);
    for (const resolve of held) resolve(clip);
    if (!clip) return;
    this.drop(key);
    this.finished.set(key, { bytes: clip, until: this.now().getTime() + INFLIGHT_TTL_MS });
    this.heldBytes += clip.byteLength;
    for (const k of this.finished.keys()) {
      if (this.heldBytes <= HELD_BYTES_CAP) break;
      this.drop(k);
    }
  }

  private async wait(key: string): Promise<Response> {
    const clipResponse = (clip: Uint8Array | null) =>
      // A copy per response: the held clip must outlive any one body.
      clip ? new Response(clip.slice(), { headers: { "content-type": "audio/mpeg" } }) : new Response(null, { status: 204 });
    const done = this.finished.get(key);
    if (done) return clipResponse(done.bytes);
    if (!this.inflight.has(key)) return clipResponse(null);
    const held = this.waiters.get(key) ?? [];
    if (held.length >= MAX_WAITERS_PER_KEY) return clipResponse(null);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clip = await new Promise<Uint8Array | null>((resolve) => {
      held.push(resolve);
      this.waiters.set(key, held);
      timer = setTimeout(() => {
        const rest = (this.waiters.get(key) ?? []).filter((w) => w !== resolve);
        if (rest.length) this.waiters.set(key, rest);
        else this.waiters.delete(key);
        resolve(null);
      }, this.waitMs);
    });
    if (timer !== null) clearTimeout(timer);
    return clipResponse(clip);
  }

  async fetch(request: Request): Promise<Response> {
    await this.load();
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/status") {
      const budget = Number(url.searchParams.get("budgetMicro"));
      const b = Number.isFinite(budget) && budget >= 0 ? budget : 0;
      return json({ ledger: current(this.ledger, this.now()), budgetMicro: b, dayCapMicro: dayCapMicro(b) });
    }
    if (request.method !== "POST") return json({ error: "method" }, 405);
    this.prune(this.now().getTime());
    if (url.pathname === "/done") {
      const key = lineKey(request.headers.get("x-line-key"));
      if (key === null) return json({ error: "key" }, 400);
      if (Number(request.headers.get("content-length") ?? 0) > TTS_MAX_BYTES) {
        this.settle(key, null);
        return json({ error: "size" }, 413);
      }
      const clip = new Uint8Array(await request.arrayBuffer());
      const usable = clip.byteLength > 0 && clip.byteLength <= TTS_MAX_BYTES;
      this.settle(key, usable ? clip : null);
      return usable || clip.byteLength === 0 ? json({}) : json({ error: "size" }, 413);
    }
    let body: { chars?: unknown; budgetMicro?: unknown; month?: unknown; day?: unknown; key?: unknown };
    try {
      body = await request.json();
    } catch {
      return json({ error: "body" }, 400);
    }
    if (!body || typeof body !== "object") return json({ error: "body" }, 400);
    if (body.key !== undefined && lineKey(body.key) === null) return json({ error: "key" }, 400);
    const key = lineKey(body.key);
    if (url.pathname === "/wait") {
      if (key === null) return json({ error: "key" }, 400);
      return this.wait(key);
    }
    const n = chars(body.chars);
    if (n === null) return json({ error: "chars" }, 400);
    const cost = n * AURA2_MICRO_USD_PER_CHAR;
    if (url.pathname === "/reserve") {
      const now = this.now();
      // Rendering, or just rendered: /wait hands the clip over, no charge.
      if (key !== null && (this.inflight.has(key) || this.finished.has(key))) {
        return json({ ok: false, reason: "inflight", ledger: current(this.ledger, now) });
      }
      const budget = typeof body.budgetMicro === "number" && body.budgetMicro >= 0 ? body.budgetMicro : 0;
      const result = reserve(this.ledger, cost, budget, now);
      if (!result.ok) return json({ ok: false, reason: result.reason, ledger: result.ledger });
      // Marked before the write is awaited, like the ledger: the next request sees it.
      if (key !== null) this.inflight.set(key, now.getTime() + INFLIGHT_TTL_MS);
      await this.save(result.ledger);
      return json({ ok: true, ledger: result.ledger });
    }
    if (url.pathname === "/refund") {
      if (typeof body.month !== "string" || typeof body.day !== "string") return json({ error: "period" }, 400);
      if (key !== null) this.settle(key, null);
      const ledger = refund(this.ledger, cost, { month: body.month, day: body.day }, this.now());
      await this.save(ledger);
      return json({ ledger });
    }
    return json({ error: "route" }, 404);
  }
}
