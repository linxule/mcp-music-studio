/**
 * @file Every accompaniment preset, measured through the REAL abcjs sequencer.
 *
 * `ABCJS.parseOnly()` is not enough here, and that gap is exactly how four
 * presets shipped with silently-disabled drums. The parser accepts any
 * `%%MIDI drum` line; it is the *flattener*
 * (node_modules/abcjs/src/synth/abc_midi_flattener.js `normalizeDrumDefinition`)
 * that enforces
 *
 *     params.pattern.length === (number of 'd' hits) * 2 + 1
 *
 * and, on any mismatch, returns `{ on: false }` — no drums, no diagnostic.
 *
 * So these tests call `tune.setUpAudio(options)`, which is precisely what
 * `ABCJS.synth.CreateSynth.init()` and `ABCJS.synth.getMidiFile()` call to turn
 * a parsed tune into playable tracks. Percussion is instrument 128 in that
 * output (channel 10 in the MIDI writer). If a preset regresses to a bad
 * argument count, the percussion count drops to zero and these fail.
 */
import { describe, expect, it } from "vitest";
import ABCJS from "abcjs";
import {
  applyStyleToAbc,
  STYLE_NAMES,
  STYLE_PRESETS,
  type StyleName,
} from "../src/music-logic";

/** Distinct from every chordprog/bassprog used by the presets. */
const MELODY_PROGRAM = 73; // Flute

/** Two bars of 4/4 carrying chord symbols, so gchord/bass have something to do. */
const CHORD_TUNE = `X:1
T:Preset probe
M:4/4
L:1/8
Q:1/4=120
K:C
"C"CDEF GABc | "G"cBAG FEDC |
`;

/** Three bars of 3/4, for the presets whose patterns assume a waltz bar. */
const WALTZ_TUNE = `X:1
T:Waltz probe
M:3/4
L:1/4
Q:1/4=150
K:C
"C"C E G | "F"F A c | "G"G B d |
`;

interface Measured {
  /** note events keyed by GM program (128 = percussion). */
  byProgram: Map<number, number>;
  trackCount: number;
}

/**
 * Run ABC through the same flatten step the synth and the MIDI writer use.
 *
 * `setUpAudio` lives on the parsed tune object and is what create-synth.js:116
 * calls; there is no lighter-weight entry point that still normalises drums.
 */
function measure(abc: string): Measured {
  const tune = ABCJS.parseOnly(abc)[0];
  const flat = tune.setUpAudio({ program: MELODY_PROGRAM }) as {
    tracks: { cmd: string; instrument?: number }[][];
  };

  const byProgram = new Map<number, number>();
  for (const track of flat.tracks) {
    for (const event of track) {
      if (event.cmd !== "note") continue;
      const program = event.instrument ?? -1;
      byProgram.set(program, (byProgram.get(program) ?? 0) + 1);
    }
  }
  return { byProgram, trackCount: flat.tracks.length };
}

const percussionOf = (m: Measured) => m.byProgram.get(128) ?? 0;

/** Pull `%%MIDI <name> <n>` out of a preset so the test reads the same source of truth. */
function directiveProgram(style: StyleName, name: string): number | undefined {
  const match = STYLE_PRESETS[style].match(
    new RegExp(`^%%MIDI ${name} (\\d+)$`, "m"),
  );
  return match ? Number(match[1]) : undefined;
}

const DRUMMED = STYLE_NAMES.filter((s) => s !== "classical");

describe("style presets — percussion actually reaches the sequencer", () => {
  it.each(DRUMMED)("%s produces percussion events", (style) => {
    const measured = measure(applyStyleToAbc(CHORD_TUNE, style));
    expect(percussionOf(measured)).toBeGreaterThan(0);
  });

  it("classical stays deliberately drumless", () => {
    expect(STYLE_PRESETS.classical).not.toContain("%%MIDI drumon");
    expect(percussionOf(measure(applyStyleToAbc(CHORD_TUNE, "classical")))).toBe(
      0,
    );
  });

  it("an unstyled tune has no percussion at all", () => {
    expect(percussionOf(measure(CHORD_TUNE))).toBe(0);
  });

  // The exact counts, pinned. These are the numbers that were 0 for jazz,
  // waltz, reggae and folk before the argument lists were corrected.
  it("matches the measured percussion counts for a two-bar 4/4 probe", () => {
    const counts = Object.fromEntries(
      STYLE_NAMES.map((style) => [
        style,
        percussionOf(measure(applyStyleToAbc(CHORD_TUNE, style))),
      ]),
    );
    expect(counts).toEqual({
      rock: 8,
      jazz: 8,
      bossa: 16,
      waltz: 2,
      march: 8,
      reggae: 4,
      folk: 2,
      classical: 0,
    });
  });

  it("the waltz pattern still fires in its native 3/4", () => {
    expect(
      percussionOf(measure(applyStyleToAbc(WALTZ_TUNE, "waltz"))),
    ).toBeGreaterThan(0);
  });
});

describe("style presets — drum argument counts obey abcjs's rule", () => {
  it.each(DRUMMED)("%s: pattern.length === hits * 2 + 1", (style) => {
    const line = STYLE_PRESETS[style].match(/^%%MIDI drum (.+)$/m);
    expect(line, `${style} declares %%MIDI drum`).not.toBeNull();

    const parts = line![1].trim().split(/\s+/);
    const pattern = parts[0]!;
    const hits = [...pattern].filter((c) => c === "d").length;

    expect(/^[dz]+$/.test(pattern), `${style} pattern is only d/z`).toBe(true);
    expect(hits).toBeGreaterThan(0);
    // pattern token + one pitch per hit + one velocity per hit
    expect(parts.length).toBe(hits * 2 + 1);
    // pitches are GM percussion keys, velocities are 1..127
    for (const n of parts.slice(1)) expect(Number(n)).toBeGreaterThan(0);
    for (const n of parts.slice(1)) expect(Number(n)).toBeLessThanOrEqual(127);
  });
});

describe("style presets — gchord/bass directives actually yield events", () => {
  it.each(STYLE_NAMES)("%s emits chord and bass notes", (style) => {
    const measured = measure(applyStyleToAbc(CHORD_TUNE, style));

    const chordProgram = directiveProgram(style, "chordprog");
    const bassProgram = directiveProgram(style, "bassprog");
    expect(chordProgram, `${style} declares chordprog`).toBeDefined();
    expect(bassProgram, `${style} declares bassprog`).toBeDefined();

    expect(
      measured.byProgram.get(chordProgram!) ?? 0,
      `${style} chord notes on program ${chordProgram}`,
    ).toBeGreaterThan(0);
    expect(
      measured.byProgram.get(bassProgram!) ?? 0,
      `${style} bass notes on program ${bassProgram}`,
    ).toBeGreaterThan(0);
  });

  it.each(STYLE_NAMES)("%s uses a well-formed gchord string", (style) => {
    const line = STYLE_PRESETS[style].match(/^%%MIDI gchord (.+)$/m);
    expect(line, `${style} declares %%MIDI gchord`).not.toBeNull();

    const pattern = line![1].trim();
    // abcjs gchord alphabet: f = fundamental/bass, c = full chord,
    // b = bass+chord together, g/h/i/j = individual chord tones, z = rest.
    expect(pattern).toMatch(/^[fcbghijz]+$/);
    expect(pattern).toMatch(/[fb]/); // something plays the bass
    expect(pattern).toMatch(/[cbghij]/); // something plays the chord
  });

  it("the melody itself survives every preset", () => {
    for (const style of STYLE_NAMES) {
      const measured = measure(applyStyleToAbc(CHORD_TUNE, style));
      // 16 melody eighths, on the program we asked for.
      expect(
        measured.byProgram.get(MELODY_PROGRAM) ?? 0,
        `${style} melody notes`,
      ).toBe(16);
    }
  });
});
