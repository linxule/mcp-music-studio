import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import worker, { WIDGET_BUILD, createMusicServer } from "../worker/src/index";
import { VERSION } from "../src/version";
import { encodeShareParam } from "../src/shared/share-url";

// =============================================================================
// Worker request layer — every non-/mcp route
// =============================================================================
//
// These routes are hand-rolled inside `fetch` and are never exercised by the MCP
// SDK, so nothing else covers them. `agents/mcp` is aliased to a stub in
// vitest.config.ts (see tests/stubs/agents-mcp.ts), and the bundled widget HTML
// is loaded by the same config's html-as-text plugin.

const ENV = {} as never;
const CTX = { waitUntil: () => {}, passThroughOnException: () => {} } as never;

const ORIGIN = "https://mcp-music-studio.linxule.workers.dev";

const get = (path: string, init?: RequestInit, env: unknown = ENV) =>
  worker.fetch(new Request(`${ORIGIN}${path}`, init), env as never, CTX);

/** Minimal in-memory stand-in for the DOCS_CACHE KV binding. */
function fakeKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  const puts: { key: string; value: string; options?: { expirationTtl?: number } }[] =
    [];
  return {
    store,
    puts,
    binding: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (
        key: string,
        value: string,
        options?: { expirationTtl?: number },
      ) => {
        store.set(key, value);
        puts.push({ key, value, options });
      },
    },
  };
}

// The two generators inject their payload as JSON, in their own way. Reading it
// back is how these tests prove a pattern survived base64url → KV → page intact.

/** Strudel page: `<script type="application/json" id="init-data">…</script>`. */
function strudelInit(html: string): { code: string; autoplay: boolean } {
  const match = html.match(
    /<script type="application\/json" id="init-data">([\s\S]*?)<\/script>/,
  );
  if (!match) throw new Error("no init-data script block in the page");
  return JSON.parse(match[1]!);
}

/** ABC page: `var INIT = {…};` inside the inline bootstrap script. */
function scoreInit(html: string): { abc: string; style: string } {
  const match = html.match(/var INIT = (\{[\s\S]*?\});\n/);
  if (!match) throw new Error("no INIT literal in the page");
  return JSON.parse(match[1]!);
}

/**
 * The share writes only — POST /share also writes the rate limiter's bucket
 * (`ratelimit:share:<ip>`) into the same namespace, which is not a stored share.
 */
const shares = (kv: ReturnType<typeof fakeKv>) =>
  kv.puts.filter((p) => p.key.startsWith("share:"));

/** Query string for /play, with the code base64url-encoded like a real link. */
function playQuery(code: string, extra: Record<string, string> = {}): string {
  return new URLSearchParams({ c: encodeShareParam(code), ...extra }).toString();
}

afterEach(() => vi.restoreAllMocks());

describe("/health and /healthz", () => {
  it.each(["/health", "/healthz"])("%s reports ok + version as JSON", async (p) => {
    const res = await get(p);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.version).toBe(VERSION);
  });

  it("exposes the bundled widget build identity so a stale deploy is detectable", async () => {
    const body = await (await get("/health")).json();
    // The Worker inlines dist/*.html at build time; VERSION alone can't tell a
    // fresh deploy from one that skipped `bun run build`.
    expect(body.widgets).toEqual({
      abc: WIDGET_BUILD.abc,
      strudel: WIDGET_BUILD.strudel,
    });
    for (const fp of [body.widgets.abc, body.widgets.strudel]) {
      expect(fp).toMatch(/^[0-9a-f]{8}-\d+$/);
    }
    // Two different widgets must not share a fingerprint.
    expect(body.widgets.abc).not.toBe(body.widgets.strudel);
  });

  it("fingerprints the actual built widget files when dist/ is present", async () => {
    // Belt and braces: the html-as-text plugin falls back to a stub when dist/
    // hasn't been built, and a stub would make the assertions above pass
    // vacuously. When the real files exist, the length half of each fingerprint
    // must match them byte for byte.
    const dist = new URL("../dist/", import.meta.url);
    const files = {
      abc: fileURLToPath(new URL("mcp-app.html", dist)),
      strudel: fileURLToPath(new URL("strudel-app.html", dist)),
    };
    if (!existsSync(files.abc) || !existsSync(files.strudel)) return;

    const body = await (await get("/health")).json();
    for (const key of ["abc", "strudel"] as const) {
      const length = readFileSync(files[key], "utf-8").length;
      expect(body.widgets[key].endsWith(`-${length}`)).toBe(true);
    }
  });
});

describe("/icon.png", () => {
  it("proxies the upstream PNG as direct bytes (no redirect)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200 }),
      );

    const res = await get("/icon.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toContain("max-age=86400");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    );
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(
      "assets/icons/logo-256.png",
    );
  });

  it("502s rather than relaying a non-OK upstream body as image/png", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("<html>404 not found</html>", { status: 404 }),
    );
    const res = await get("/icon.png");
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).not.toContain("image/png");
    expect(await res.text()).toBe("icon unavailable");
  });

  it("502s instead of crashing when the upstream fetch throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("DNS failure"));
    const res = await get("/icon.png");
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("icon unavailable");
  });
});

describe("/favicon.*", () => {
  it.each(["/favicon.ico", "/favicon.png"])(
    "%s 301s to the GitHub-raw logo",
    async (p) => {
      const res = await get(p);
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe(
        "https://raw.githubusercontent.com/linxule/mcp-music-studio/main/assets/logo.png",
      );
      expect(res.headers.get("cache-control")).toContain("max-age=604800");
    },
  );
});

describe("landing page", () => {
  it("serves HTML carrying the version, connect instructions and favicon link", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html");
    const html = await res.text();
    expect(html).toContain(`MCP Music Studio v${VERSION}`);
    // The <link rel="icon"> is the whole reason this route is HTML.
    expect(html).toContain('<link rel="icon" type="image/png" href="/favicon.png">');
    expect(html).toContain(
      "https://mcp-music-studio.linxule.workers.dev/mcp",
    );
  });
});

// =============================================================================
// Hosted player pages — the "Tier 3" click-to-play routes
// =============================================================================

describe("GET /play", () => {
  const CODE = 'stack(\n  s("bd*2 sd"),\n  note("c e g").s("gm_flute")\n) // & <hi>';

  it("renders the Strudel page with the code round-tripped into its init script", async () => {
    const res = await get(`/play?${playQuery(CODE)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");

    const html = await res.text();
    expect(html).toContain("<strudel-editor");
    // The whole point: the pattern arrives byte for byte, quotes/newlines/& and all.
    expect(strudelInit(html).code).toBe(CODE);
  });

  it("applies bpm through the shared tempo policy", async () => {
    const res = await get(`/play?${playQuery('s("bd")', { bpm: "120" })}`);
    // 120 bpm = 0.5 cps. The generator prepends a setter when the pattern has none.
    expect(strudelInit(await res.text()).code).toContain("setcps(0.5)");
  });

  it("honours autoplay=0", async () => {
    const on = await get(`/play?${playQuery('s("bd")')}`);
    const off = await get(`/play?${playQuery('s("bd")', { autoplay: "0" })}`);
    expect(strudelInit(await on.text()).autoplay).toBe(true);
    expect(strudelInit(await off.text()).autoplay).toBe(false);
  });

  it("carries a CSP that names the same origins the widget declares", async () => {
    const csp = (await get(`/play?${playQuery('s("bd")')}`)).headers.get(
      "content-security-policy",
    )!;
    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'none'");
    // Script CDN and soundfont host — without both the page is silent.
    expect(csp).toContain("https://unpkg.com");
    expect(csp).toContain("https://felixroos.github.io");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("asks not to be indexed", async () => {
    const res = await get(`/play?${playQuery('s("bd")')}`);
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("400s on a malformed base64url payload", async () => {
    const res = await get("/play?c=not%20base64%21");
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  it("400s when the code param is missing entirely", async () => {
    expect((await get("/play?bpm=120")).status).toBe(400);
  });

  it("400s on a non-numeric bpm", async () => {
    const res = await get(`/play?${playQuery('s("bd")', { bpm: "fast" })}`);
    expect(res.status).toBe(400);
  });

  it("413s on an oversized payload without decoding it", async () => {
    // 128 KiB of base64url — double the 64 KiB decode cap.
    const res = await get(`/play?c=${"A".repeat(128 * 1024)}`);
    expect(res.status).toBe(413);
  });
});

describe("GET /score", () => {
  const ABC = "X:1\nT:Tune & Co\nM:4/4\nK:C\n|:C D E F|G A B c:|";

  it("renders the sheet-music page with the notation round-tripped", async () => {
    const q = new URLSearchParams({ a: encodeShareParam(ABC), style: "jazz" });
    const res = await get(`/score?${q}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");

    const html = await res.text();
    const init = scoreInit(html);
    // The generator weaves in Q:/style directives, so the ABC is a superset of
    // what was sent — every original line must still be there.
    for (const line of ABC.split("\n")) expect(init.abc).toContain(line);
    expect(init.style).toBe("jazz");
  });

  it("carries a CSP allowing abcjs's CDN and the soundfont host", async () => {
    const q = new URLSearchParams({ a: encodeShareParam(ABC) });
    const csp = (await get(`/score?${q}`)).headers.get(
      "content-security-policy",
    )!;
    expect(csp).toContain("https://cdn.jsdelivr.net");
    expect(csp).toContain("https://paulrosen.github.io");
  });

  it("400s on a malformed payload and 413s on an oversized one", async () => {
    expect((await get("/score?a=%2F%2Fbad")).status).toBe(400);
    expect((await get(`/score?a=${"A".repeat(128 * 1024)}`)).status).toBe(413);
  });
});

describe("GET /p/<id>", () => {
  const PAYLOAD = { kind: "play", args: { code: 's("bd sd*2")' } };

  it("renders a share read back from KV", async () => {
    const kv = fakeKv({ [`share:${"a".repeat(32)}`]: JSON.stringify(PAYLOAD) });
    const res = await get(`/p/${"a".repeat(32)}`, undefined, {
      DOCS_CACHE: kv.binding,
    });
    expect(res.status).toBe(200);
    expect(strudelInit(await res.text()).code).toBe(PAYLOAD.args.code);
  });

  it("404s a share that expired or never existed", async () => {
    const res = await get(`/p/${"b".repeat(32)}`, undefined, {
      DOCS_CACHE: fakeKv().binding,
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("expired");
  });

  it.each([
    "/p/",
    // Percent-encoded, because a literal `/p/../secret` is normalised to
    // `/secret` by URL parsing before it ever reaches the router.
    "/p/..%2Fsecret",
    "/p/NOTHEX",
    `/p/${"a".repeat(31)}`,
    `/p/${"a".repeat(33)}`,
  ])(
    "400s %s without touching KV",
    async (path) => {
      const kv = fakeKv();
      let reads = 0;
      const res = await get(path, undefined, {
        DOCS_CACHE: {
          ...kv.binding,
          get: async (k: string) => {
            reads++;
            return kv.binding.get(k);
          },
        },
      });
      expect(res.status).toBe(400);
      expect(reads).toBe(0);
    },
  );

  it("re-validates what comes out of KV rather than trusting it", async () => {
    // A row that somehow holds an unknown kind must not reach a generator.
    const kv = fakeKv({
      [`share:${"c".repeat(32)}`]: JSON.stringify({ kind: "evil", args: {} }),
    });
    const res = await get(`/p/${"c".repeat(32)}`, undefined, {
      DOCS_CACHE: kv.binding,
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /share", () => {
  it("stores an oversized pattern and returns its /p/<id> URL", async () => {
    const kv = fakeKv();
    const code = `s("bd") // ${"x".repeat(4000)}`;
    const res = await get(
      "/share",
      {
        method: "POST",
        body: JSON.stringify({ kind: "play", args: { code } }),
      },
      { DOCS_CACHE: kv.binding },
    );

    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url).toMatch(new RegExp(`^${ORIGIN}/p/[0-9a-f]{32}$`));

    // Stored under the share: prefix with a 30-day TTL, in the existing
    // namespace. (`shares()` filters out the rate-limiter's own bucket, which
    // lives under ratelimit:share: in the same namespace.)
    expect(shares(kv)).toHaveLength(1);
    expect(shares(kv)[0]!.key).toBe(`share:${url.split("/p/")[1]}`);
    expect(shares(kv)[0]!.options?.expirationTtl).toBe(30 * 24 * 60 * 60);

    // ...and it renders.
    const page = await get(new URL(url).pathname, undefined, {
      DOCS_CACHE: kv.binding,
    });
    expect(strudelInit(await page.text()).code).toBe(code);
  });

  it("prefers the stateless query URL for a short pattern (no KV write)", async () => {
    const kv = fakeKv();
    const res = await get(
      "/share",
      { method: "POST", body: JSON.stringify({ kind: "play", args: { code: 's("bd")' } }) },
      { DOCS_CACHE: kv.binding },
    );
    const { url } = (await res.json()) as { url: string };
    expect(url).toContain("/play?c=");
    expect(shares(kv)).toHaveLength(0);
  });

  it("is content-addressed: posting twice rewrites one key", async () => {
    const kv = fakeKv();
    const body = JSON.stringify({
      kind: "score",
      args: { abcNotation: `X:1\nK:C\n${"CDEF|".repeat(600)}` },
    });
    const first = await get("/share", { method: "POST", body }, { DOCS_CACHE: kv.binding });
    const second = await get("/share", { method: "POST", body }, { DOCS_CACHE: kv.binding });
    expect((await first.json()).url).toBe((await second.json()).url);
    expect([...kv.store.keys()].filter((k) => k.startsWith("share:"))).toHaveLength(1);
  });

  it("drops fields the generators don't read instead of storing them", async () => {
    const kv = fakeKv();
    await get(
      "/share",
      {
        method: "POST",
        body: JSON.stringify({
          kind: "play",
          args: { code: `s("bd") // ${"x".repeat(4000)}`, sneaky: "<script>" },
        }),
      },
      { DOCS_CACHE: kv.binding },
    );
    expect(kv.puts[0]!.value).not.toContain("sneaky");
  });

  it.each([
    ["a non-POST verb", { method: "GET" }, 405],
    ["a body that isn't JSON", { method: "POST", body: "nope" }, 400],
    ["an unknown kind", { method: "POST", body: '{"kind":"evil","args":{}}' }, 400],
    ["a missing code field", { method: "POST", body: '{"kind":"play","args":{}}' }, 400],
    [
      "a non-string code",
      { method: "POST", body: '{"kind":"play","args":{"code":42}}' },
      400,
    ],
  ])("rejects %s", async (_name, init, status) => {
    const res = await get("/share", init as RequestInit, {
      DOCS_CACHE: fakeKv().binding,
    });
    expect(res.status).toBe(status);
  });

  it("413s a body past the size cap", async () => {
    const res = await get(
      "/share",
      {
        method: "POST",
        body: JSON.stringify({
          kind: "play",
          args: { code: "x".repeat(70 * 1024) },
        }),
      },
      { DOCS_CACHE: fakeKv().binding },
    );
    expect(res.status).toBe(413);
  });

  it("503s rather than 500s when the KV binding is missing", async () => {
    const res = await get("/share", {
      method: "POST",
      body: JSON.stringify({ kind: "play", args: { code: "x".repeat(4000) } }),
    });
    expect(res.status).toBe(503);
  });
});

describe("play tools → share link", () => {
  // The routes above are only half the feature: the tool handlers have to pick
  // between the two URL shapes, and fall back gracefully when KV isn't there.

  async function callPlayLive(code: string, env: unknown) {
    const client = new Client({ name: "share-test", version: "0.0.0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(c),
      createMusicServer(env as never, ORIGIN).connect(s),
    ]);
    const res = await client.callTool({
      name: "play-live-pattern",
      arguments: { code },
    });
    return res.content as { type: string; text?: string; uri?: string }[];
  }

  it("uses the stateless query URL for a short pattern", async () => {
    const kv = fakeKv();
    const content = await callPlayLive('s("bd sd")', { DOCS_CACHE: kv.binding });
    const link = content.find((c) => c.type === "resource_link");
    expect(link?.uri).toContain(`${ORIGIN}/play?c=`);
    expect(kv.puts).toHaveLength(0);
  });

  it("falls back to KV for a pattern too long for a URL, and that link renders", async () => {
    const kv = fakeKv();
    const code = `s("bd") // ${"x".repeat(4000)}`;
    const content = await callPlayLive(code, { DOCS_CACHE: kv.binding });

    const link = content.find((c) => c.type === "resource_link");
    expect(link?.uri).toMatch(new RegExp(`^${ORIGIN}/p/[0-9a-f]{32}$`));
    expect(kv.puts).toHaveLength(1);

    const page = await get(new URL(link!.uri!).pathname, undefined, {
      DOCS_CACHE: kv.binding,
    });
    expect(strudelInit(await page.text()).code).toBe(code);
  });

  it("omits the link (and keeps the honest wording) when KV is unavailable", async () => {
    const content = await callPlayLive(`s("bd") // ${"x".repeat(4000)}`, {});
    expect(content.some((c) => c.type === "resource_link")).toBe(false);
    expect(content[0]!.text).toContain("nothing has played yet");
  });

  it("survives a KV write failure without failing the tool call", async () => {
    const content = await callPlayLive(`s("bd") // ${"x".repeat(4000)}`, {
      DOCS_CACHE: {
        get: async () => null,
        put: async () => {
          throw new Error("KV is having a day");
        },
      },
    });
    // No link, but a perfectly good tool result.
    expect(content.some((c) => c.type === "resource_link")).toBe(false);
    expect(content[0]!.text).toContain("Strudel pattern ready");
  });
});

describe("unknown routes", () => {
  it.each(["/nope", "/mcp2", "/health/extra"])("%s 404s", async (p) => {
    const res = await get(p);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
  });
});
