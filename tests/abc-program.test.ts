/**
 * @file The first voice's own `%%MIDI program`: detection and override (#25).
 *
 * The unit tests pin the text model in src/abc-program.ts. The cross-check at
 * the bottom is what keeps that model honest: every layout here, the ABC
 * fixtures and every tune in the guide go through abcjs's REAL sequencer
 * (`tune.setUpAudio()`, the call CreateSynth makes), and the program abcjs
 * gives the first voice's first note must be the one the model reports. After
 * an override it must be the requested one, with every other voice's own
 * program untouched.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ABCJS from "abcjs";
import {
  deriveEffectiveAbc,
  findLeadingProgram,
  instrumentForProgram,
  overrideLeadingProgram,
} from "../src/abc-program";
import { ABC_GUIDES } from "../src/abc-guide";
import { applyStyleToAbc } from "../src/music-logic";

const H = "X:1\nM:4/4\nL:1/4\nK:C\n";

/** Every layout whose abcjs behaviour was measured while writing the model. */
const LAYOUTS: Record<string, string> = {
  headerBeforeK: "X:1\nM:4/4\nL:1/4\n%%MIDI program 73\nK:C\nCDEF|\n",
  afterK: H + "%%MIDI program 73\nCDEF|\n",
  midTune: H + "CDEF|\n%%MIDI program 73\nCDEF|\n",
  midLine: H + "CD\n%%MIDI program 73\nEF|\n",
  twoArgHeader: H + "%%MIDI program 1 73\nCDEF|\n",
  twoArgInlineV1: H + "V:1\n%%MIDI program 1 73\nCDEF|\n",
  twoArgInlineV2: H + "V:1\nCDEF|\nV:2\n%%MIDI program 2 42\nCDEF|\n",
  guideMulti:
    H + 'V:1 name="M"\n%%MIDI program 73\nCDEF|\nV:2 clef=bass\n%%MIDI program 32\nC,D,E,F,|\n',
  allUpFront:
    H + "V:1\n%%MIDI program 73\nV:2 clef=bass\n%%MIDI program 32\nV:1\nCDEF|\nV:2\nC,D,E,F,|\n",
  headerVoices:
    "X:1\nM:4/4\nL:1/4\nV:1\n%%MIDI program 73\nV:2 clef=bass\n%%MIDI program 32\nK:C\nV:1\nCDEF|\nV:2\nC,D,E,F,|\n",
  v2Only: H + "V:1\nCDEF|\nV:2\n%%MIDI program 32\nC,D,E,F,|\n",
  v2OnlyPreMusic: H + "V:2\n%%MIDI program 32\nV:1\nCDEF|\nV:2\nC,D,E,F,|\n",
  inlineField: H + "[I:MIDI program 73] CDEF|\n",
  inlineFieldEq: H + "[I:MIDI=program 73] CDEF|\n",
  inlineFieldLater: H + "CDEF|\n[I:MIDI program 73] CDEF|\n",
  inlineFieldMidLine: H + "CD [I:MIDI program 73] EF|\n",
  inlineFieldAfterV1: H + "V:1\n[I:MIDI program 73] CDEF|\nV:2\nC,D,E,F,|\n",
  inlineVoiceFirst: H + "[V:1] [I:MIDI program 73] CDEF|\n[V:2] C,D,E,F,|\n",
  barThenInlineField: H + "| [I:MIDI program 73] CDEF|\n",
  fieldLineIgnored: H + "I:MIDI program 73\nCDEF|\n",
  trailingComment: H + "%%MIDI program 73 % flute\nCDEF|\n",
  commentedOut: H + "% %%MIDI program 73\nCDEF|\n",
  leadingSpaceIgnored: H + " %%MIDI program 73\nCDEF|\n",
  commentLineBetween: H + "V:1\n% melody\n%%MIDI program 73\nCDEF|\n",
  secondBlockV1:
    H + "V:1\n%%MIDI program 73\nCDEF|\nV:2\n%%MIDI program 32\nC,D,E,F,|\nV:1\n%%MIDI program 40\nCDEF|\nV:2\nC,D,E,F,|\n",
  twoHeaderPrograms: H + "%%MIDI program 73\n%%MIDI program 40\nCDEF|\n",
  headerThenVoice: H + "%%MIDI program 73\n%%MIDI program 74\nV:1\n%%MIDI program 40\nCDEF|\n",
  v1BlockTwice: H + "V:1\nCDEF|\nV:1\n%%MIDI program 73\nCDEF|\n",
  v1ProgramAfterBarLine: H + "V:1\n|:\n%%MIDI program 73\nCDEF:|\n",
  musicThenV2: H + "CDEF|\nV:2\n%%MIDI program 32\nC,D,E,F,|\n",
  headerOrder21:
    "X:1\nM:4/4\nL:1/4\nV:2\nV:1\nK:C\nV:1\n%%MIDI program 73\nCDEF|\nV:2\n%%MIDI program 32\nC,D,E,F,|\n",
  bodyOrder21: H + "V:2\n%%MIDI program 32\nC,D,E,F,|\nV:1\n%%MIDI program 73\nCDEF|\n",
  scoreReorders:
    "X:1\nM:4/4\nL:1/4\n%%score (2 1)\nK:C\nV:1\n%%MIDI program 73\nCDEF|\nV:2\n%%MIDI program 32\nC,D,E,F,|\n",
  stavesReorders:
    "X:1\nM:4/4\nL:1/4\n%%staves [2 1]\nK:C\nV:1\n%%MIDI program 73\nCDEF|\nV:2\n%%MIDI program 32\nC,D,E,F,|\n",
  scoreBraces:
    "X:1\nM:4/4\nL:1/4\n%%score {RH | LH}\nK:C\nV:RH\n%%MIDI program 73\nCDEF|\nV:LH clef=bass\n%%MIDI program 32\nC,D,E,F,|\n",
  voiceIdWithSpace: H + "V: A clef=treble\n%%MIDI program 73\nCDEF|\nV: B\n%%MIDI program 32\nCDEF|\n",
  titleInBody: H + "T:Part 2\n%%MIDI program 73\nCDEF|\n",
  bodyKeyChange: H + "K:G\n%%MIDI program 73\nCDEF|\n",
  lowercase: H + "%%midi program 73\nCDEF|\n",
  spacedOut: H + "%%  MIDI   program   73\nCDEF|\n",
  crlf: "X:1\r\nM:4/4\r\nL:1/4\r\nK:C\r\n%%MIDI program 73\r\nCDEF|\r\n",
  secondTuneIgnored: H + "%%MIDI program 73\nCDEF|\n\nX:2\nK:C\n%%MIDI program 40\nCDEF|\n",
  // From the Codex review of #25: all three disagreed with the sequencer.
  headerVoicesThenMusic:
    "X:1\n%%score (1 2)\nV:1\nV:2\nK:C\nCDEF|\nV:1\n%%MIDI program 73\nCDEF|\n",
  headerVoicesThenMusicNoScore: "X:1\nV:1\nV:2\nK:C\nCDEF|\nV:1\n%%MIDI program 73\nCDEF|\n",
  textBlockBeforeProgram:
    "X:1\n%%begintext\nWritten for flute\n%%endtext\n%%MIDI program 73\nK:C\nCDEF|\n",
  programInsideTextBlock: "X:1\n%%begintext\n%%MIDI program 40\n%%endtext\nK:C\nCDEF|\n",
  intertuneAfterBlankLine:
    H + "V:1\n%%MIDI program 73\nCDEF|\nV:2\n%%MIDI program 32\nC,D,E,F,|\n\n%%score (2 1)\nX:2\nK:C\nCDEF|\n",
  blankLineEndsTune: H + "CDEF|\n\n%%MIDI program 73\nCDEF|\n",
  fileHeaderDirective: "%%MIDI program 73\n\nX:1\nK:C\nCDEF|\n\nX:2\nK:C\nCDEF|\n",
  noProgram: H + "CDEF|\n",
  chordSymbolsNoProgram: H + '"C"CDEF|"G"GABc|\n',
};

describe("findLeadingProgram — the text model", () => {
  const program = (abc: string) => findLeadingProgram(abc)?.program ?? null;
  const scope = (abc: string) => findLeadingProgram(abc)?.scope ?? null;

  it("reads a header-level program, before or after K:", () => {
    expect(program(LAYOUTS.headerBeforeK!)).toBe(73);
    expect(program(LAYOUTS.afterK!)).toBe(73);
    expect(scope(LAYOUTS.afterK!)).toBe("global");
    expect(findLeadingProgram(LAYOUTS.afterK!)?.directive).toBe("%%MIDI program 73");
  });

  it("takes the LAST header program, as abcjs does", () => {
    expect(program(LAYOUTS.twoHeaderPrograms!)).toBe(40);
  });

  it("reads the program argument of the two-argument header form", () => {
    expect(program(LAYOUTS.twoArgHeader!)).toBe(73);
  });

  it("reads the FIRST argument of a voice-scoped two-argument form (abcjs plays params[0])", () => {
    expect(program(LAYOUTS.twoArgInlineV1!)).toBe(1);
    expect(scope(LAYOUTS.twoArgInlineV1!)).toBe("voice");
  });

  it("reads the guide's V:1 / %%MIDI program pattern as voice-scoped", () => {
    expect(program(LAYOUTS.guideMulti!)).toBe(73);
    expect(scope(LAYOUTS.guideMulti!)).toBe("voice");
    expect(program(LAYOUTS.allUpFront!)).toBe(73);
  });

  it("collapses header-declared voices into one global program, the last", () => {
    expect(program(LAYOUTS.headerVoices!)).toBe(32);
    expect(scope(LAYOUTS.headerVoices!)).toBe("global");
  });

  it("lets a voice-scoped program outrank the header's", () => {
    expect(program(LAYOUTS.headerThenVoice!)).toBe(40);
  });

  it("returns null when the score sets no program", () => {
    expect(findLeadingProgram(LAYOUTS.noProgram!)).toBeNull();
    expect(findLeadingProgram(LAYOUTS.chordSymbolsNoProgram!)).toBeNull();
  });

  it("ignores a program that only a later voice sets", () => {
    expect(findLeadingProgram(LAYOUTS.v2Only!)).toBeNull();
    expect(findLeadingProgram(LAYOUTS.twoArgInlineV2!)).toBeNull();
  });

  it("ignores a mid-tune change — the first voice already has notes", () => {
    expect(findLeadingProgram(LAYOUTS.midTune!)).toBeNull();
    expect(findLeadingProgram(LAYOUTS.midLine!)).toBeNull();
    expect(findLeadingProgram(LAYOUTS.v1BlockTwice!)).toBeNull();
    expect(findLeadingProgram(LAYOUTS.inlineFieldLater!)).toBeNull();
    expect(findLeadingProgram(LAYOUTS.inlineFieldMidLine!)).toBeNull();
    expect(findLeadingProgram(LAYOUTS.musicThenV2!)).toBeNull();
    // ...but the first block's own opening program is still the leading one.
    expect(program(LAYOUTS.secondBlockV1!)).toBe(73);
  });

  it("counts a bar-only line as not yet a note", () => {
    expect(program(LAYOUTS.v1ProgramAfterBarLine!)).toBe(73);
    expect(program(LAYOUTS.barThenInlineField!)).toBe(73);
  });

  it("honours comments the way abcjs's line parser does", () => {
    expect(program(LAYOUTS.trailingComment!)).toBe(73);
    expect(findLeadingProgram(LAYOUTS.trailingComment!)?.directive).toBe("%%MIDI program 73");
    expect(findLeadingProgram(LAYOUTS.commentedOut!)).toBeNull();
    expect(findLeadingProgram(LAYOUTS.leadingSpaceIgnored!)).toBeNull();
    expect(program(LAYOUTS.commentLineBetween!)).toBe(73);
  });

  it("reads inline [I:MIDI program] fields, global only when they open the tune", () => {
    expect(scope(LAYOUTS.inlineField!)).toBe("global");
    expect(program(LAYOUTS.inlineFieldEq!)).toBe(73);
    expect(scope(LAYOUTS.inlineVoiceFirst!)).toBe("global");
    expect(scope(LAYOUTS.inlineFieldAfterV1!)).toBe("voice");
    // An `I:` FIELD LINE is metatext ('instruction') to abcjs, not a directive.
    expect(findLeadingProgram(LAYOUTS.fieldLineIgnored!)).toBeNull();
  });

  it("finds the first voice by %%score / %%staves order, then by first appearance", () => {
    expect(program(LAYOUTS.scoreReorders!)).toBe(32);
    expect(program(LAYOUTS.stavesReorders!)).toBe(32);
    expect(program(LAYOUTS.scoreBraces!)).toBe(73);
    expect(program(LAYOUTS.headerOrder21!)).toBe(32);
    expect(program(LAYOUTS.bodyOrder21!)).toBe(32);
    expect(program(LAYOUTS.v2OnlyPreMusic!)).toBe(32);
    expect(program(LAYOUTS.voiceIdWithSpace!)).toBe(73);
  });

  it("treats body T:/K: fields as not-yet-music", () => {
    expect(scope(LAYOUTS.titleInBody!)).toBe("global");
    expect(scope(LAYOUTS.bodyKeyChange!)).toBe("global");
  });

  it("copes with CRLF, lowercase and extra spacing, and reads the first tune only", () => {
    expect(program(LAYOUTS.crlf!)).toBe(73);
    expect(program(LAYOUTS.lowercase!)).toBe(73);
    expect(program(LAYOUTS.spacedOut!)).toBe(73);
    expect(program(LAYOUTS.secondTuneIgnored!)).toBe(73);
  });
});

describe("overrideLeadingProgram — rewrites exactly one directive", () => {
  it("replaces a header program", () => {
    expect(overrideLeadingProgram(LAYOUTS.afterK!, 40)).toBe(
      H + "%%MIDI program 40\nCDEF|\n",
    );
  });

  it("keeps the channel of the two-argument header form", () => {
    expect(overrideLeadingProgram(LAYOUTS.twoArgHeader!, 40)).toBe(
      H + "%%MIDI program 1 40\nCDEF|\n",
    );
  });

  it("collapses a voice-scoped two-argument form to the argument abcjs reads", () => {
    expect(overrideLeadingProgram(LAYOUTS.twoArgInlineV1!, 40)).toBe(
      H + "V:1\n%%MIDI program 40\nCDEF|\n",
    );
  });

  it("changes the first voice only and leaves the others' programs alone", () => {
    expect(overrideLeadingProgram(LAYOUTS.guideMulti!, 40)).toBe(
      H + 'V:1 name="M"\n%%MIDI program 40\nCDEF|\nV:2 clef=bass\n%%MIDI program 32\nC,D,E,F,|\n',
    );
    // secondBlockV1: the mid-tune change to 40 in V:1's second block survives.
    expect(overrideLeadingProgram(LAYOUTS.secondBlockV1!, 24)).toBe(
      H + "V:1\n%%MIDI program 24\nCDEF|\nV:2\n%%MIDI program 32\nC,D,E,F,|\nV:1\n%%MIDI program 40\nCDEF|\nV:2\nC,D,E,F,|\n",
    );
  });

  it("keeps a trailing comment and the rest of an inline field", () => {
    expect(overrideLeadingProgram(LAYOUTS.trailingComment!, 40)).toBe(
      H + "%%MIDI program 40 % flute\nCDEF|\n",
    );
    expect(overrideLeadingProgram(LAYOUTS.inlineField!, 40)).toBe(
      H + "[I:MIDI program 40] CDEF|\n",
    );
  });

  it("leaves a score without a leading program untouched", () => {
    for (const name of ["noProgram", "v2Only", "midTune", "commentedOut"] as const) {
      expect(overrideLeadingProgram(LAYOUTS[name]!, 40)).toBe(LAYOUTS[name]);
    }
  });

  it("refuses a non-integer program rather than writing garbage", () => {
    expect(overrideLeadingProgram(LAYOUTS.afterK!, Number.NaN)).toBe(LAYOUTS.afterK);
  });
});

describe("deriveEffectiveAbc — the one render-time derivation", () => {
  const raw = H + "%%MIDI program 73\n\"C\"CDEF|\n";

  it("is exactly applyStyleToAbc when there is no override", () => {
    expect(deriveEffectiveAbc(raw, { style: "jazz" })).toBe(applyStyleToAbc(raw, "jazz"));
    expect(deriveEffectiveAbc(raw, { style: "", programOverride: null })).toBe(raw);
  });

  it("layers the style on top of the program override", () => {
    const effective = deriveEffectiveAbc(raw, { style: "rock", programOverride: 40 });
    expect(effective).toBe(applyStyleToAbc(H + "%%MIDI program 40\n\"C\"CDEF|\n", "rock"));
    // The preset's chordprog/bassprog are not mistaken for the melody's program.
    expect(findLeadingProgram(effective)?.program).toBe(40);
  });

  it("never mutates the raw input", () => {
    const before = raw;
    deriveEffectiveAbc(raw, { style: "rock", programOverride: 40 });
    expect(raw).toBe(before);
  });
});

describe("instrumentForProgram", () => {
  it("maps GM programs to the canonical INSTRUMENTS names", () => {
    expect(instrumentForProgram(0)).toBe("Acoustic Grand Piano");
    expect(instrumentForProgram(73)).toBe("Flute");
    expect(instrumentForProgram(127)).toBe("Gunshot");
  });

  it("returns null outside the GM table", () => {
    expect(instrumentForProgram(128)).toBeNull();
    expect(instrumentForProgram(-1)).toBeNull();
    expect(instrumentForProgram(300)).toBeNull();
  });
});

// =============================================================================
// Cross-check against abcjs's real sequencer
// =============================================================================

/** Distinct from every program in the corpus, so "no program" is visible. */
const SENTINEL = 117;

/** GM program of each track's first note, as abcjs's flattener assigns it. */
function firstNotePrograms(abc: string): number[] {
  const tune = ABCJS.parseOnly(abc)[0]!;
  const flat = tune.setUpAudio({ program: SENTINEL }) as {
    tracks: { cmd: string; instrument?: number }[][];
  };
  return flat.tracks.map(
    (track) => track.find((event) => event.cmd === "note")?.instrument ?? -1,
  );
}

/** X: tunes in a guide topic (same rule as tests/abc-guide-parse.test.ts). */
function guideTunes(): [string, string][] {
  const tunes: [string, string][] = [];
  for (const [topic, text] of Object.entries(ABC_GUIDES)) {
    let current: string[] | null = null;
    const flush = () => {
      if (current) tunes.push([`guide ${topic} #${tunes.length}`, current.join("\n") + "\n"]);
      current = null;
    };
    for (const line of text.split("\n")) {
      if (/^X:\s*\d/.test(line)) {
        flush();
        current = [line];
      } else if (current && (line.trim() === "" || line.startsWith("#"))) {
        flush();
      } else if (current) {
        current.push(line);
      }
    }
    flush();
  }
  return tunes;
}

function fixtureTunes(): [string, string][] {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "abc");
  return readdirSync(dir)
    .filter((name) => /^0\d-.*\.abc$/.test(name))
    .map((name) => [`fixture ${name}`, readFileSync(path.join(dir, name), "utf8")]);
}

// A header-only block (the guide's syntax cheat-sheet) has no first note to
// compare, so it is left out rather than compared against `undefined`.
const CORPUS: [string, string][] = [
  ...Object.entries(LAYOUTS),
  ...guideTunes(),
  ...fixtureTunes(),
].filter(([, abc]) => firstNotePrograms(abc)[0] !== -1 && firstNotePrograms(abc)[0] !== undefined);

describe("the model agrees with abcjs's sequencer", () => {
  it("has a corpus that actually exercises %%MIDI program", () => {
    const withProgram = CORPUS.filter(([, abc]) => findLeadingProgram(abc) !== null);
    expect(guideTunes().length).toBeGreaterThan(5);
    expect(withProgram.length).toBeGreaterThan(30);
  });

  it.each(CORPUS)("%s: the reported program is what the first voice plays", (_name, abc) => {
    const expected = findLeadingProgram(abc)?.program ?? SENTINEL;
    expect(firstNotePrograms(abc)[0]).toBe(expected);
  });

  it.each(CORPUS)("%s: an override reaches the first voice and spares the rest", (_name, abc) => {
    const leading = findLeadingProgram(abc);
    const OVERRIDE = 110; // Fiddle — used nowhere in the corpus
    const before = firstNotePrograms(abc);
    const after = firstNotePrograms(overrideLeadingProgram(abc, OVERRIDE));
    if (!leading) {
      expect(after).toEqual(before);
      return;
    }
    expect(after[0]).toBe(OVERRIDE);
    expect(after.length).toBe(before.length);
    for (let t = 1; t < before.length; t++) {
      // A global program is also the start of every voice that sets none of
      // its own, so those follow the override; every other track is untouched.
      const inherited = leading.scope === "global" && before[t] === leading.program;
      expect(after[t]).toBe(inherited ? OVERRIDE : before[t]);
    }
  });
});
