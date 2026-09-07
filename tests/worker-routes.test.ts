import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { WIDGET_BUILD } from "../worker/src/index";
import { VERSION } from "../src/version";

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

const get = (path: string, init?: RequestInit) =>
  worker.fetch(
    new Request(`https://mcp-music-studio.linxule.workers.dev${path}`, init),
    ENV,
    CTX,
  );

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

describe("unknown routes", () => {
  it.each(["/nope", "/mcp2", "/health/extra"])("%s 404s", async (p) => {
    const res = await get(p);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
  });
});
