import { describe, expect, it } from "vitest";
import { handlePlaySheetMusic } from "../server";
import type { ParseOnlyFn } from "../src/server-logic";

describe("play-sheet-music handler", () => {
  it("keeps warnings non-fatal", async () => {
    const parseOnly: ParseOnlyFn = () => [
      { warnings: ["<span>Measure overflow warning</span>"] },
    ];

    const result = await handlePlaySheetMusic(
      { abcNotation: "X:1\nK:C\nC |" },
      parseOnly,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain(
      "Parsed with warnings (will still play):",
    );
    expect(result.content[0]?.text).toContain("Measure overflow warning");
  });

  it("treats fatal parse errors as errors", async () => {
    const parseOnly: ParseOnlyFn = () => [
      { warnings: ["Error: Expected note after bar line"] },
    ];

    const result = await handlePlaySheetMusic(
      { abcNotation: "X:1\nK:C\n|" },
      parseOnly,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("ABC notation has errors:");
    expect(result.content[0]?.text).toContain(
      "Expected note after bar line",
    );
  });
});
