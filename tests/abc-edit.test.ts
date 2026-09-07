import { describe, expect, it } from "vitest";
import {
  cleanAbcWarnings,
  describeAbc,
  editContextText,
  hasFatalAbcWarning,
} from "../src/abc-edit";
import { applyStyleToAbc } from "../src/music-logic";

const ONE_VOICE = `X:1
T:Harness Tune
M:4/4
L:1/8
K:G
"G"G2 B2 d2 B2 | "C"c2 e2 "D"d4 | "G"B2 d2 g2 d2 | "D"A2 F2 "G"G4 |]`;

const TWO_VOICE = `X:1
T:Two-Voice Invention
M:4/4
L:1/8
K:C
V:1 clef=treble
V:2 clef=bass
[V:1] "C"c2 e2 g2 e2 | "F"f2 a2 "G"g2 f2 |]
[V:2] "C"C,2 G,2 E,2 G,2 | "F"F,2 C2 "G"G,2 B,2 |]`;

describe("cleanAbcWarnings", () => {
  it("strips the HTML abcjs wraps warnings in", () => {
    expect(
      cleanAbcWarnings([
        '<span class="abcjs-warning">Unknown symbol: q</span>',
        "  ",
      ]),
    ).toEqual(["Unknown symbol: q"]);
  });

  it("tolerates a missing warnings array", () => {
    expect(cleanAbcWarnings(undefined)).toEqual([]);
    expect(cleanAbcWarnings(null)).toEqual([]);
  });
});

describe("hasFatalAbcWarning", () => {
  // Mirrors the server's forgiving rule in src/server-logic.ts.
  it("treats Expected/Unknown/Error as fatal", () => {
    expect(hasFatalAbcWarning(["Expected a note"])).toBe(true);
    expect(hasFatalAbcWarning(["Unknown symbol: q"])).toBe(true);
    expect(hasFatalAbcWarning(["Error parsing"])).toBe(true);
  });

  it("lets everything else render", () => {
    expect(hasFatalAbcWarning([])).toBe(false);
    expect(
      hasFatalAbcWarning(["Music line ended without a barline"]),
    ).toBe(false);
  });
});

describe("describeAbc", () => {
  it("reads the key from the first K: header", () => {
    expect(describeAbc(ONE_VOICE).key).toBe("G");
    expect(describeAbc("X:1\nK:D dorian\nA B c d |").key).toBe("D dorian");
  });

  it("returns a null key for headerless text", () => {
    expect(describeAbc("just words").key).toBeNull();
  });

  it("counts bars in a single-voice tune", () => {
    expect(describeAbc(ONE_VOICE).bars).toBe(4);
  });

  it("counts bars per voice rather than summing them", () => {
    // Two voices of two bars each — the tune is two bars long, not four.
    expect(describeAbc(TWO_VOICE).bars).toBe(2);
  });

  it("counts a measure split across a line break only once", () => {
    const wrapped = `X:1\nK:C\nC D E F |\nG A B c |\n`;
    const split = `X:1\nK:C\nC D\nE F |\nG A B c |\n`;
    expect(describeAbc(wrapped).bars).toBe(2);
    expect(describeAbc(split).bars).toBe(2);
  });

  it("ignores chord symbols, comments, directives and inline fields", () => {
    const noisy = `X:1
% a comment
%%MIDI program 73
K:C
"Cmaj7"C D E F | [K:G] "G7"G A B c | % trailing note
`;
    expect(describeAbc(noisy).bars).toBe(2);
  });

  it("counts repeats and double barlines as single barlines", () => {
    expect(describeAbc("X:1\nK:C\n|: C D E F :| G A B c ||").bars).toBe(2);
  });

  it("counts a bar of rests", () => {
    expect(describeAbc("X:1\nK:C\nC D E F | z4 |").bars).toBe(2);
  });

  it("reports zero bars for a header-only stub", () => {
    expect(describeAbc("X:1\nT:Nothing yet\nK:C\n").bars).toBe(0);
  });
});

describe("editContextText", () => {
  it("names the bar count and key", () => {
    const text = editContextText(ONE_VOICE);
    expect(text).toContain("user edited the ABC");
    expect(text).toContain("4 bars");
    expect(text).toContain("key G");
  });

  it("singularises a one-bar edit and omits an absent key", () => {
    expect(editContextText("C D E F |")).toContain("(0 bars)");
    expect(editContextText("X:1\nK:C\nC D E F |")).toContain("(1 bar, key C)");
  });
});

describe("raw vs. effective ABC", () => {
  // The reason the editor can show state.currentAbc verbatim: the style preset
  // is derived from the raw text at render time and never written back into it.
  it("style injection is additive and leaves the raw text intact", () => {
    const effective = applyStyleToAbc(ONE_VOICE, "folk");
    expect(effective).not.toBe(ONE_VOICE);
    expect(effective).toContain("%%MIDI");
    // Every raw line survives, in order, with the directives inserted after K:.
    const rawLines = ONE_VOICE.split("\n");
    const kept = effective
      .split("\n")
      .filter((line) => !line.startsWith("%%MIDI"));
    expect(kept).toEqual(rawLines);
  });

  it("is a no-op without a style, so the editor text is the score", () => {
    expect(applyStyleToAbc(ONE_VOICE, "")).toBe(ONE_VOICE);
  });

  it("does not change the bar count or key it reports", () => {
    expect(describeAbc(applyStyleToAbc(ONE_VOICE, "folk"))).toEqual(
      describeAbc(ONE_VOICE),
    );
  });
});
