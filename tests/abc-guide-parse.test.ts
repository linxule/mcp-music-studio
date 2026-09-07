/**
 * @file Every ABC example the guide shows an agent must actually parse.
 *
 * The guide is the agent's only reference for play-sheet-music, so an example
 * that abcjs rejects is a defect the agent inherits. This walks every X:-block
 * in ABC_GUIDES through ABCJS.parseOnly and requires zero fatal warnings, and
 * does the same for each STYLE preset applied to the default notation (which
 * is what the tool renders when no `abc` argument is given).
 *
 * "Fatal" uses the project's own forgiving rule from src/server-logic.ts:
 * a warning counts only when it mentions "Expected", "Unknown" or "Error".
 */
import { describe, expect, it } from "vitest";
import ABCJS from "abcjs";
import type { TuneObject } from "abcjs";
import { ABC_GUIDES, DEFAULT_ABC_NOTATION } from "../src/abc-guide";
import { STYLE_PRESETS, applyStyleToAbc } from "../src/music-logic";

function fatalWarnings(tune: TuneObject): string[] {
  const warnings = (tune as unknown as { warnings?: string[] }).warnings ?? [];
  return warnings
    .map((w) => String(w).replace(/<[^>]*>/g, ""))
    .filter((m) => m.includes("Expected") || m.includes("Unknown") || m.includes("Error"));
}

/**
 * Split a guide topic into ABC tunes: a tune starts at an `X:` line and runs
 * until a line that is clearly prose again (a markdown heading or a blank line
 * followed by prose). Guide tunes are contiguous blocks, so a blank line ends
 * the tune.
 */
function extractTunes(text: string): string[] {
  const tunes: string[] = [];
  const lines = text.split("\n");
  let current: string[] | null = null;
  for (const line of lines) {
    if (/^X:\s*\d/.test(line)) {
      if (current) tunes.push(current.join("\n"));
      current = [line];
      continue;
    }
    if (current === null) continue;
    if (line.trim() === "" || line.startsWith("#")) {
      tunes.push(current.join("\n"));
      current = null;
      continue;
    }
    current.push(line);
  }
  if (current) tunes.push(current.join("\n"));
  return tunes;
}

interface GuideTune {
  readonly topic: string;
  readonly index: number;
  readonly abc: string;
  /** false for the header-only skeleton in the abc-syntax topic. */
  readonly hasBody: boolean;
}

const bodyAfterKey = (abc: string) => {
  const lines = abc.split("\n");
  const key = lines.findIndex((l) => /^K:/.test(l));
  return key >= 0 && lines.slice(key + 1).some((l) => l.trim() !== "");
};

const guideTunes: GuideTune[] = Object.entries(ABC_GUIDES).flatMap(([topic, text]) =>
  extractTunes(text).map((abc, index) => ({ topic, index, abc, hasBody: bodyAfterKey(abc) })),
);

describe("ABC guide examples parse", () => {
  it("finds the tunes in the guide", () => {
    expect(guideTunes.length).toBeGreaterThanOrEqual(8);
    // Every topic that shows a full tune should contribute at least one.
    expect(guideTunes.some((t) => t.topic === "genres")).toBe(true);
  });

  it("finds at least eight tunes with an actual body", () => {
    expect(guideTunes.filter((t) => t.hasBody).length).toBeGreaterThanOrEqual(8);
  });

  it.each(guideTunes.map((t) => [`${t.topic}#${t.index}`, t.abc, t.hasBody] as const))(
    "%s parses with no fatal warnings",
    (_label, abc, hasBody) => {
      const tunes = ABCJS.parseOnly(abc);
      expect(tunes).toHaveLength(1);
      const tune = tunes[0];
      if (hasBody) expect(tune.lines?.length ?? 0).toBeGreaterThanOrEqual(1);
      expect(fatalWarnings(tune)).toEqual([]);
    },
  );
});

describe("style presets applied to the default notation", () => {
  const styles = Object.keys(STYLE_PRESETS);

  it("covers every preset", () => {
    expect(styles.length).toBeGreaterThanOrEqual(5);
  });

  it("the default notation parses on its own", () => {
    const tune = ABCJS.parseOnly(DEFAULT_ABC_NOTATION)[0];
    expect(fatalWarnings(tune)).toEqual([]);
  });

  it.each(styles)("%s parses cleanly on top of the default notation", (style) => {
    const styled = applyStyleToAbc(DEFAULT_ABC_NOTATION, style);
    const tunes = ABCJS.parseOnly(styled);
    expect(tunes).toHaveLength(1);
    expect(fatalWarnings(tunes[0])).toEqual([]);
  });

  it("inserts the style directives immediately AFTER the K: line", () => {
    // The guide's `styles` topic tells agents that only %%MIDI directives they
    // place after K: override the style. That is only true because of this.
    const styled = applyStyleToAbc(DEFAULT_ABC_NOTATION, styles[0]).split("\n");
    const keyLine = styled.findIndex((l) => l.startsWith("K:"));
    expect(keyLine).toBeGreaterThanOrEqual(0);
    expect(styled[keyLine + 1]).toMatch(/^%%MIDI /);
    expect(ABC_GUIDES.styles).toContain("AFTER the K: line");
  });
});

describe("ABC guide does not teach directives abcjs cannot parse", () => {
  it("never presents %%MIDI drumintro as real", () => {
    // abcjs has no `drumintro` directive at all — drumIntro is a synth option.
    for (const [topic, text] of Object.entries(ABC_GUIDES)) {
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (/^%%MIDI\s+drumintro\b/i.test(trimmed)) {
          throw new Error(`${topic} still shows a %%MIDI drumintro directive: ${trimmed}`);
        }
      }
    }
    expect(ABC_GUIDES.drums).toContain("drumIntro parameter");
  });

  it("does not claim the tool applies panning", () => {
    const all = Object.values(ABC_GUIDES).join("\n");
    expect(all).not.toContain("applies panning automatically");
  });
});
