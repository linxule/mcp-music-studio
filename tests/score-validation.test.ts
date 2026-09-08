import ABCJS from "abcjs";
import { describe, expect, it } from "vitest";
import {
  LOCAL_RENDER_MODE_HINT,
  createPlaySheetMusicResult,
  type ParseOnlyFn,
} from "../src/server-logic";

// Everything here runs the REAL abcjs parser: the point of these cases is what
// abcjs actually returns for degenerate input, which a stub can only guess at.
const play = (
  abcNotation: string,
  options?: { hint?: string; instrument?: string },
) =>
  createPlaySheetMusicResult(
    { abcNotation, instrument: options?.instrument },
    ABCJS.parseOnly as ParseOnlyFn,
    options?.hint === undefined ? undefined : { hint: options.hint },
  );

const textOf = (result: { content: Array<{ text?: string }> }) =>
  result.content[0]?.text ?? "";

describe("empty material is not 'ready'", () => {
  // abcjs parses all of these WITHOUT a single warning, so the old
  // warnings-only check reported an empty stave as sheet music that was ready.
  it.each([
    ["header with no tune body", "X:1\nT:Nothing\nK:C\n"],
    ["bar lines and nothing else", "X:1\nK:C\n||||"],
    ["an empty string", ""],
  ])("rejects %s", (_label, abc) => {
    const result = play(abc);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("no notes or rests");
  });

  it("accepts a score made only of rests — silence is still notation", () => {
    const result = play("X:1\nK:C\nzzzz|");
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("Sheet music ready");
  });

  it("accepts an ordinary tune", () => {
    const result = play("X:1\nK:C\nCDEF|");
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("Sheet music ready");
  });

  // Callers inject a stub parser (tests, and the convert path); a stub that
  // models only `warnings` must not be read as "this tune is empty".
  it("stays silent when the injected parser reports no structure at all", () => {
    const stub: ParseOnlyFn = () => [{}];
    const result = createPlaySheetMusicResult(
      { abcNotation: "X:1\nK:C\nCDEF|" },
      stub,
    );
    expect(result.isError).toBeUndefined();
  });
});

describe("multi-tune ABC says so", () => {
  const TWO_TUNES = "X:1\nK:C\nCDEF|\n\nX:2\nK:G\nGABc|";

  it("reports the count and that only the first is rendered", () => {
    const text = textOf(play(TWO_TUNES));
    expect(text).toContain("2 tunes found");
    expect(text).toContain("only the first is rendered");
  });

  it("says nothing for the ordinary single tune", () => {
    expect(textOf(play("X:1\nK:C\nCDEF|"))).not.toContain("tunes found");
  });

  it("reports it on the warning path too", () => {
    const stub: ParseOnlyFn = () => [
      { warnings: ["Measure overflow"], lines: [] },
      { lines: [] },
    ];
    const text = textOf(
      createPlaySheetMusicResult({ abcNotation: "x" }, stub),
    );
    expect(text).toContain("2 tunes found");
  });
});

describe("playback wording is conditional", () => {
  it("does not promise the score will play on the warning path", () => {
    const stub: ParseOnlyFn = () => [{ warnings: ["Measure overflow"] }];
    const text = textOf(createPlaySheetMusicResult({ abcNotation: "x" }, stub));
    expect(text).toContain("renders in MCP-app hosts");
    expect(text).not.toContain("will still play");
  });
});

describe("the trailing hint is the caller's", () => {
  it("defaults to the local server's --render-mode tip", () => {
    expect(textOf(play("X:1\nK:C\nCDEF|"))).toContain(LOCAL_RENDER_MODE_HINT);
  });

  it("can be dropped entirely — the worker has no such flag", () => {
    expect(textOf(play("X:1\nK:C\nCDEF|", { hint: "" }))).not.toContain(
      "--render-mode",
    );
  });
});
