import { describe, expect, it } from "vitest";
import {
  buildSearchCacheKey,
  SEARCH_DOCS_MAX_QUERY,
  uiToolMeta,
} from "../src/shared/tool-defs";

// Workers KV rejects keys longer than 512 BYTES. The query is capped at 500 CODE
// POINTS, so a multibyte query overflowed the limit and every KV get/put threw —
// the cache was silently off for exactly the queries most worth caching.
const KV_MAX_KEY_BYTES = 512;

const bytes = (s: string) => new TextEncoder().encode(s).byteLength;

describe("buildSearchCacheKey", () => {
  it("produces a fixed-length ASCII key", async () => {
    const key = await buildSearchCacheKey("strudel", "fm synthesis");
    expect(key).toMatch(/^ctx7:strudel:[0-9a-f]{64}$/);
    expect(bytes(key)).toBe(key.length);
  });

  it("stays under KV's 512-byte key limit for a max-length multibyte query", async () => {
    for (const filler of ["q", "音", "🎹", "é"]) {
      const query = filler.repeat(SEARCH_DOCS_MAX_QUERY);
      const key = await buildSearchCacheKey("strudel", query);
      // Sanity: the raw key this replaces would have blown the limit for the
      // multibyte fillers.
      expect(bytes(key)).toBeLessThanOrEqual(KV_MAX_KEY_BYTES);
      expect(bytes(key)).toBe(bytes(await buildSearchCacheKey("strudel", "x")));
    }
  });

  it("is deterministic, and distinct per query and per library", async () => {
    const a = await buildSearchCacheKey("strudel", "reverb");
    const again = await buildSearchCacheKey("strudel", "reverb");
    const otherQuery = await buildSearchCacheKey("strudel", "delay");
    const otherLibrary = await buildSearchCacheKey("abcjs", "reverb");

    expect(again).toBe(a);
    expect(otherQuery).not.toBe(a);
    expect(otherLibrary).not.toBe(a);
  });

  it("does not collide on queries that differ only in a multibyte tail", async () => {
    const a = await buildSearchCacheKey("strudel", "swing 音");
    const b = await buildSearchCacheKey("strudel", "swing 韻");
    expect(a).not.toBe(b);
  });
});

describe("uiToolMeta", () => {
  it("emits both the nested and the legacy flat resourceUri spelling", () => {
    expect(uiToolMeta("ui://x/y.html")).toEqual({
      ui: { resourceUri: "ui://x/y.html" },
      "ui/resourceUri": "ui://x/y.html",
    });
  });

  it("returns a fresh object each call (callers spread it into tool configs)", () => {
    const a = uiToolMeta("ui://x/y.html");
    const b = uiToolMeta("ui://x/y.html");
    expect(a).not.toBe(b);
    expect(a.ui).not.toBe(b.ui);
  });
});
