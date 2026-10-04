// =============================================================================
// VoiceBudget — the one Durable Object that holds the month's voice spend
//
// A single instance (idFromName("global")). A Durable Object handles one
// request at a time, so two cache misses can't both read "under budget" and
// both render — the race the old KV tripwire had (it also failed open when KV
// was down). Logic: src/shared/voice-budget.ts.
//
//   POST /reserve {chars, budgetMicro} → {ok, reason?, ledger}
//   POST /refund  {chars, month, day}  → {ledger}   (only from that period)
//   GET  /status?budgetMicro=          → {ledger, budgetMicro, dayCapMicro}
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

export class VoiceBudget {
  private ledger: VoiceLedger | undefined;
  /** One shared first read: concurrent requests must not each reload storage
   *  and overwrite a reservation another made in between. */
  private loading: Promise<void> | undefined;

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

  async fetch(request: Request): Promise<Response> {
    await this.load();
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/status") {
      const budget = Number(url.searchParams.get("budgetMicro"));
      const b = Number.isFinite(budget) && budget >= 0 ? budget : 0;
      return json({ ledger: current(this.ledger, this.now()), budgetMicro: b, dayCapMicro: dayCapMicro(b) });
    }
    if (request.method !== "POST") return json({ error: "method" }, 405);
    let body: { chars?: unknown; budgetMicro?: unknown; month?: unknown; day?: unknown };
    try {
      body = await request.json();
    } catch {
      return json({ error: "body" }, 400);
    }
    if (!body || typeof body !== "object") return json({ error: "body" }, 400);
    const n = chars(body.chars);
    if (n === null) return json({ error: "chars" }, 400);
    const cost = n * AURA2_MICRO_USD_PER_CHAR;
    if (url.pathname === "/reserve") {
      const budget = typeof body.budgetMicro === "number" && body.budgetMicro >= 0 ? body.budgetMicro : 0;
      const result = reserve(this.ledger, cost, budget, this.now());
      if (result.ok) await this.save(result.ledger);
      return json(result.ok ? { ok: true, ledger: result.ledger } : { ok: false, reason: result.reason, ledger: result.ledger });
    }
    if (url.pathname === "/refund") {
      if (typeof body.month !== "string" || typeof body.day !== "string") return json({ error: "period" }, 400);
      const ledger = refund(this.ledger, cost, { month: body.month, day: body.day }, this.now());
      await this.save(ledger);
      return json({ ledger });
    }
    return json({ error: "route" }, 404);
  }
}
