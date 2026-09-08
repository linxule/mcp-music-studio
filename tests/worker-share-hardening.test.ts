import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import worker, {
  SHARE_RATE_LIMIT_MAX,
  SHARE_RATE_LIMIT_WINDOW_SECONDS,
  createMusicServer,
  shareRateLimitKey,
} from "../worker/src/index";
import { decodeShareParam } from "../src/shared/share-url";

// =============================================================================
// Hardening of the public share surface — F5 (rate limit) and F6/F7 on the
// worker's own paths.
// =============================================================================

const ORIGIN = "https://mcp-music-studio.linxule.workers.dev";
const CTX = { waitUntil: () => {}, passThroughOnException: () => {} } as never;

const call = (path: string, init?: RequestInit, env: unknown = {}) =>
  worker.fetch(new Request(`${ORIGIN}${path}`, init), env as never, CTX);

/** Minimal in-memory stand-in for the DOCS_CACHE KV binding. */
function fakeKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  const puts: { key: string; value: string; options?: { expirationTtl?: number } }[] = [];
  return {
    store,
    puts,
    binding: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
        store.set(key, value);
        puts.push({ key, value, options });
      },
    },
  };
}

const postShare = (body: unknown, env: unknown, ip = "203.0.113.7") =>
  call(
    "/share",
    { method: "POST", body: JSON.stringify(body), headers: { "CF-Connecting-IP": ip } },
    env,
  );

/** A pattern too long for a query string, so POST /share actually stores. */
const longCode = (tag: string) => `s("bd") // ${tag} ${"x".repeat(4000)}`;

const strudelInit = (html: string): { code: string } => {
  const match = html.match(
    /<script type="application\/json" id="init-data">([\s\S]*?)<\/script>/,
  );
  if (!match) throw new Error("no init-data script block in the page");
  return JSON.parse(match[1]!);
};

// -----------------------------------------------------------------------------
// F5 — POST /share was unauthenticated with no rate limit
// -----------------------------------------------------------------------------

describe("POST /share rate limit", () => {
  it("accepts exactly the budget, then 429s with a Retry-After", async () => {
    const kv = fakeKv();
    const env = { DOCS_CACHE: kv.binding };

    for (let i = 0; i < SHARE_RATE_LIMIT_MAX; i++) {
      const res = await postShare({ kind: "play", args: { code: longCode(`a${i}`) } }, env);
      expect(res.status).toBe(200);
    }

    const blocked = await postShare({ kind: "play", args: { code: longCode("over") } }, env);
    expect(blocked.status).toBe(429);

    const retryAfter = Number(blocked.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(SHARE_RATE_LIMIT_WINDOW_SECONDS);
  });

  it("counts per address — a second IP has its own budget", async () => {
    const kv = fakeKv();
    const env = { DOCS_CACHE: kv.binding };

    for (let i = 0; i <= SHARE_RATE_LIMIT_MAX; i++) {
      await postShare({ kind: "play", args: { code: longCode(`a${i}`) } }, env, "198.51.100.1");
    }
    const other = await postShare(
      { kind: "play", args: { code: longCode("other") } },
      env,
      "198.51.100.2",
    );
    expect(other.status).toBe(200);
  });

  it("stores the bucket under ratelimit:share:<ip> with a TTL", async () => {
    const kv = fakeKv();
    await postShare({ kind: "play", args: { code: longCode("one") } }, { DOCS_CACHE: kv.binding }, "203.0.113.9");

    const put = kv.puts.find((p) => p.key === shareRateLimitKey("203.0.113.9"));
    expect(put).toBeDefined();
    expect(put!.options?.expirationTtl).toBeGreaterThan(0);
    expect(put!.options?.expirationTtl).toBeLessThanOrEqual(SHARE_RATE_LIMIT_WINDOW_SECONDS);
    expect(JSON.parse(put!.value).n).toBe(1);
  });

  it("does not slide the window while a caller is blocked", async () => {
    const kv = fakeKv();
    const env = { DOCS_CACHE: kv.binding };
    for (let i = 0; i < SHARE_RATE_LIMIT_MAX; i++) {
      await postShare({ kind: "play", args: { code: longCode(`a${i}`) } }, env);
    }
    const before = kv.puts.length;
    await postShare({ kind: "play", args: { code: longCode("x") } }, env);
    await postShare({ kind: "play", args: { code: longCode("y") } }, env);
    // Rejected requests write nothing at all — no counter bump, no share.
    expect(kv.puts.length).toBe(before);
  });

  it("lets an expired window start fresh", async () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const kv = fakeKv({
      [shareRateLimitKey("203.0.113.7")]: JSON.stringify({
        n: SHARE_RATE_LIMIT_MAX,
        reset: past,
      }),
    });
    const res = await postShare(
      { kind: "play", args: { code: longCode("fresh") } },
      { DOCS_CACHE: kv.binding },
    );
    expect(res.status).toBe(200);
  });

  it("fails open when KV can't answer, rather than taking the route down", async () => {
    const res = await postShare(
      { kind: "play", args: { code: longCode("kv-down") } },
      {
        DOCS_CACHE: {
          get: async () => {
            throw new Error("KV is having a day");
          },
          put: async () => {},
        },
      },
    );
    expect(res.status).toBe(200);
  });

  it("does not limit the in-process tool path", async () => {
    // shareUrlFor() is called by the worker's own handlers, not through /share.
    const kv = fakeKv({
      [shareRateLimitKey("unknown")]: JSON.stringify({
        n: SHARE_RATE_LIMIT_MAX * 10,
        reset: Math.floor(Date.now() / 1000) + SHARE_RATE_LIMIT_WINDOW_SECONDS,
      }),
    });
    const content = await callPlayLive(
      { code: longCode("tool") },
      { DOCS_CACHE: kv.binding },
    );
    expect(content.some((c) => c.type === "resource_link")).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// F6 — numbers reaching the page generators, on the KV path
// -----------------------------------------------------------------------------

async function callPlayLive(
  args: Record<string, unknown>,
  env: unknown,
): Promise<{ type: string; text?: string; uri?: string }[]> {
  const client = new Client({ name: "share-hardening", version: "0.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(c),
    createMusicServer(env as never, ORIGIN).connect(s),
  ]);
  const res = await client.callTool({ name: "play-live-pattern", arguments: args });
  return res.content as { type: string; text?: string; uri?: string }[];
}

describe("share numbers are clamped on every path", () => {
  it("clamps an absurd bpm posted to /share before it reaches the page", async () => {
    const kv = fakeKv();
    const code = longCode("bpm");
    const res = await postShare(
      { kind: "play", args: { code, bpm: 1e9 } },
      { DOCS_CACHE: kv.binding },
    );
    const { url } = (await res.json()) as { url: string };
    expect(JSON.parse(kv.puts.find((p) => p.key.startsWith("share:"))!.value).args.bpm).toBe(300);

    const page = await call(new URL(url).pathname, undefined, { DOCS_CACHE: kv.binding });
    // 300 bpm → setcps(1.25), not setcps(4166666).
    expect(strudelInit(await page.text()).code).toContain("setcps(1.25)");
  });

  it("clamps a negative bpm rather than baking a negative cps", async () => {
    const kv = fakeKv();
    const res = await postShare(
      { kind: "play", args: { code: longCode("neg"), bpm: -120 } },
      { DOCS_CACHE: kv.binding },
    );
    const { url } = (await res.json()) as { url: string };
    const page = await call(new URL(url).pathname, undefined, { DOCS_CACHE: kv.binding });
    const code = strudelInit(await page.text()).code;
    expect(code).not.toMatch(/setcps\(-/);
    // 40 bpm is the floor → 40/60/4.
    expect(code).toContain("setcps(0.1667)");
  });

  it("clamps the score numbers read back out of KV", async () => {
    const kv = fakeKv();
    await postShare(
      {
        kind: "score",
        args: {
          abcNotation: `X:1\nK:C\n% ${"z".repeat(4000)}\nCDEF|`,
          tempo: 1e9,
          swing: 9999,
          drumIntro: -4,
          transpose: 99,
        },
      },
      { DOCS_CACHE: kv.binding },
    );
    const stored = JSON.parse(
      kv.puts.find((p) => p.key.startsWith("share:"))!.value,
    ).args;
    expect(stored).toMatchObject({ tempo: 240, swing: 75, drumIntro: 0, transpose: 12 });
  });

  it("clamps a hostile value already sitting in KV on the way out", async () => {
    // KV holds what we wrote, but a payload reaching a page generator is never
    // trusted on provenance — coerceSharePayload re-clamps on read.
    const id = "0".repeat(32);
    const kv = fakeKv({
      [`share:${id}`]: JSON.stringify({
        kind: "play",
        args: { code: 's("bd")', bpm: 1e9 },
      }),
    });
    const page = await call(`/p/${id}`, undefined, { DOCS_CACHE: kv.binding });
    expect(strudelInit(await page.text()).code).toContain("setcps(1.25)");
  });
});

// -----------------------------------------------------------------------------
// F7 — the `visuals` preset used to be dropped from the link
// -----------------------------------------------------------------------------

describe("the share link carries the visuals preset", () => {
  it("folds a hydra preset into the /play link the tool returns", async () => {
    const content = await callPlayLive(
      { code: 's("bd sd")', visuals: "hydra-kaleid" },
      { DOCS_CACHE: fakeKv().binding },
    );
    const link = content.find((c) => c.type === "resource_link");
    const code = decodeShareParam(new URL(link!.uri!).searchParams.get("c")!);
    expect(code).toContain("initHydra(");
    expect(code).toContain("kaleid(");
  });

  it("folds a draw preset, and the linked page actually renders it", async () => {
    const content = await callPlayLive(
      { code: 's("bd sd")', visuals: "pianoroll" },
      { DOCS_CACHE: fakeKv().binding },
    );
    const link = content.find((c) => c.type === "resource_link");
    const page = await call(
      new URL(link!.uri!).pathname + new URL(link!.uri!).search,
      undefined,
      { DOCS_CACHE: fakeKv().binding },
    );
    expect(strudelInit(await page.text()).code).toContain("pianoroll(");
  });

  it("drops `theme` — it never reaches the standalone page", async () => {
    const content = await callPlayLive(
      { code: 's("bd sd")', theme: "sonicPink" },
      { DOCS_CACHE: fakeKv().binding },
    );
    const link = content.find((c) => c.type === "resource_link");
    expect(link!.uri).not.toContain("theme");
    expect(link!.uri).not.toContain("sonicPink");
  });
});
