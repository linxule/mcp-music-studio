import { afterEach, describe, expect, it, vi } from "vitest";
import {
  searchMusicDocs,
  SEARCH_DOCS_MAX_CHARS,
  SEARCH_DOCS_MAX_QUERY,
} from "../src/shared/tool-defs";

// Direct unit tests of the shared searchMusicDocs core (cache adapter + apiKey
// injected per transport). The existing search-docs.test.ts only covers the
// local server path (no cache, empty key); these cover the worker-shaped branches.

afterEach(() => vi.restoreAllMocks());

function textOf(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content[0]?.text ?? "";
}

describe("searchMusicDocs (shared core)", () => {
  it("returns the cached value without fetching when cacheGet hits", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await searchMusicDocs("anything", "strudel", {
      cacheGet: async () => "CACHED DOCS",
    });
    expect(textOf(result)).toBe("CACHED DOCS");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("retries once with Bearer auth on HTTP 429 when a ctx7sk key is present", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("AUTHED DOCS", { status: 200 }));

    const result = await searchMusicDocs("fm synthesis", "strudel", {
      apiKey: "ctx7sk-secret",
    });

    expect(textOf(result)).toContain("AUTHED DOCS");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const secondCallInit = fetchSpy.mock.calls[1]?.[1] as RequestInit | undefined;
    expect((secondCallInit?.headers as Record<string, string>)?.Authorization).toBe(
      "Bearer ctx7sk-secret",
    );
  });

  it("does NOT retry on 429 without a valid key (errors with the status)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }));

    const result = await searchMusicDocs("x", "strudel", {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("429");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("truncates oversized payloads and appends a truncation marker", async () => {
    const big = "a".repeat(SEARCH_DOCS_MAX_CHARS + 5000);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(big, { status: 200 }),
    );
    const result = await searchMusicDocs("big", "strudel", {});
    const text = textOf(result);
    expect(text.length).toBeLessThan(big.length);
    expect(text).toContain("results truncated");
  });

  it("caps the query at SEARCH_DOCS_MAX_QUERY code points before use", async () => {
    const cacheGet = vi.fn(async () => null);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("docs", { status: 200 }),
    );
    const longQuery = "q".repeat(SEARCH_DOCS_MAX_QUERY + 100);
    await searchMusicDocs(longQuery, "strudel", { cacheGet });
    const key = cacheGet.mock.calls[0]?.[0] as string;
    // key = `ctx7:strudel:<q>` where q is capped to SEARCH_DOCS_MAX_QUERY
    expect(key.length).toBe("ctx7:strudel:".length + SEARCH_DOCS_MAX_QUERY);
  });

  it("writes successful results to the cache adapter", async () => {
    const cachePut = vi.fn(async () => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("fresh docs", { status: 200 }),
    );
    await searchMusicDocs("note function", "abcjs", { cachePut });
    expect(cachePut).toHaveBeenCalledTimes(1);
    expect(cachePut.mock.calls[0]?.[1]).toContain("fresh docs");
  });
});
