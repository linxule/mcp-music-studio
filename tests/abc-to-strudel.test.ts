import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ABCJS from "abcjs";
import {
  convertAbcToStrudel,
  normalizeChordSymbol,
  type ParseOnlyFn,
} from "../src/shared/abc-to-strudel";
import { ABC_GUIDES } from "../src/abc-guide";
import { handleConvertAbcToStrudel } from "../server";

const parseOnly = ABCJS.parseOnly as unknown as ParseOnlyFn;

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "abc",
);

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), "utf-8");
}

function convert(abc: string, args: { voice?: number; sound?: string } = {}) {
  return convertAbcToStrudel({ abcNotation: abc, ...args }, parseOnly);
}

function ok(abc: string, args: { voice?: number; sound?: string } = {}) {
  const result = convert(abc, args);
  if (!result.ok) throw new Error(`expected a conversion, got: ${result.error}`);
  return result;
}

/**
 * Bar counts hand-counted from each fixture's ABC source (bar lines in the
 * chosen voice, pickup bars included). The converter must emit exactly one
 * mini-notation group per bar.
 */
const FIXTURE_BARS: Record<string, number> = {
  "01-simple-melody.abc": 2,
  "02-multiple-voices.abc": 2,
  "03-tuplets.abc": 2,
  "04-repeats-endings.abc": 3,
  "05-lyrics.abc": 2,
  "06-chords-style.abc": 4,
  "07-meter-change.abc": 3,
  "08-ties-slurs-accidentals.abc": 2,
  "09-grace-dynamics.abc": 2,
};

describe("convert-abc-to-strudel — fixtures", () => {
  it.each(Object.entries(FIXTURE_BARS))(
    "%s emits one bar group per bar (%i)",
    (name, bars) => {
      const result = ok(fixture(name));
      expect(result.bars).toHaveLength(bars);
      // every bar group is a balanced mini-notation bracket
      for (const bar of result.bars) {
        expect(bar.startsWith("[")).toBe(true);
        expect(bar.endsWith("]")).toBe(true);
        expect([...bar].filter((c) => c === "[").length).toBe(
          [...bar].filter((c) => c === "]").length,
        );
      }
      expect(result.code).toContain(`note("<${result.bars.join(" ")}>")`);
    },
  );

  it("errors cleanly on malformed ABC", () => {
    const result = convert(fixture("10-invalid-input.abc"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("ABC notation has errors");
    // abcjs's own diagnostics come through, HTML markup stripped
    expect(result.error).toContain("Expected");
    expect(result.error).not.toContain("<span");
  });
});

describe("convert-abc-to-strudel — hand-checked bars", () => {
  it("weights unequal durations with @ (fixture 01)", () => {
    const result = ok(fixture("01-simple-melody.abc"));
    // CDEF GABc — eight equal eighths, no weights needed
    expect(result.bars[0]).toBe("[c4 d4 e4 f4 g4 a4 b4 c5]");
    // cBAG E2 C2 — four eighths then two quarters
    expect(result.bars[1]).toBe("[c5 b4 a4 g4 e4@2 c4@2]");
    expect(result.code).toContain("setcps(96/60/4)");
  });

  it("nests a triplet in its own sub-bracket (fixture 03)", () => {
    const result = ok(fixture("03-tuplets.abc"));
    // (3CDE F2 G2 A2 — the triplet occupies one quarter of the bar
    expect(result.bars[0]).toBe("[[c4 d4 e4] f4 g4 a4]");
    expect(result.bars[1]).toBe("[[b4 c5 d5] c5 g4@2]");
  });

  it("folds a tie into the note it continues (fixture 08)", () => {
    const result = ok(fixture("08-ties-slurs-accidentals.abc"));
    // (^F G A B) c2-c2 — the tied c is one four-eighth event, not two
    expect(result.bars[0]).toBe("[f#4 g4 a4 b4 c5@4]");
    // =F2 _B2 E2 C2 — explicit natural and flat survive
    expect(result.bars[1]).toBe("[f4 bb4 e4 c4]");
    expect(result.dropped).toHaveLength(0);
  });

  it("groups a 6/8 bar as two groups of three (fixture 07)", () => {
    const result = ok(fixture("07-meter-change.abc"));
    expect(result.bars[2]).toBe("[[g4 a4 b4] [c5@2 g4]]");
    expect(result.dropped).toContain("meter changes (every bar becomes one cycle)");
  });
});

describe("convert-abc-to-strudel — musical detail", () => {
  it("applies the key signature to unmarked notes", () => {
    // K:D — every written F and C sounds sharp
    const result = ok("X:1\nM:4/4\nL:1/4\nK:D\nF C d f |]\n");
    expect(result.bars[0]).toBe("[f#4 c#4 d5 f#5]");
  });

  it("carries an explicit accidental through the rest of its bar only", () => {
    const result = ok("X:1\nM:4/4\nL:1/4\nK:C\n^F F G F | F2 z2 |]\n");
    expect(result.bars[0]).toBe("[f#4 f#4 g4 f#4]");
    expect(result.bars[1]).toBe("[f4 ~]"); // both halves — equal weights need no @
  });

  it("maps ABC octaves onto Strudel octaves", () => {
    // C, = c3, C = c4, c = c5, c' = c6
    const result = ok("X:1\nM:4/4\nL:1/4\nK:C\nC, C c c' |]\n");
    expect(result.bars[0]).toBe("[c3 c4 c5 c6]");
  });

  it("renders a written chord as a stacked step", () => {
    const result = ok("X:1\nM:4/4\nL:1/1\nK:C\n[CEG] |]\n");
    expect(result.bars[0]).toBe("[[c4,e4,g4]]");
  });

  it("renders rests as ~", () => {
    const result = ok("X:1\nM:4/4\nL:1/4\nK:C\nC z E z |]\n");
    expect(result.bars[0]).toBe("[c4 ~ e4 ~]");
  });

  it("emits a chord line only when the ABC has chord symbols", () => {
    const withChords = ok(fixture("06-chords-style.abc"));
    expect(withChords.chords).toEqual(["C", "Am", "F", "G"]);
    expect(withChords.code).toContain('chord("<C Am F G>").voicing().s("gm_epiano1")');

    const without = ok(fixture("01-simple-melody.abc"));
    expect(without.code).not.toContain("chord(");
  });

  it("carries the last chord forward through bars that have none", () => {
    const result = ok('X:1\nM:4/4\nL:1/4\nK:C\n"C"C E G c | c G E C | "F"F A c f |]\n');
    expect(result.chords).toEqual(["C", "C", "F"]);
  });

  it("converts abcjs's typographic accidentals back to ASCII", () => {
    expect(normalizeChordSymbol("B♭maj7")).toBe("Bbmaj7");
    expect(normalizeChordSymbol("F♯m7")).toBe("F#m7");
    expect(normalizeChordSymbol("C△")).toBe("Cmaj7");
    const result = ok('X:1\nM:4/4\nL:1/4\nK:Bb\n"Bbmaj7"d f d B |]\n');
    expect(result.chords[0]).toBe("Bbmaj7");
  });

  it("derives cps from Q: and the bar length, not a fixed 4 beats", () => {
    expect(ok("X:1\nM:4/4\nL:1/4\nQ:1/4=96\nK:C\nC D E F|]\n").code).toContain(
      "setcps(96/60/4)",
    );
    expect(ok("X:1\nM:3/4\nL:1/4\nQ:1/4=120\nK:C\nC D E|]\n").code).toContain(
      "setcps(120/60/3)",
    );
    // Q:1/2=60 is a half-note pulse — 120 quarter-note bpm
    expect(ok("X:1\nM:4/4\nL:1/4\nQ:1/2=60\nK:C\nC D E F|]\n").code).toContain(
      "setcps(120/60/4)",
    );
  });

  it("omits setcps when the ABC has no Q:", () => {
    expect(ok(fixture("05-lyrics.abc")).code).not.toContain("setcps");
  });

  it("honours the sound parameter", () => {
    expect(ok(fixture("01-simple-melody.abc")).code).toContain('.s("gm_piano")');
    expect(ok(fixture("01-simple-melody.abc"), { sound: "gm_flute" }).code).toContain(
      '.s("gm_flute")',
    );
  });
});

describe("convert-abc-to-strudel — voices", () => {
  it("defaults to voice 1 and reports the others", () => {
    const result = ok(fixture("02-multiple-voices.abc"));
    expect(result.voiceCount).toBe(2);
    expect(result.bars[0]).toBe("[c4 e4 g4 c5]");
    expect(result.dropped.join(" ")).toContain("1 other voice");
  });

  it("converts the requested voice", () => {
    const bass = ok(fixture("02-multiple-voices.abc"), { voice: 2 });
    expect(bass.bars).toEqual(["[c3 g3]", "[g3 c3]"]);
  });

  it("counts voices across staves", () => {
    // the Minuet puts each voice on its own staff
    const abc = genreTemplate("Classical Minuet");
    expect(ok(abc).voiceCount).toBe(2);
    expect(ok(abc, { voice: 2 }).bars).toHaveLength(9);
  });

  it("refuses a voice that does not exist", () => {
    const result = convert(fixture("01-simple-melody.abc"), { voice: 4 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Voice 4 not found");
  });
});

describe("convert-abc-to-strudel — lossiness reporting", () => {
  it("says so when nothing was lost", () => {
    const result = ok(fixture("01-simple-melody.abc"));
    expect(result.dropped).toEqual([]);
    expect(result.text).toContain("Lossless for this tune.");
  });

  it("names grace notes and dynamics", () => {
    const result = ok(fixture("09-grace-dynamics.abc"));
    expect(result.dropped).toContain("grace notes");
    expect(result.dropped).toContain("dynamics and ornaments");
    expect(result.text).toContain("Dropped:");
  });

  it("names lyrics and repeats", () => {
    expect(ok(fixture("05-lyrics.abc")).dropped).toContain("lyrics");
    expect(ok(fixture("04-repeats-endings.abc")).dropped.join(" ")).toContain(
      "repeats and alternate endings",
    );
  });

  it("flags a pickup bar", () => {
    const result = ok(genreTemplate("Classical Minuet"));
    expect(result.dropped).toContain("pickup bar is stretched to a full cycle");
  });
});

describe("convert-abc-to-strudel — bad input", () => {
  it("rejects an empty string", () => {
    const result = convert("   ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("No ABC notation");
  });

  it("rejects ABC with a header but no music", () => {
    const result = convert("X:1\nT:Empty\nM:4/4\nK:C\n");
    expect(result.ok).toBe(false);
  });

  it("survives a parser that throws", () => {
    const result = convertAbcToStrudel(
      { abcNotation: "X:1\nK:C\nC|]" },
      () => {
        throw new Error("boom");
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("boom");
  });
});

// -----------------------------------------------------------------------------
// Round-trip every ABC template shipped in the guide's `genres` topic
// -----------------------------------------------------------------------------

function genreTemplates(): { name: string; abc: string }[] {
  return ABC_GUIDES.genres
    .split(/\n## /)
    .slice(1)
    .map((block) => ({
      name: block.split("\n")[0]!.trim(),
      abc: `X:${block.split("\nX:")[1] ?? ""}`,
    }))
    .filter((t) => t.abc.length > 3);
}

function genreTemplate(name: string): string {
  const found = genreTemplates().find((t) => t.name === name);
  if (!found) throw new Error(`no genre template named ${name}`);
  return found.abc;
}

/** Bar counts hand-counted from the guide's ABC sources (voice 1). */
const GENRE_BARS: Record<string, number> = {
  "Jazz Standard": 8,
  "12-Bar Blues": 12,
  "Folk Song": 8,
  "Classical Minuet": 9, // 8 bars plus a one-note pickup
  Rock: 8,
  "Bossa Nova": 8,
  Lullaby: 8,
};

describe("convert-abc-to-strudel — guide genre templates", () => {
  it("finds all seven templates", () => {
    expect(genreTemplates().map((t) => t.name)).toEqual(Object.keys(GENRE_BARS));
  });

  it.each(Object.entries(GENRE_BARS))("%s round-trips to %i bars", (name, bars) => {
    const result = ok(genreTemplate(name));
    expect(result.bars).toHaveLength(bars);
    expect(result.chords).toHaveLength(bars);
    // guide templates all carry chord symbols and a Q: tempo
    expect(result.code).toContain("setcps(");
    expect(result.code).toContain("chord(");
    // no unresolved accidental glyphs leak into the Strudel code
    expect(result.code).not.toMatch(/[♭♯♮]/);
  });

  it("keeps the jazz template's flat spellings", () => {
    const result = ok(genreTemplate("Jazz Standard"));
    expect(result.chords[0]).toBe("Bbmaj7");
    expect(result.bars[0]).toBe("[d5@2 f5@2 d5@2 bb4 c5]");
  });
});

describe("convert-abc-to-strudel handler", () => {
  it("returns the code as text", async () => {
    const result = await handleConvertAbcToStrudel({
      abcNotation: fixture("06-chords-style.abc"),
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('note("<');
    expect(result.content[0]?.text).toContain("play-live-pattern");
  });

  it("returns isError with the parser's message on bad ABC", async () => {
    const result = await handleConvertAbcToStrudel({
      abcNotation: fixture("10-invalid-input.abc"),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("ABC notation has errors");
    expect(result.content[0]?.text).toContain("get-music-guide");
  });
});
