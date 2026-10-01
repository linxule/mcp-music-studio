// GET /tts — the server half of say(): render once, cache by content, cap what
// a public route can cost.
import { describe, expect, it } from "vitest";
import worker, { TTS_RATE_LIMIT_MAX, ttsCacheKey } from "../worker/src/index";
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

const get = (path: string, env: unknown, ip = "203.0.113.20") =>
  worker.fetch(new Request(`${ORIGIN}${path}`, { headers: { "CF-Connecting-IP": ip } }), env as never, CTX);

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

  it("budgets new renders per address; cache hits are free", async () => {
    const kv = fakeKv();
    const ai = fakeAi();
    const env = { DOCS_CACHE: kv, AI: ai };
    for (let i = 0; i < TTS_RATE_LIMIT_MAX; i++) {
      expect((await get(line(`line ${i}`), env, "203.0.113.99")).status).toBe(200);
    }
    await Promise.all(waits);
    const over = await get(line("one more"), env, "203.0.113.99");
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBeTruthy();
    // Already rendered: still served.
    expect((await get(line("line 0"), env, "203.0.113.99")).status).toBe(200);
    // Someone else: their own budget.
    expect((await get(line("one more"), env, "203.0.113.100")).status).toBe(200);
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

  it("still limits when KV is down (the KV budget fails open; the binding doesn't)", async () => {
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

  it("a daily tripwire stops new renders across everyone", async () => {
    const { TTS_DAILY_MAX } = await import("../worker/src/index");
    const kv = fakeKv();
    kv.store.set(`tts:day:${new Date().toISOString().slice(0, 10)}`, String(TTS_DAILY_MAX));
    const res = await get(line("over budget"), { DOCS_CACHE: kv, AI: fakeAi() });
    expect(res.status).toBe(429);
    expect(await res.text()).toMatch(/today/);
  });
});
