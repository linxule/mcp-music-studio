import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ABCJS from "abcjs";
import {
  convertAbcToStrudel,
  GM_PROGRAM_SOUNDS,
  normalizeChordSymbol,
  soundForProgram,
  type ParseOnlyFn,
} from "../src/shared/abc-to-strudel";
import { IREAL_VOICING_SUFFIXES } from "../src/shared/harmony";
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

  // play-live-pattern's `bpm` parameter rewrites setcps as bpm/60/4. That is
  // right only for a four-quarter bar, so an agent that converts a 6/8 tune and
  // then passes bpm silently retimes it by 4/3.
  describe("the tempo note warns off play-live-pattern's bpm", () => {
    it("names the bar length for a compound meter", () => {
      const result = ok("X:1\nM:6/8\nL:1/8\nQ:3/8=60\nK:C\nCDE FGA|]\n");
      expect(result.code).toContain("setcps(90/60/3)");
      expect(result.text).toContain("Tempo is already set");
      expect(result.text).toContain("don't pass `bpm` for this pattern");
      expect(result.text).toContain("its bar is 3 quarter-notes, not 4");
    });

    it("names the bar length for 3/4 as well", () => {
      const result = ok("X:1\nM:3/4\nL:1/4\nQ:1/4=120\nK:C\nC D E|]\n");
      expect(result.text).toContain("its bar is 3 quarter-notes, not 4");
    });

    it("still warns in 4/4, without the misleading 'not 4'", () => {
      const result = ok("X:1\nM:4/4\nL:1/4\nQ:1/4=96\nK:C\nC D E F|]\n");
      expect(result.text).toContain("don't pass `bpm` for this pattern");
      expect(result.text).not.toContain("not 4");
    });

    it("says nothing when the tune sets no tempo", () => {
      expect(ok(fixture("05-lyrics.abc")).text).not.toContain("Tempo is already set");
    });
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

  // Regression: the chosen voice used to be recomputed per system by POSITION.
  // A later system with fewer voices made the lookup null and every bar of that
  // system vanished — no rests, no mention in `dropped`, no error.
  describe("a system that omits a voice", () => {
    // Two systems: the second re-opens V:1 only, so V:2 is silent there.
    const TWO_SYSTEMS = `X:1
T:Uneven Systems
M:4/4
L:1/4
K:C
V:1
C D E F | G A B c |
V:2
C,4 | G,4 |
V:1
c B A G | F E D C |
`;

    it("keeps the present voice's later bars", () => {
      const lead = ok(TWO_SYSTEMS);
      expect(lead.bars).toHaveLength(4);
      expect(lead.bars[2]).toBe("[c5 b4 a4 g4]");
      expect(lead.bars[3]).toBe("[f4 e4 d4 c4]");
      expect(lead.dropped.join(" ")).not.toContain("silent");
    });

    it("fills the missing voice's bars with rests and says so", () => {
      const bass = ok(TWO_SYSTEMS, { voice: 2 });
      // Same cycle count as voice 1, so the two patterns stay aligned.
      expect(bass.bars).toHaveLength(4);
      expect(bass.bars.slice(0, 2)).toEqual(["[c3]", "[g3]"]);
      expect(bass.bars.slice(2)).toEqual(["~", "~"]);
      expect(bass.dropped).toContain("voice 2 is silent in 1 system (filled with rests)");
      expect(bass.text).toContain("filled with rests");
    });

    it("matches by V: id, not by position within the system", () => {
      // The second system's only voice sits at slot 0, where V:2 used to look.
      const bass = ok(TWO_SYSTEMS, { voice: 2 });
      expect(bass.bars.join(" ")).not.toContain("c5");
      expect(bass.bars.join(" ")).not.toContain("b4");
    });
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

// =============================================================================
// Regressions the mechanical audit found (report section 5)
// =============================================================================

/**
 * Statements at the top level of the emitted code, blank lines ignored. A
 * multi-line `stack(...)` is one statement, so lines are joined until every
 * bracket opened on the first of them has been closed — which is exactly the
 * grouping Strudel's transpiler sees.
 */
function topLevelStatements(code: string): string[] {
  const out: string[] = [];
  let depth = 0;
  for (const line of code.split("\n")) {
    if (!line.trim() && depth === 0) continue;
    if (depth > 0) out[out.length - 1] += `\n${line}`;
    else out.push(line);
    for (const ch of line) {
      if (ch === "(" || ch === "[") depth += 1;
      else if (ch === ")" || ch === "]") depth -= 1;
    }
  }
  return out;
}

describe("C1 — a chorded conversion keeps the melody", () => {
  // Strudel's transpiler turns only the LAST expression statement of a program
  // into the pattern it plays. Emitting `note(...)` and then `chord(...)` as two
  // bare statements silently threw the melody away: the tune converted, the code
  // ran, and only the accompaniment sounded.
  const CHORDED = 'X:1\nM:4/4\nL:1/4\nQ:1/4=120\nK:C\n"Cmaj7"C E G B | "Dm7"D F A c |]\n';

  it("emits ONE pattern expression, with both layers inside it", () => {
    const result = ok(CHORDED);
    const statements = topLevelStatements(result.code);
    // setcps, then exactly one pattern expression
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/^setcps\(/);

    const pattern = statements[1]!;
    expect(pattern.startsWith("stack(")).toBe(true);
    expect(pattern.trimEnd().endsWith(")")).toBe(true);
    expect(pattern).toContain(".voicing()");
    // The melody is inside the stack, not orphaned before it.
    expect(pattern).toContain(`note("<${result.bars.join(" ")}>")`);
  });

  it("balances the stack's parentheses and separates the layers with a comma", () => {
    const { code } = ok(CHORDED);
    expect([...code].filter((c) => c === "(").length).toBe(
      [...code].filter((c) => c === ")").length,
    );
    const stack = code.slice(code.indexOf("stack("));
    expect(stack.split("\n").filter((l) => l.trim().endsWith(",")).length).toBe(1);
  });

  it("leaves a melody-only tune as a single bare expression", () => {
    const statements = topLevelStatements(ok(fixture("01-simple-melody.abc")).code);
    expect(statements).toHaveLength(2);
    expect(statements[1]).toMatch(/^note\(/);
    expect(statements[1]).not.toContain("stack(");
  });
});

describe("C2 — what the conversion used to lose in silence", () => {
  describe("(a) more than one chord in a bar", () => {
    it("keeps both, weighted by when they change", () => {
      const result = ok('X:1\nM:4/4\nL:1/4\nK:C\n"Dm7"D F "G7"G B | "Cmaj7"c4 |]\n');
      expect(result.chords).toEqual(["[Dm7 G7]", "Cmaj7"]);
      expect(result.code).toContain('chord("<[Dm7 G7] C^7>")');
    });

    it("weights an uneven split with @", () => {
      // three beats of Dm7, one of G7
      const result = ok('X:1\nM:4/4\nL:1/4\nK:C\n"Dm7"D F A "G7"B |]\n');
      expect(result.chords).toEqual(["[Dm7@3 G7]"]);
    });

    it("carries the previous chord into the part of the bar before the change", () => {
      const result = ok('X:1\nM:4/4\nL:1/4\nK:C\n"C"C E G c | c G "G7"E C |]\n');
      expect(result.chords).toEqual(["C", "[C G7]"]);
    });

    it("still reports one symbol per bar when the bar has one chord", () => {
      expect(ok(fixture("06-chords-style.abc")).chords).toEqual(["C", "Am", "F", "G"]);
    });
  });

  describe("(b) %%MIDI program picks the Strudel sound", () => {
    it("maps program 73 to the flute", () => {
      const result = ok("X:1\nM:4/4\nL:1/4\nK:C\n%%MIDI program 73\nC D E F|]\n");
      expect(result.code).toContain('.s("gm_flute")');
      expect(result.dropped).toEqual([]);
    });

    it("reads the per-voice form, channel and all", () => {
      const abc = "X:1\nM:4/4\nL:1/4\nK:C\nV:1\n%%MIDI program 1 33\nC D E F|]\n";
      expect(ok(abc).code).toContain('.s("gm_electric_bass_finger")');
    });

    it("takes each voice's own program", () => {
      const abc =
        "X:1\nM:4/4\nL:1/4\nK:C\nV:1\n%%MIDI program 73\nC D E F|]\n" +
        "V:2\n%%MIDI program 42\nC, D, E, F,|]\n";
      expect(ok(abc, { voice: 1 }).code).toContain('.s("gm_flute")');
      expect(ok(abc, { voice: 2 }).code).toContain('.s("gm_cello")');
    });

    it("lets the sound argument override the tune's program", () => {
      const abc = "X:1\nM:4/4\nL:1/4\nK:C\n%%MIDI program 73\nC D E F|]\n";
      expect(ok(abc, { sound: "gm_cello" }).code).toContain('.s("gm_cello")');
    });

    it("reports a program number that is not a GM instrument", () => {
      const result = ok("X:1\nM:4/4\nL:1/4\nK:C\n%%MIDI program 200\nC D E F|]\n");
      expect(result.code).toContain('.s("gm_piano")');
      expect(result.dropped.join(" ")).toContain("not a GM program");
    });

    it("names the accompaniment directives it cannot convert", () => {
      const result = ok(fixture("06-chords-style.abc"));
      const note = result.dropped.join(" ");
      expect(note).toContain("%%MIDI");
      expect(note).toContain("gchord");
      expect(note).toContain("drum");
      expect(result.text).not.toContain("Lossless");
    });
  });

  describe("(c) octave transposition", () => {
    it("applies %%MIDI transpose in whole octaves", () => {
      expect(ok("X:1\nM:4/4\nL:1/4\nK:C\n%%MIDI transpose 12\nC D E F|]\n").bars[0]).toBe(
        "[c5 d5 e5 f5]",
      );
      expect(ok("X:1\nM:4/4\nL:1/4\nK:C\n%%MIDI transpose -12\nC D E F|]\n").bars[0]).toBe(
        "[c3 d3 e3 f3]",
      );
    });

    it("reports a transposition it cannot express as octaves", () => {
      const result = ok("X:1\nM:4/4\nL:1/4\nK:C\n%%MIDI transpose 7\nC D E F|]\n");
      expect(result.bars[0]).toBe("[c4 d4 e4 f4]");
      expect(result.dropped.join(" ")).toContain("whole octaves");
    });

    it("follows an octave clef", () => {
      expect(ok("X:1\nM:4/4\nL:1/4\nK:C clef=treble-8\nC D E F|]\n").bars[0]).toBe(
        "[c3 d3 e3 f3]",
      );
      expect(ok("X:1\nM:4/4\nL:1/4\nK:C clef=treble+8\nC D E F|]\n").bars[0]).toBe(
        "[c5 d5 e5 f5]",
      );
      // a plain clef is a notation choice, not a transposition
      expect(ok("X:1\nM:4/4\nL:1/4\nK:C clef=bass\nC D E F|]\n").bars[0]).toBe(
        "[c4 d4 e4 f4]",
      );
    });

    it("keeps a bar's running accidentals straight through a shift", () => {
      const result = ok("X:1\nM:4/4\nL:1/4\nK:C clef=treble-8\n^F F G F|]\n");
      expect(result.bars[0]).toBe("[f#3 f#3 g3 f#3]");
    });
  });

  describe("(d) what stays lossy is said out loud", () => {
    it("reports a tempo change inside the tune", () => {
      const result = ok(
        "X:1\nM:4/4\nL:1/4\nQ:1/4=100\nK:C\nC D E F| [Q:1/4=140] G A B c|]\n",
      );
      expect(result.code).toContain("setcps(100/60/4)");
      expect(result.dropped.join(" ")).toContain("tempo changes inside the tune");
    });

    it("reports a short final bar", () => {
      const result = ok("X:1\nM:4/4\nL:1/4\nK:C\nC D E F| G2|]\n");
      expect(result.dropped).toContain(
        "final bar is a pickup — Strudel will stretch it to a full cycle",
      );
    });

    it("does not cry pickup over a full final bar", () => {
      expect(ok(fixture("01-simple-melody.abc")).dropped).toEqual([]);
    });
  });

  it("only claims 'Lossless' when nothing at all was lost", () => {
    const lossy = [
      "X:1\nM:4/4\nL:1/4\nK:C\n%%MIDI gchord fzcz\nC D E F|]\n",
      "X:1\nM:4/4\nL:1/4\nK:C\n%%MIDI transpose 7\nC D E F|]\n",
      "X:1\nM:4/4\nL:1/4\nQ:1/4=100\nK:C\nC D E F| [Q:1/4=140] G A B c|]\n",
      "X:1\nM:4/4\nL:1/4\nK:C\nC D E F| G2|]\n",
      'X:1\nM:4/4\nL:1/4\nK:C\n"N.C."C D E F|]\n',
    ];
    for (const abc of lossy) {
      const result = ok(abc);
      expect(result.dropped.length, abc).toBeGreaterThan(0);
      expect(result.text, abc).not.toContain("Lossless");
    }
    // …and still says so when there really was nothing.
    expect(ok("X:1\nM:4/4\nL:1/4\nK:C\n%%MIDI program 73\nC D E F|]\n").text).toContain(
      "Lossless for this tune.",
    );
  });
});

describe("C3 — only real chord symbols become chords", () => {
  it("ignores positioned annotations", () => {
    // abcjs files "^rit." and "_soft" in the SAME array as chord symbols,
    // distinguished only by `position`.
    const result = ok('X:1\nM:4/4\nL:1/4\nK:C\n"C"C "^rit."D "_soft"E "<"F |]\n');
    expect(result.chords).toEqual(["C"]);
    expect(result.code).not.toContain("rit");
    expect(result.code).not.toContain("soft");
    expect(result.dropped).toEqual([]);
  });

  it("reports a chord symbol tonal cannot read instead of emitting it", () => {
    const result = ok('X:1\nM:4/4\nL:1/4\nK:C\n"N.C."C D E F|]\n');
    expect(result.code).not.toContain("chord(");
    expect(result.dropped.join(" ")).toContain('chord symbol "N.C."');
  });

  it("respells chord symbols for Strudel's voicing dictionary", () => {
    // `chord("Cmaj7").voicing()` renders NOTHING — the ireal dictionary is keyed
    // by "^7". The ABC spelling is kept for the reader; the code gets the other.
    const result = ok('X:1\nM:4/4\nL:1/4\nK:Bb\n"Bbmaj7"d f d B | "Cm7"c e c B |]\n');
    expect(result.chords).toEqual(["Bbmaj7", "Cm7"]);
    expect(result.code).toContain('chord("<Bb^7 Cm7>")');
  });

  it("rejects a sound name that would parse as mini-notation", () => {
    // A double-quoted string is a PATTERN in Strudel, so `.s("a b")` is two
    // steps — and a name carrying a quote would not even parse as source.
    const hostile = ['a") ; evil("', "two words", "sound;drop", 'quote"inside'];
    for (const sound of hostile) {
      const result = ok("X:1\nM:4/4\nL:1/4\nK:C\nC D E F|]\n", { sound });
      expect(result.code, sound).toContain('.s("gm_piano")');
      expect(result.dropped.join(" "), sound).toContain("not a usable Strudel sound name");
    }
  });

  it("accepts the sound names Strudel actually uses", () => {
    for (const sound of ["gm_flute", "bd:3", "sawtooth", "RolandTR909"]) {
      const result = ok("X:1\nM:4/4\nL:1/4\nK:C\nC D E F|]\n", { sound });
      expect(result.code, sound).toContain(`.s("${sound}")`);
      expect(result.dropped, sound).toEqual([]);
    }
  });

  it("quotes a title that contains a quote", () => {
    const result = ok('X:1\nT:She said "hi"\nM:4/4\nL:1/4\nK:C\nC D E F|]\n');
    expect(result.text.startsWith('"She said \\"hi\\"" — ')).toBe(true);
  });

  it("emits source that parses as JavaScript", () => {
    for (const name of Object.keys(FIXTURE_BARS)) {
      const { code } = ok(fixture(name));
      // A Strudel program is JS; `new Function` parses it without evaluating.
      expect(() => new Function(code), name).not.toThrow();
    }
  });
});

describe("the GM program table matches the pinned Strudel bundle", () => {
  const bundled: Set<string> = new Set(
    (
      JSON.parse(
        fs.readFileSync(path.join(FIXTURE_DIR, "..", "strudel-sounds.json"), "utf-8"),
      ) as { gm: string[] }
    ).gm,
  );

  it("covers all 128 GM programs (programs 1-3 share gm_piano: the bundle ships no bright/electric-grand/honky-tonk piano)", () => {
    expect(GM_PROGRAM_SOUNDS).toHaveLength(128);
    expect(new Set(GM_PROGRAM_SOUNDS).size).toBe(125);
    expect(GM_PROGRAM_SOUNDS.slice(0, 4)).toEqual(["gm_piano", "gm_piano", "gm_piano", "gm_piano"]);
  });

  it("every name is a sound the REPL can actually load", () => {
    for (const [program, name] of GM_PROGRAM_SOUNDS.entries()) {
      expect(bundled.has(name), `program ${program} → ${name}`).toBe(true);
    }
  });

  it("agrees with the guide's worked examples", () => {
    // The Strudel guide's 'sounds' topic lists these program numbers by hand.
    const documented: Record<number, string> = {
      0: "gm_piano",
      4: "gm_epiano1",
      6: "gm_harpsichord",
      16: "gm_drawbar_organ",
      19: "gm_church_organ",
      21: "gm_accordion",
      24: "gm_acoustic_guitar_nylon",
      26: "gm_electric_guitar_jazz",
      32: "gm_acoustic_bass",
      33: "gm_electric_bass_finger",
      40: "gm_violin",
      42: "gm_cello",
      45: "gm_pizzicato_strings",
      48: "gm_string_ensemble_1",
      56: "gm_trumpet",
      60: "gm_french_horn",
      65: "gm_alto_sax",
      71: "gm_clarinet",
      73: "gm_flute",
      80: "gm_lead_1_square",
      88: "gm_pad_new_age",
      104: "gm_sitar",
      108: "gm_kalimba",
      114: "gm_steel_drums",
    };
    for (const [program, name] of Object.entries(documented)) {
      expect(soundForProgram(Number(program))).toBe(name);
    }
    expect(soundForProgram(128)).toBeNull();
    expect(soundForProgram(-1)).toBeNull();
    expect(soundForProgram(Number.NaN)).toBeNull();
  });
});

describe("every chord the converter prints is one Strudel can voice", () => {
  /** Pull the symbols out of a `chord("<...>")` mini-notation string. */
  function chordTokens(code: string): string[] {
    const match = code.match(/chord\("<([^"]*)>"\)/);
    if (!match) return [];
    return match[1]!.split(/[\s[\]]+/).filter(Boolean);
  }

  const chorded = [
    ...Object.keys(FIXTURE_BARS).map((n) => fixture(n)),
    ...genreTemplates().map((t) => t.abc),
  ];

  it("resolves every emitted symbol against the ireal dictionary", () => {
    let seen = 0;
    for (const abc of chorded) {
      for (const token of chordTokens(ok(abc).code)) {
        if (token === "~") continue;
        seen += 1;
        const suffix = token
          .replace(/^[A-G][b#]*/, "")
          .split("/")[0]!
          .replace(/@\d+$/, "");
        expect(IREAL_VOICING_SUFFIXES.has(suffix), `${token} → ${suffix}`).toBe(true);
      }
    }
    expect(seen).toBeGreaterThan(10);
  });
});
