// The voice budget: one dollar number for everything say() may cost.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AURA2_MICRO_USD_PER_CHAR,
  budgetMicro,
  current,
  dayCapMicro,
  DEFAULT_VOICE_BUDGET_USD_PER_MONTH,
  lineCostMicro,
  refund,
  reserve,
  usd,
} from "../src/shared/voice-budget";
import { VoiceBudget } from "../worker/src/voice-budget-do";

const at = (iso: string) => new Date(iso);

describe("the ledger (pure)", () => {
  it("prices a line exactly: Aura-2 is $0.030 per 1,000 characters", () => {
    expect(AURA2_MICRO_USD_PER_CHAR).toBe(30);
    expect(lineCostMicro("x".repeat(1000))).toBe(30_000); // $0.03
    expect(lineCostMicro("héllo")).toBe(150);
    // UTF-16 units: never fewer than code points, so emoji can't undercount.
    expect(lineCostMicro("😀")).toBe(60);
  });

  it("reads the knob; missing or nonsense means the default, 0 means voices off", () => {
    expect(budgetMicro("10")).toBe(10_000_000);
    expect(budgetMicro("2.5")).toBe(2_500_000);
    expect(budgetMicro(undefined)).toBe(DEFAULT_VOICE_BUDGET_USD_PER_MONTH * 1_000_000);
    expect(budgetMicro("lots")).toBe(DEFAULT_VOICE_BUDGET_USD_PER_MONTH * 1_000_000);
    expect(budgetMicro("-5")).toBe(DEFAULT_VOICE_BUDGET_USD_PER_MONTH * 1_000_000);
    expect(budgetMicro("0")).toBe(0);
    expect(reserve(undefined, 30, 0, at("2026-10-04T12:00:00Z")).ok).toBe(false);
  });

  it("no single day may spend more than a tenth of the month", () => {
    const month = budgetMicro("10");
    expect(dayCapMicro(month)).toBe(1_000_000);
    let ledger;
    const now = at("2026-10-04T12:00:00Z");
    for (let i = 0; i < 10; i++) {
      const r = reserve(ledger, 100_000, month, now);
      expect(r.ok).toBe(true);
      ledger = r.ledger;
    }
    const over = reserve(ledger, 1, month, now);
    expect(over).toMatchObject({ ok: false, reason: "day" });
    // Tomorrow the day's share is back; the month remembers.
    const tomorrow = reserve(ledger, 100_000, month, at("2026-10-05T00:00:01Z"));
    expect(tomorrow.ok).toBe(true);
    expect(tomorrow.ledger).toMatchObject({ day: "2026-10-05", dayMicro: 100_000, monthMicro: 1_100_000 });
  });

  it("the month is the ceiling, and a new month starts from zero", () => {
    const month = 1_000; // tiny budget: day cap 100
    let ledger = current(undefined, at("2026-10-01T00:00:00Z"));
    for (let d = 1; d <= 10; d++) {
      const r = reserve(ledger, 100, month, at(`2026-10-${String(d).padStart(2, "0")}T09:00:00Z`));
      expect(r.ok).toBe(true);
      ledger = r.ledger;
    }
    expect(reserve(ledger, 1, month, at("2026-10-11T09:00:00Z"))).toMatchObject({ ok: false, reason: "month" });
    expect(reserve(ledger, 1, month, at("2026-11-01T00:00:00Z")).ok).toBe(true);
  });

  it("a refund gives the reservation back, never below zero", () => {
    const now = at("2026-10-04T12:00:00Z");
    const r = reserve(undefined, 500, 10_000, now);
    const period = { month: "2026-10", day: "2026-10-04" };
    expect(refund(r.ledger, 500, period, now)).toMatchObject({ monthMicro: 0, dayMicro: 0 });
    expect(refund(undefined, 500, period, now)).toMatchObject({ monthMicro: 0, dayMicro: 0 });
  });

  it("a late refund only comes out of the period it was charged to (Codex)", () => {
    const month = budgetMicro("0.08"); // day cap 8,000 µ$ = 266 chars
    const yesterday = { month: "2026-10", day: "2026-10-03" };
    const today = at("2026-10-04T00:00:05Z");
    const r = reserve(undefined, 240 * 30, month, today); // today's line
    // Yesterday's failed line refunds after midnight: today's share stays spent.
    const after = refund(r.ledger, 240 * 30, yesterday, today);
    expect(after.dayMicro).toBe(240 * 30);
    expect(after.monthMicro).toBe(0); // the month did pay for yesterday's line
    expect(reserve(after, 240 * 30, month, today)).toMatchObject({ ok: false, reason: "day" });
    // Last month's refund never touches this month.
    const nov = reserve(undefined, 100, month, at("2026-11-01T00:00:01Z"));
    expect(refund(nov.ledger, 100, { month: "2026-10", day: "2026-10-31" }, at("2026-11-01T00:00:02Z"))).toMatchObject({ monthMicro: 100, dayMicro: 100 });
  });

  it("reports dollars to the cent", () => {
    expect(usd(1_234_567)).toBe(1.23);
    expect(usd(0)).toBe(0);
  });
});

function fakeState() {
  const store = new Map<string, unknown>();
  return {
    store,
    storage: {
      get: async <T>(k: string) => store.get(k) as T | undefined,
      put: async (k: string, v: unknown) => void store.set(k, structuredClone(v)),
    },
  };
}
const post = (path: string, body: unknown) =>
  new Request(`https://voice-budget${path}`, { method: "POST", body: JSON.stringify(body) });

describe("the VoiceBudget Durable Object", () => {
  it("reserves, refuses past the budget, refunds, and persists", async () => {
    const state = fakeState();
    const now = () => at("2026-10-04T12:00:00Z");
    const budget = new VoiceBudget(state, undefined, now);
    // $0.30 a month → $0.03 a day → 1,000 characters a day.
    const month = budgetMicro("0.3");
    expect(await (await budget.fetch(post("/reserve", { chars: 600, budgetMicro: month }))).json()).toMatchObject({ ok: true });
    expect(await (await budget.fetch(post("/reserve", { chars: 600, budgetMicro: month }))).json()).toMatchObject({ ok: false, reason: "day" });
    expect((await budget.fetch(post("/refund", { chars: 600 }))).status).toBe(400); // no period
    await budget.fetch(post("/refund", { chars: 600, month: "2026-10", day: "2026-10-04" }));
    expect(await (await budget.fetch(post("/reserve", { chars: 1000, budgetMicro: month }))).json()).toMatchObject({ ok: true });
    // A fresh instance (an evicted object) reads the same ledger back.
    const again = new VoiceBudget(state, undefined, now);
    const status = await (await again.fetch(new Request(`https://voice-budget/status?budgetMicro=${month}`))).json();
    expect(status).toMatchObject({ ledger: { monthMicro: 30_000, dayMicro: 30_000 }, dayCapMicro: 30_000 });
  });

  it("concurrent reservations can't both slip under the line", async () => {
    // The race the KV tripwire had: two misses both read "under budget".
    // Slow storage: reads land at staggered times, writes land late — so a
    // naive "each request loads the ledger" would overwrite reservations made
    // in between (mutation-checked: the old load() let 10 of 10 through).
    const store = new Map<string, unknown>();
    let reads = 0;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const slow = {
      storage: {
        get: async <T>(k: string) => { await sleep(2 * reads++); return store.get(k) as T | undefined; },
        put: async (k: string, v: unknown) => { await sleep(40); store.set(k, structuredClone(v)); },
      },
    };
    const budget = new VoiceBudget(slow, undefined, () => at("2026-10-04T12:00:00Z"));
    const month = budgetMicro("0.3"); // day cap: 1,000 characters
    const results = await Promise.all(
      Array.from({ length: 10 }, () => budget.fetch(post("/reserve", { chars: 240, budgetMicro: month })).then((r) => r.json())),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(4); // 4 × 240 = 960 ≤ 1,000
  });

  it("rejects malformed requests", async () => {
    const budget = new VoiceBudget(fakeState());
    expect((await budget.fetch(post("/reserve", { chars: -1, budgetMicro: 1 }))).status).toBe(400);
    expect((await budget.fetch(post("/reserve", { chars: 1.5, budgetMicro: 1 }))).status).toBe(400);
    expect((await budget.fetch(new Request("https://voice-budget/reserve", { method: "POST", body: "{" }))).status).toBe(400);
    expect((await budget.fetch(post("/nope", { chars: 1 }))).status).toBe(404);
    expect((await budget.fetch(new Request("https://voice-budget/reserve", { method: "POST", body: "null" }))).status).toBe(400);
  });
});

describe("the deployed config keeps the budget wired", () => {
  // Unbound, the route would render without a budget. Pin the binding, the
  // migration and the knob, for production AND the lab environment.
  const raw = readFileSync(new URL("../worker/wrangler.jsonc", import.meta.url), "utf8");
  const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));
  it.each([
    ["production", config],
    ["lab", config.env.lab],
  ])("%s", (_name, c) => {
    expect(c.durable_objects.bindings).toContainEqual({ name: "VOICE_BUDGET", class_name: "VoiceBudget" });
    expect(Number(c.vars.VOICE_BUDGET_USD_PER_MONTH)).toBeGreaterThan(0);
  });
  it("migrates the class", () => {
    expect(config.migrations.some((m: { new_sqlite_classes?: string[] }) => m.new_sqlite_classes?.includes("VoiceBudget"))).toBe(true);
  });
  it("exports the class from the workerd entry", () => {
    expect(readFileSync(new URL("../worker/src/entry.ts", import.meta.url), "utf8")).toMatch(/export \{ VoiceBudget \}/);
  });
});
