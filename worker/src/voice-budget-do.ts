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
//   POST /done    {key}                      → {}
//   GET  /status?budgetMicro=                → {ledger, budgetMicro, dayCapMicro}
//
// `key` is the line's cache key. While one caller renders a line, a second
// reserve for the same key answers "inflight" without charging: the tool-time
// prerender (from claude.ai's servers) and the player's GET /tts (from the
// user's browser) reach different isolates, so only this singleton sees both.
// The in-flight map lives in memory only — an evicted object forgets it, which
// costs at worst a second render, never a stuck line — and every entry expires
// after INFLIGHT_TTL_MS even if /done never arrives.
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

/** Longest a line counts as being rendered without a /done (a render is ~1.5 s). */
export const INFLIGHT_TTL_MS = 15_000;

export class VoiceBudget {
  private ledger: VoiceLedger | undefined;
  /** One shared first read: concurrent requests must not each reload storage
   *  and overwrite a reservation another made in between. */
  private loading: Promise<void> | undefined;
  /** Lines being rendered right now: cache key → expiry (ms). Memory only. */
  private readonly inflight = new Map<string, number>();

  constructor(
    private readonly state: BudgetState,
    _env?: unknown,
    private readonly now: () => Date = () => new Date(),
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
    let body: { chars?: unknown; budgetMicro?: unknown; month?: unknown; day?: unknown; key?: unknown };
    try {
      body = await request.json();
    } catch {
      return json({ error: "body" }, 400);
    }
    if (!body || typeof body !== "object") return json({ error: "body" }, 400);
    if (body.key !== undefined && lineKey(body.key) === null) return json({ error: "key" }, 400);
    const key = lineKey(body.key);
    if (url.pathname === "/done") {
      if (key === null) return json({ error: "key" }, 400);
      this.inflight.delete(key);
      return json({});
    }
    const n = chars(body.chars);
    if (n === null) return json({ error: "chars" }, 400);
    const cost = n * AURA2_MICRO_USD_PER_CHAR;
    if (url.pathname === "/reserve") {
      const now = this.now();
      if (key !== null) {
        this.prune(now.getTime());
        if (this.inflight.has(key)) return json({ ok: false, reason: "inflight", ledger: current(this.ledger, now) });
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
      if (key !== null) this.inflight.delete(key);
      const ledger = refund(this.ledger, cost, { month: body.month, day: body.day }, this.now());
      await this.save(ledger);
      return json({ ledger });
    }
    return json({ error: "route" }, 404);
  }
}
