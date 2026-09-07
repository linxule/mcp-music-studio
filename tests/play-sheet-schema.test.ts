/**
 * @file The play-sheet-music input schema, checked against what abcjs really does.
 *
 * Three of these fields used to describe behaviour the renderer never had:
 * `swing` advertised a 0-100 dial whose recommended values were all silent
 * no-ops, `transpose` promised a shift the printed score never received, and
 * `drumIntro` — a genuine abcjs synth option — wasn't offered at all. The
 * schema tests pin the corrected contract; the abcjs tests at the bottom prove
 * the option names really are the ones abcjs acts on.
 */
import { describe, expect, it } from "vitest";
import ABCJS from "abcjs";
import { playSheetInputSchema } from "../src/shared/tool-defs";
import { SWING_MAX, SWING_STRAIGHT, applyStyleToAbc } from "../src/music-logic";

const shape = playSheetInputSchema.shape;

function accepts(field: keyof typeof shape, value: unknown): boolean {
  return shape[field].safeParse(value).success;
}

describe("playSheetInputSchema.swing", () => {
  it("stops at the maximum abcjs honours instead of 100", () => {
    expect(accepts("swing", SWING_MAX)).toBe(true);
    expect(accepts("swing", 76)).toBe(false);
    expect(accepts("swing", 100)).toBe(false);
  });

  it("still accepts the legacy 0 = straight convention", () => {
    // Kept over a hard `.min(50)` so callers written against the old schema
    // get a no-op rather than a validation error.
    expect(accepts("swing", 0)).toBe(true);
    expect(accepts("swing", 33)).toBe(true);
    expect(accepts("swing", -1)).toBe(false);
  });

  it("documents the real anchor points and the meter requirement", () => {
    const description = shape.swing.description ?? "";
    expect(description).toContain(String(SWING_STRAIGHT));
    expect(description).toContain(String(SWING_MAX));
    expect(description).toMatch(/x\/4 or x\/8/);
    // The old text called 33 a "light swing"; abcjs ignores anything <= 50.
    expect(description).not.toMatch(/33/);
  });
});

describe("playSheetInputSchema.drumIntro", () => {
  it("accepts whole bars of count-in, 0 through 8", () => {
    expect(accepts("drumIntro", 0)).toBe(true);
    expect(accepts("drumIntro", 4)).toBe(true);
    expect(accepts("drumIntro", 8)).toBe(true);
    expect(accepts("drumIntro", 9)).toBe(false);
    expect(accepts("drumIntro", -1)).toBe(false);
    expect(accepts("drumIntro", 1.5)).toBe(false);
  });

  it("is optional", () => {
    expect(accepts("drumIntro", undefined)).toBe(true);
  });

  it("warns that the count-in needs a style preset to be audible", () => {
    expect(shape.drumIntro.description ?? "").toMatch(/style/i);
  });
});

describe("playSheetInputSchema.transpose", () => {
  it("promises a notation change, not an audio-only shift", () => {
    const description = shape.transpose.description ?? "";
    expect(description).toMatch(/key signature/i);
    expect(description).not.toMatch(/%%MIDI/);
  });
});

describe("playSheetInputSchema.title", () => {
  it("describes both places the title is now actually used", () => {
    const description = shape.title.description ?? "";
    expect(description).toMatch(/header/i);
    expect(description).toMatch(/filename|download/i);
  });
});

// -----------------------------------------------------------------------------
// The abcjs side of the contract
// -----------------------------------------------------------------------------

const ROCK_TUNE = applyStyleToAbc(
  'X:1\nT:Intro Test\nM:4/4\nL:1/4\nQ:1/4=120\nK:C\n"C"C D E F | "G"G A B c |]',
  "rock",
);

function midiBytes(options: Record<string, unknown>): Uint8Array {
  const tune = ABCJS.parseOnly(ROCK_TUNE)[0];
  return ABCJS.synth.getMidiFile(tune, {
    midiOutputType: "binary",
    ...options,
  } as ABCJS.MidiFileOptions) as unknown as Uint8Array;
}

describe("abcjs honours the option names we send", () => {
  it("drumIntro lengthens the rendered MIDI (it is a real synth option)", () => {
    const plain = midiBytes({});
    const withIntro = midiBytes({ drumIntro: 4 });

    expect(plain.length).toBeGreaterThan(0);
    // Four bars of count-in means more events, hence a bigger file. If abcjs
    // ever ignored the option these would be byte-identical.
    expect(withIntro.length).toBeGreaterThan(plain.length);
  });

  it("swing never reaches the MIDI export — it is a live-synth effect only", () => {
    // abcjs applies swing in createSynth's note map (addSwing), which
    // getMidiFile never runs: every one of these renders byte-identically,
    // including the values the synth *does* honour. So an exported .mid is
    // always straight, whatever `swing` the caller passed. Pinned here so the
    // asymmetry between the Play button and the MIDI button is deliberate and
    // visible rather than a surprise bug report.
    const straight = midiBytes({});
    for (const swing of [33, SWING_STRAIGHT, 60, 66, SWING_MAX]) {
      expect(midiBytes({ swing })).toEqual(straight);
    }
  });
});
