import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  NO_INLINE_PLAYER_TAIL,
  NO_INLINE_PLAYER_TAIL_WITH_LINK,
  PLAY_LINK_NAME,
  PLAY_LINK_PREFIX,
  attachPlayLink,
} from "../src/shared/tool-defs";
import { createPlaySheetMusicResult, type ParseOnlyFn } from "../src/server-logic";

// =============================================================================
// attachPlayLink — the "Tier 3" click-to-play link
// =============================================================================

const URL = "https://mcp-music-studio.linxule.workers.dev/play?c=abc";

const textBlocks = (result: CallToolResult) =>
  result.content.filter((b) => b.type === "text") as { text: string }[];

const linkBlocks = (result: CallToolResult) =>
  result.content.filter((b) => b.type === "resource_link") as {
    uri: string;
    name: string;
    mimeType?: string;
  }[];

const withTail = (): CallToolResult => ({
  content: [{ type: "text", text: `Ready. ${NO_INLINE_PLAYER_TAIL}` }],
});

const withoutTail = (): CallToolResult => ({
  content: [{ type: "text", text: "Parsed with warnings:\nsomething odd" }],
});

describe("attachPlayLink — the swap landed", () => {
  it("rewrites the honest tail and appends the link inside the same block", () => {
    const result = attachPlayLink(withTail(), URL);
    const [text] = textBlocks(result);

    expect(text!.text).toContain(NO_INLINE_PLAYER_TAIL_WITH_LINK);
    expect(text!.text).not.toContain(NO_INLINE_PLAYER_TAIL);
    expect(text!.text).toContain(`${PLAY_LINK_PREFIX}${URL}`);
    // One text block in, one text block out — no extra prose is invented.
    expect(textBlocks(result)).toHaveLength(1);
    expect(linkBlocks(result)).toEqual([
      { type: "resource_link", uri: URL, name: PLAY_LINK_NAME, mimeType: "text/html" },
    ]);
  });

  it("swaps only the first tail, so a two-block result gets one link line", () => {
    const two: CallToolResult = {
      content: [
        { type: "text", text: `A. ${NO_INLINE_PLAYER_TAIL}` },
        { type: "text", text: `B. ${NO_INLINE_PLAYER_TAIL}` },
      ],
    };
    const result = attachPlayLink(two, URL);
    const joined = textBlocks(result)
      .map((b) => b.text)
      .join("\n");

    expect(joined.match(new RegExp(PLAY_LINK_PREFIX, "g"))).toHaveLength(1);
    expect(joined).toContain(`B. ${NO_INLINE_PLAYER_TAIL}`);
  });
});

describe("attachPlayLink — no tail to swap", () => {
  // Regression: the resource_link used to be appended on its own, so a result
  // whose prose never mentions a link ended in a bare link block.
  it("introduces the link in text before appending the resource_link", () => {
    const result = attachPlayLink(withoutTail(), URL);
    const texts = textBlocks(result);

    expect(texts).toHaveLength(2);
    expect(texts[0]!.text).toBe("Parsed with warnings:\nsomething odd");
    expect(texts[1]!.text).toBe(`${PLAY_LINK_PREFIX}${URL}`);
    expect(linkBlocks(result)).toHaveLength(1);
  });

  it("never emits a resource_link that no text block names", () => {
    for (const result of [attachPlayLink(withTail(), URL), attachPlayLink(withoutTail(), URL)]) {
      const links = linkBlocks(result);
      const prose = textBlocks(result)
        .map((b) => b.text)
        .join("\n");
      for (const link of links) expect(prose).toContain(link.uri);
    }
  });
});

describe("attachPlayLink — no-ops", () => {
  it("returns the result untouched when there is no URL", () => {
    const original = withTail();
    expect(attachPlayLink(original, null)).toBe(original);
    expect(attachPlayLink(original, undefined)).toBe(original);
    expect(attachPlayLink(original, "")).toBe(original);
  });

  it("skips errors unless keepOnError says otherwise", () => {
    const failed: CallToolResult = {
      isError: true,
      content: [{ type: "text", text: `Broken. ${NO_INLINE_PLAYER_TAIL}` }],
    };
    expect(attachPlayLink(failed, URL)).toBe(failed);
    expect(linkBlocks(attachPlayLink(failed, URL, { keepOnError: true }))).toHaveLength(1);
  });
});

describe("attachPlayLink over the real sheet-music results", () => {
  // The branch that produced the bare link: ABC that parses with a NON-fatal
  // warning. "Measure overflow" carries none of the fatal markers
  // ("Expected"/"Unknown"/"Error"), so the score still renders — and that branch
  // ends without the honest tail.
  const warnedParse: ParseOnlyFn = () => [{ warnings: ["Measure overflow"] }];
  const CLEAN_ABC = "X:1\nT:Clean\nM:4/4\nK:C\nCDEF|\n";

  it("names the link in prose on the warnings branch (which has no tail)", () => {
    const warned = createPlaySheetMusicResult({ abcNotation: "x" }, warnedParse);
    expect(warned.isError).toBeUndefined();
    expect(textBlocks(warned)[0]!.text).not.toContain(NO_INLINE_PLAYER_TAIL);

    const linked = attachPlayLink(warned, URL);
    const prose = textBlocks(linked)
      .map((b) => b.text)
      .join("\n");
    expect(prose).toContain(`${PLAY_LINK_PREFIX}${URL}`);
    expect(linkBlocks(linked)).toHaveLength(1);
  });

  it("uses the in-place swap on the clean branch", () => {
    const clean = createPlaySheetMusicResult({ abcNotation: CLEAN_ABC });
    const linked = attachPlayLink(clean, URL);

    expect(textBlocks(linked)).toHaveLength(1);
    expect(textBlocks(linked)[0]!.text).toContain(NO_INLINE_PLAYER_TAIL_WITH_LINK);
  });
});
