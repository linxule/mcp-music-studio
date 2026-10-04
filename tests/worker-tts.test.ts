// GET /tts — the server half of say(): render once, cache by content, cap what
// a public route can cost.
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import worker, { createMusicServer, ttsCacheKey } from "../worker/src/index";
import { VoiceBudget } from "../worker/src/voice-budget-do";
import { TTS_MAX_CHARS, TTS_MODEL, ttsUrl } from "../src/shared/tts";

const ORIGIN = "https://music-studio.linxule.com";
const waits: Promise<unknown>[] = [];
const CTX = { waitUntil: (p: Promise<unknown>) => void waits.push(p), passThroughOnException: () => {} } as never;

function fakeKv() {
  const store = new Map<string, unknown>();
  return {
    store,
    get: async (key: string, type?: string) => {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === "arrayBuffer" && v instanceof Uint8Array ? v.slice().buffer : v;
    },
    put: async (key: string, value: unknown) => void store.set(key, value),
  };
}

function fakeAi(bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x44])) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  return {
    calls,
    run: async (model: string, input: Record<string, unknown>) => {
      calls.push([model, input]);
      return new ReadableStream({ start: (c) => { c.enqueue(bytes); c.close(); } });
    },
  };
}

function budgetNs(now = () => new Date("2026-10-04T12:00:00Z")) {
  const store = new Map<string, unknown>();
  const instance = new VoiceBudget(
    { storage: { get: async <T>(k: string) => store.get(k) as T | undefined, put: async (k: string, v: unknown) => void store.set(k, structuredClone(v)) } },
    undefined,
    now,
  );
  const calls: string[] = [];
  return {
    calls,
    instance,
    ns: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: (input: string, init?: RequestInit) => { calls.push(new URL(input).pathname); return instance.fetch(new Request(input, init)); } }),
    },
  };
}

// Without a VOICE_BUDGET binding /tts renders nothing (fails closed), so every
// env gets a generous one unless the test sets the key itself.
const get = (path: string, env: unknown, ip = "203.0.113.20") => {
  const withBudget = env && typeof env === "object" && !("VOICE_BUDGET" in env) ? { ...env, VOICE_BUDGET: budgetNs().ns } : env;
  return worker.fetch(new Request(`${ORIGIN}${path}`, { headers: { "CF-Connecting-IP": ip } }), withBudget as never, CTX);
};

const line = (text: string, voice = "luna") => ttsUrl(ORIGIN, { text, voice: voice as never }).slice(ORIGIN.length);

describe("GET /tts", () => {
  it("renders through Workers AI as an immutable, CORS-open MP3, then serves the cache", async () => {
    const kv = fakeKv();
    const ai = fakeAi();
    const env = { DOCS_CACHE: kv, AI: ai };
    const first = await get(line("hi. it is me.", "orion"), env);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("audio/mpeg");
    expect(first.headers.get("access-control-allow-origin")).toBe("*");
    expect(first.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xfb, 0x90, 0x44]));
    expect(ai.calls).toEqual([[TTS_MODEL, { text: "hi. it is me.", speaker: "orion", encoding: "mp3" }]]);
    await Promise.all(waits);
    expect(kv.store.has(await ttsCacheKey({ text: "hi. it is me.", voice: "orion" }))).toBe(true);
    const again = await get(line("hi. it is me.", "orion"), env);
    expect(again.status).toBe(200);
    expect(ai.calls).toHaveLength(1);
  });

  it("accepts base64 JSON output too (models differ)", async () => {
    const env = {
      DOCS_CACHE: fakeKv(),
      AI: { run: async () => ({ audio: btoa(String.fromCharCode(1, 2, 3)) }) },
    };
    const res = await get(line("stay"), env);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("refuses what say() refuses, before spending anything", async () => {
    const ai = fakeAi();
    const env = { DOCS_CACHE: fakeKv(), AI: ai };
    expect((await get("/tts?text=", env)).status).toBe(400);
    expect((await get(`/tts?text=${"a".repeat(TTS_MAX_CHARS + 1)}`, env)).status).toBe(400);
    const cloned = await get("/tts?text=hello&voice=morgan-freeman", env);
    expect(cloned.status).toBe(400);
    expect(await cloned.text()).toMatch(/not one of/);
    expect((await worker.fetch(new Request(`${ORIGIN}/tts?text=hi`, { method: "POST" }), env as never, CTX)).status).toBe(405);
    expect(ai.calls).toHaveLength(0);
  });

  it("says so when Workers AI is not bound or fails", async () => {
    expect((await get(line("hi"), { DOCS_CACHE: fakeKv() })).status).toBe(503);
    const failing = { DOCS_CACHE: fakeKv(), AI: { run: async () => { throw new Error("capacity"); } } };
    const res = await get(line("hi"), failing);
    expect(res.status).toBe(502);
    expect(await res.text()).toMatch(/capacity/);
  });
});

describe("GET /tts — the rate-limit bindings gate misses (0.7.0 gauntlet)", () => {
  function limiter(budget: number) {
    const used = new Map<string, number>();
    return {
      used,
      limit: async ({ key }: { key: string }) => {
        const n = (used.get(key) ?? 0) + 1;
        used.set(key, n);
        return { success: n <= budget };
      },
    };
  }

  it("concurrent misses can't race past the binding the way they race KV", async () => {
    const ai = fakeAi();
    const ip = limiter(12);
    const env = { DOCS_CACHE: fakeKv(), AI: ai, TTS_IP_LIMITER: ip, TTS_GLOBAL_LIMITER: limiter(240) };
    const results = await Promise.all(
      Array.from({ length: 32 }, (_, i) => get(line(`burst ${i}`), env, "198.51.100.1")),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(12);
    expect(results.filter((r) => r.status === 429)).toHaveLength(20);
    expect(ai.calls).toHaveLength(12);
  });

  it("still limits when KV is down", async () => {
    const ai = fakeAi();
    const brokenKv = {
      get: async () => { throw new Error("kv down"); },
      put: async () => { throw new Error("kv down"); },
    };
    const env = { DOCS_CACHE: brokenKv, AI: ai, TTS_IP_LIMITER: limiter(12), TTS_GLOBAL_LIMITER: limiter(240) };
    let ok = 0;
    for (let i = 0; i < 20; i++) if ((await get(line(`down ${i}`), env, "198.51.100.2")).status === 200) ok++;
    expect(ok).toBe(12);
  });

  it("a global ceiling holds across addresses, and cache hits never touch the bindings", async () => {
    const global = limiter(3);
    const kv = fakeKv();
    const env = { DOCS_CACHE: kv, AI: fakeAi(), TTS_IP_LIMITER: limiter(100), TTS_GLOBAL_LIMITER: global };
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await get(line(`g ${i}`), env, `198.51.100.${10 + i}`)).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    await Promise.all(waits);
    expect((await get(line("g 0"), env, "198.51.100.99")).status).toBe(200);
    expect(global.used.get("all")).toBe(5);
  });
});

describe("GET /tts — Opus gauntlet fixes", () => {
  it("buckets IPv6 by /64, leaves IPv4 alone", async () => {
    const { clientBucket } = await import("../worker/src/index");
    expect(clientBucket("203.0.113.5")).toBe("203.0.113.5");
    expect(clientBucket("2001:db8:abcd:12:1:2:3:4")).toBe("2001:db8:abcd:12::/64");
    expect(clientBucket("2001:db8:abcd:12::99")).toBe("2001:db8:abcd:12::/64");
    expect(clientBucket("2001:0db8::1")).toBe("2001:db8:0:0::/64");
  });

  it("one /64 shares one budget", async () => {
    const used = new Map<string, number>();
    const ipLimiter = { limit: async ({ key }: { key: string }) => { const n = (used.get(key) ?? 0) + 1; used.set(key, n); return { success: n <= 2 }; } };
    const env = { DOCS_CACHE: fakeKv(), AI: fakeAi(), TTS_IP_LIMITER: ipLimiter };
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await get(line(`v6 ${i}`), env, `2001:db8:1:2::${i + 1}`)).status);
    expect(statuses).toEqual([200, 200, 429, 429]);
  });

  it("HEAD never renders: 404 on a miss, 200 on a hit", async () => {
    const ai = fakeAi();
    const env = { DOCS_CACHE: fakeKv(), AI: ai };
    const head = (p: string) => worker.fetch(new Request(`${ORIGIN}${p}`, { method: "HEAD" }), env as never, CTX);
    expect((await head(line("probe"))).status).toBe(404);
    expect(ai.calls).toHaveLength(0);
    await get(line("probe"), env);
    await Promise.all(waits);
    expect((await head(line("probe"))).status).toBe(200);
    expect(ai.calls).toHaveLength(1);
  });
});

describe("GET /tts — the voice budget (one dollar number, exact, fails closed)", () => {

  it("charges each new line its exact price; cached lines are free", async () => {
    const b = budgetNs();
    const kv = fakeKv();
    const env = { DOCS_CACHE: kv, AI: fakeAi(), VOICE_BUDGET: b.ns, VOICE_BUDGET_USD_PER_MONTH: "10" };
    expect((await get(line("hello there"), env)).status).toBe(200); // 11 characters
    await Promise.all(waits);
    expect((await get(line("hello there"), env)).status).toBe(200); // cached
    expect(b.calls).toEqual(["/reserve"]);
    const status = await (await get("/tts/budget", env)).json();
    expect(status).toMatchObject({ month: "2026-10", budgetUsd: 10, todayCapUsd: 1 });
    const ledger = (await (await b.instance.fetch(new Request("https://voice-budget/status?budgetMicro=0"))).json()).ledger;
    expect(ledger.monthMicro).toBe(11 * 30);
  });

  it("refuses new lines once the day's share is spent, and says so; heard lines still play", async () => {
    const b = budgetNs();
    const kv = fakeKv();
    const ai = fakeAi();
    // $0.10/month → $0.01/day → 333 characters a day.
    const env = { DOCS_CACHE: kv, AI: ai, VOICE_BUDGET: b.ns, VOICE_BUDGET_USD_PER_MONTH: "0.1" };
    expect((await get(line("a".repeat(200)), env)).status).toBe(200);
    await Promise.all(waits);
    const over = await get(line("b".repeat(200)), env);
    expect(over.status).toBe(429);
    expect(await over.text()).toMatch(/Today's share of the voice budget/);
    expect(ai.calls).toHaveLength(1);
    expect((await get(line("a".repeat(200)), env)).status).toBe(200);
  });

  it("budget 0 turns new lines off", async () => {
    const env = { DOCS_CACHE: fakeKv(), AI: fakeAi(), VOICE_BUDGET: budgetNs().ns, VOICE_BUDGET_USD_PER_MONTH: "0" };
    const res = await get(line("anything"), env);
    expect(res.status).toBe(429);
    expect(await res.text()).toMatch(/This month's voice budget/);
  });

  it("gives the reservation back when the render fails", async () => {
    const b = budgetNs();
    const env = { DOCS_CACHE: fakeKv(), VOICE_BUDGET: b.ns, AI: { run: async () => { throw new Error("capacity"); } } };
    expect((await get(line("will fail"), env)).status).toBe(502);
    await Promise.all(waits);
    expect(b.calls).toEqual(["/reserve", "/refund"]);
    const ledger = (await (await b.instance.fetch(new Request("https://voice-budget/status?budgetMicro=0"))).json()).ledger;
    expect(ledger.monthMicro).toBe(0);
  });

  it("fails closed: if the budget can't be checked, nothing is rendered", async () => {
    const ai = fakeAi();
    const broken = { idFromName: () => "x", get: () => ({ fetch: async () => { throw new Error("DO down"); } }) };
    const res = await get(line("no budget"), { DOCS_CACHE: fakeKv(), AI: ai, VOICE_BUDGET: broken });
    expect(res.status).toBe(429);
    expect(ai.calls).toHaveLength(0);
  });

  it("no budget bound: nothing is rendered (fails closed, Codex)", async () => {
    const ai = fakeAi();
    const res = await get(line("unbudgeted"), { DOCS_CACHE: fakeKv(), AI: ai, VOICE_BUDGET: undefined });
    expect(res.status).toBe(429);
    expect(ai.calls).toHaveLength(0);
  });

  it("keeps the charge when the model answered but the clip is unusable (it may be billed — Codex)", async () => {
    const b = budgetNs();
    const huge = new Uint8Array(5 * 1024 * 1024);
    const env = { DOCS_CACHE: fakeKv(), VOICE_BUDGET: b.ns, AI: fakeAi(huge) };
    expect((await get(line("too big"), env)).status).toBe(502);
    await Promise.all(waits);
    expect(b.calls).toEqual(["/reserve"]);
  });

  it("rate limits run first: a throttled client never touches the budget", async () => {
    const b = budgetNs();
    const env = { DOCS_CACHE: fakeKv(), AI: fakeAi(), VOICE_BUDGET: b.ns, TTS_IP_LIMITER: { limit: async () => ({ success: false }) } };
    expect((await get(line("throttled"), env)).status).toBe(429);
    expect(b.calls).toEqual([]);
  });
});

describe("say() prerender — tool calls warm /tts (0.12)", () => {
  async function callTool(env: unknown, name: string, args: Record<string, unknown>) {
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {} } as never;
    const client = new Client({ name: "prerender-test", version: "0.0.0" });
    const server = createMusicServer(env as never, ORIGIN, undefined, ctx);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(c), server.connect(s)]);
    try {
      const result = await client.callTool({ name, arguments: args });
      // Drain everything the call scheduled, including what warming schedules.
      while (pending.length) await Promise.all(pending.splice(0));
      return result;
    } finally {
      await client.close();
      await server.close();
    }
  }

  const CODE = [
    `const hello = say('hi. it is me.', { voice: 'orion' })`,
    `const now = say('now. at the same time.', { voice: 'orion' })`,
    `stack(s('bd*4'), hello, now, say('hi. it is me.', { voice: 'orion' }), say("mini, not words"))`,
  ].join("\n");

  it("play-live-pattern renders each distinct line once, charges once each, and /tts then hits", async () => {
    const kv = fakeKv();
    const ai = fakeAi();
    const b = budgetNs();
    const env = { DOCS_CACHE: kv, AI: ai, VOICE_BUDGET: b.ns, VOICE_BUDGET_USD_PER_MONTH: "10", TTS_IP_LIMITER: { limit: async () => ({ success: false }) } };
    const result = await callTool(env, "play-live-pattern", { code: CODE });
    expect(result.isError).toBeFalsy();
    // The per-address limiter (here: always refusing) does not gate a tool call.
    expect(ai.calls.map(([, input]) => input.text).sort()).toEqual(["hi. it is me.", "now. at the same time."]);
    expect(b.calls).toEqual(["/reserve", "/reserve"]);
    const ledger = (await (await b.instance.fetch(new Request("https://voice-budget/status?budgetMicro=0"))).json()).ledger;
    expect(ledger.monthMicro).toBe(("hi. it is me.".length + "now. at the same time.".length) * 30);
    for (const text of ["hi. it is me.", "now. at the same time."]) {
      expect(kv.store.has(await ttsCacheKey({ text, voice: "orion" }))).toBe(true);
    }
    // The player's fetch, from the address the limiter refuses: a hit, no model call.
    const res = await get(line("hi. it is me.", "orion"), env);
    expect(res.status).toBe(200);
    expect(ai.calls).toHaveLength(2);
    expect(b.calls).toHaveLength(2);
  });

  it("skips lines already cached, and warms through update-session too", async () => {
    const kv = fakeKv();
    const ai = fakeAi();
    const env = { DOCS_CACHE: kv, AI: ai, VOICE_BUDGET: budgetNs().ns };
    await callTool(env, "play-live-pattern", { code: `say('first')` });
    expect(ai.calls).toHaveLength(1);
    // No JAM bound: the update itself fails, but code that parsed was warmed.
    await callTool(env, "update-session", { session: "abcdefghijklmnop", code: `stack(say('first'), say('second'))` });
    expect(ai.calls.map(([, input]) => input.text)).toEqual(["first", "second"]);
  });

  it("never fails the tool call: budget refusals, model errors, code that doesn't parse", async () => {
    const zero = { DOCS_CACHE: fakeKv(), AI: fakeAi(), VOICE_BUDGET: budgetNs().ns, VOICE_BUDGET_USD_PER_MONTH: "0" };
    expect((await callTool(zero, "play-live-pattern", { code: `say('over budget')` })).isError).toBeFalsy();
    expect(zero.AI.calls).toHaveLength(0);
    const failing = { DOCS_CACHE: fakeKv(), VOICE_BUDGET: budgetNs().ns, AI: { run: async () => { throw new Error("capacity"); } } };
    expect((await callTool(failing, "play-live-pattern", { code: `say('fails')` })).isError).toBeFalsy();
    const ai = fakeAi();
    const broken = await callTool({ DOCS_CACHE: fakeKv(), AI: ai, VOICE_BUDGET: budgetNs().ns }, "play-live-pattern", { code: `say('x'` });
    expect(broken.isError).toBe(true);
    expect(ai.calls).toHaveLength(0);
  });

  it("renders at most 8 lines per call, 3 at a time", async () => {
    let inFlight = 0;
    let peak = 0;
    const calls: string[] = [];
    const ai = {
      run: async (_model: string, input: Record<string, unknown>) => {
        calls.push(String(input.text));
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return new Uint8Array([1, 2, 3]);
      },
    };
    const code = Array.from({ length: 12 }, (_, i) => `say('line ${i}')`).join("\n");
    await callTool({ DOCS_CACHE: fakeKv(), AI: ai, VOICE_BUDGET: budgetNs().ns }, "play-live-pattern", { code });
    expect(calls).toHaveLength(8);
    expect(peak).toBe(3);
  });
});
