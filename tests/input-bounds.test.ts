import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_HARMONY_ITEMS,
  MAX_SOURCE_CHARS,
  SEARCH_DOCS_MAX_BODY_BYTES,
  SEARCH_DOCS_MAX_QUERY,
  SEARCH_DOCS_TIMEOUT_MS,
  analyzeHarmonyInputSchema,
  convertAbcInputSchema,
  playLiveInputSchema,
  playSheetInputSchema,
  searchDocsInputSchema,
  searchMusicDocs,
  truncateCodePoints,
} from "../src/shared/tool-defs";

afterEach(() => vi.restoreAllMocks());

// =============================================================================
// Schema bounds
// =============================================================================
//
// Unbounded strings and arrays are the cheapest way to make a server do
// unbounded work: an oversized `abcNotation` is parsed, hashed, URL-encoded for
// the share link, and (on the worker) written to KV. Nothing below rejects a
// real piece of music — the caps are orders of magnitude above one.
describe("input bounds", () => {
  const OK_ABC = "X:1\nK:C\nCDEF|";

  it("accepts an ordinary score, pattern, query and chord list", () => {
    expect(playSheetInputSchema.safeParse({ abcNotation: OK_ABC }).success).toBe(
      true,
    );
    expect(playLiveInputSchema.safeParse({ code: 's("bd sd")' }).success).toBe(
      true,
    );
    expect(
      searchDocsInputSchema.safeParse({ query: "fm synthesis" }).success,
    ).toBe(true);
    expect(
      analyzeHarmonyInputSchema.safeParse({
        task: "detect-chord",
        notes: ["C", "E", "G"],
      }).success,
    ).toBe(true);
  });

  it("rejects an abcNotation past the size cap", () => {
    const huge = "C".repeat(MAX_SOURCE_CHARS + 1);
    expect(playSheetInputSchema.safeParse({ abcNotation: huge }).success).toBe(
      false,
    );
    expect(convertAbcInputSchema.safeParse({ abcNotation: huge }).success).toBe(
      false,
    );
    // ...and accepts one exactly at the cap.
    expect(
      playSheetInputSchema.safeParse({ abcNotation: "C".repeat(MAX_SOURCE_CHARS) })
        .success,
    ).toBe(true);
  });

  it("rejects a pattern past the size cap", () => {
    expect(
      playLiveInputSchema.safeParse({ code: "x".repeat(MAX_SOURCE_CHARS + 1) })
        .success,
    ).toBe(false);
  });

  it("rejects a query past SEARCH_DOCS_MAX_QUERY", () => {
    expect(
      searchDocsInputSchema.safeParse({
        query: "q".repeat(SEARCH_DOCS_MAX_QUERY + 1),
      }).success,
    ).toBe(false);
    expect(
      searchDocsInputSchema.safeParse({ query: "q".repeat(SEARCH_DOCS_MAX_QUERY) })
        .success,
    ).toBe(true);
  });

  it.each(["notes", "chords", "romanNumerals"] as const)(
    "rejects a %s list past MAX_HARMONY_ITEMS",
    (field) => {
      const tooMany = Array.from({ length: MAX_HARMONY_ITEMS + 1 }, () => "C");
      expect(
        analyzeHarmonyInputSchema.safeParse({ task: "detect-key", [field]: tooMany })
          .success,
      ).toBe(false);
      expect(
        analyzeHarmonyInputSchema.safeParse({
          task: "detect-key",
          [field]: tooMany.slice(0, MAX_HARMONY_ITEMS),
        }).success,
      ).toBe(true);
    },
  );
});

// =============================================================================
// Code-point truncation
// =============================================================================
describe("truncateCodePoints", () => {
  it("leaves a short string alone (same reference semantics, no copy needed)", () => {
    expect(truncateCodePoints("hello", 10)).toBe("hello");
    expect(truncateCodePoints("hello", 5)).toBe("hello");
  });

  it("cuts at the code-point boundary", () => {
    expect(truncateCodePoints("abcdef", 3)).toBe("abc");
    expect(truncateCodePoints("", 3)).toBe("");
    expect(truncateCodePoints("abc", 0)).toBe("");
  });

  // The reason this counts code points instead of UTF-16 units: a naive
  // slice(0, n) can cut a surrogate pair in half and produce a lone surrogate.
  it("never splits a surrogate pair", () => {
    const emoji = "🎹".repeat(10); // 10 code points, 20 UTF-16 units
    const cut = truncateCodePoints(emoji, 4);
    expect(cut).toBe("🎹🎹🎹🎹");
    expect(cut.length).toBe(8);
    expect([...cut]).toHaveLength(4);
    expect(cut.endsWith("🎹")).toBe(true);

    // Contrast: the naive UTF-16 slice leaves a lone high surrogate at the end.
    const naive = emoji.slice(0, 9);
    const strayUnit = naive.charCodeAt(naive.length - 1);
    expect(strayUnit).toBeGreaterThanOrEqual(0xd800);
    expect(strayUnit).toBeLessThanOrEqual(0xdbff);
  });

  it("handles a mixed BMP/astral string", () => {
    expect(truncateCodePoints("a🎹b🎹c", 3)).toBe("a🎹b");
  });
});

// =============================================================================
// Upstream fetch hardening
// =============================================================================
describe("searchMusicDocs upstream limits", () => {
  it("gives the upstream fetch a deadline", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("docs", { status: 200 }));
    await searchMusicDocs("anything", "strudel", {});
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(SEARCH_DOCS_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("keeps the deadline on the authenticated 429 retry", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("nope", { status: 429 }))
      .mockResolvedValueOnce(new Response("docs", { status: 200 }));
    await searchMusicDocs("x", "strudel", { apiKey: "ctx7sk-secret" });
    const retry = fetchSpy.mock.calls[1]?.[1] as RequestInit | undefined;
    expect(retry?.signal).toBeInstanceOf(AbortSignal);
  });

  it("surfaces a timeout as a tool error rather than hanging", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      Object.assign(new Error("The operation was aborted due to timeout"), {
        name: "TimeoutError",
      }),
    );
    const result = await searchMusicDocs("x", "strudel", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Documentation search error");
  });

  // `res.text()` buffered the whole upstream body before truncating it for the
  // model; a hostile or broken upstream could hand over far more than the
  // isolate should hold.
  it("stops reading the body at SEARCH_DOCS_MAX_BODY_BYTES", async () => {
    const chunk = new TextEncoder().encode("z".repeat(64 * 1024));
    let chunksServed = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Effectively endless: if the cap didn't work this never terminates.
        chunksServed++;
        if (chunksServed > 1000) controller.close();
        else controller.enqueue(chunk);
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(body, { status: 200 }),
    );

    const result = await searchMusicDocs("flood", "strudel", {});
    // Read at most the cap, and never the thousand chunks on offer.
    expect(chunksServed).toBeLessThanOrEqual(
      SEARCH_DOCS_MAX_BODY_BYTES / chunk.byteLength + 2,
    );
    // The model still only ever sees the SEARCH_DOCS_MAX_CHARS slice.
    expect(result.content[0]?.text).toContain("results truncated");
  });

  it("still reads a normal-sized body in full", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("setcps(0.5) — sets cycles per second", { status: 200 }),
    );
    const result = await searchMusicDocs("setcps", "strudel", {});
    expect(result.content[0]?.text).toContain("sets cycles per second");
  });

  it("decodes multi-byte characters across chunk boundaries", async () => {
    // "🎹" is 4 UTF-8 bytes; split it so the decoder must carry state between
    // reads. A per-chunk decode would emit replacement characters here.
    const bytes = new TextEncoder().encode("a🎹b");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 3));
        controller.enqueue(bytes.subarray(3));
        controller.close();
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(body, { status: 200 }),
    );
    const result = await searchMusicDocs("emoji", "strudel", {});
    expect(result.content[0]?.text).toBe("a🎹b");
  });
});
