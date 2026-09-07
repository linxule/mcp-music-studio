import { describe, expect, it } from "vitest";
import {
  DEFAULT_INSTRUMENT,
  DEFAULT_STYLE,
  DRUM_INTRO_MAX,
  SWING_MAX,
  SWING_STRAIGHT,
  applyStyleToAbc,
  buildSynthOptions,
  findInstrument,
  injectTempoHeader,
  normalizeDrumIntro,
  normalizeSwing,
  prepareToolInput,
} from "../src/music-logic";

const BASE_ABC = `X:1
T:Test Tune
M:4/4
L:1/4
K:C
C D E F |`;

describe("client music helpers", () => {
  it("resets instrument and style between tool invocations", () => {
    const firstInvocation = prepareToolInput({
      abcNotation: BASE_ABC,
      instrument: "alto sax",
      style: "jazz",
    });

    expect(firstInvocation.instrument).toBe("Alto Sax");
    expect(firstInvocation.style).toBe("jazz");

    const secondInvocation = prepareToolInput({
      abcNotation: BASE_ABC,
    });

    expect(secondInvocation.instrument).toBe(DEFAULT_INSTRUMENT);
    expect(secondInvocation.style).toBe(DEFAULT_STYLE);
  });

  it("replaces an existing Q header when tempo is provided", () => {
    const withTempoHeader = `X:1
T:Tempo Test
M:4/4
L:1/4
Q:1/4=90
K:C
C D E F |`;

    const prepared = prepareToolInput({
      abcNotation: withTempoHeader,
      tempo: 140,
    });

    expect(prepared.abcNotation).toContain("Q:1/4=140");
    expect(prepared.abcNotation).not.toContain("Q:1/4=90");
    expect(prepared.abcNotation?.match(/^Q:/gm)).toHaveLength(1);
  });

  it("inserts style directives immediately after the K line", () => {
    const styled = applyStyleToAbc(BASE_ABC, "jazz");

    expect(styled).toContain("K:C\n%%MIDI drumon\n");
    expect(styled.indexOf("%%MIDI drumon")).toBeGreaterThan(
      styled.indexOf("K:C"),
    );
    expect(styled.indexOf("%%MIDI drumon")).toBeLessThan(
      styled.indexOf("C D E F |"),
    );
  });

  it("injects the tempo header directly after the K line", () => {
    const injected = injectTempoHeader(BASE_ABC, { tempo: 128 });

    expect(injected).toContain("K:C\nQ:1/4=128\nC D E F |");
  });

  it("no longer emits %%MIDI transpose, which moved only the audio", () => {
    // `%%MIDI transpose` shifted the MIDI stream while the notation and K:
    // stayed put. Transposition is now a notation rewrite (transposeAbc).
    const injected = injectTempoHeader(BASE_ABC, { tempo: 128 });
    expect(injected).not.toContain("%%MIDI transpose");

    const prepared = prepareToolInput({ abcNotation: BASE_ABC, transpose: 3 });
    expect(prepared.abcNotation).not.toContain("%%MIDI transpose");
    // The shift is handed to the renderer instead of baked into the ABC here.
    expect(prepared.transpose).toBe(3);
  });

  it("supports fuzzy instrument matching for extracted helper tests", () => {
    expect(findInstrument("alto sax")).toBe("Alto Sax");
  });
});

// -----------------------------------------------------------------------------
// swing
// -----------------------------------------------------------------------------
//
// abcjs's addSwing() (src/synth/create-synth.js) returns early for swing <= 50
// and clamps above 75, so the old 0-100 "33 = light swing" schema recommended
// values that did nothing at all. These tests pin the real contract.

describe("normalizeSwing", () => {
  it("treats the straight point and everything below it as no swing", () => {
    expect(normalizeSwing(SWING_STRAIGHT)).toBeUndefined();
    expect(normalizeSwing(49)).toBeUndefined();
    expect(normalizeSwing(33)).toBeUndefined();
    // The old schema's "0 = straight" callers keep working rather than
    // tripping a validation error.
    expect(normalizeSwing(0)).toBeUndefined();
    expect(normalizeSwing(-10)).toBeUndefined();
  });

  it("passes through the values abcjs actually honours", () => {
    expect(normalizeSwing(51)).toBe(51);
    expect(normalizeSwing(60)).toBe(60); // 3:2
    expect(normalizeSwing(66)).toBe(66); // triplet
    expect(normalizeSwing(SWING_MAX)).toBe(SWING_MAX);
  });

  it("clamps above the maximum instead of rejecting, matching abcjs", () => {
    expect(normalizeSwing(100)).toBe(SWING_MAX);
    expect(normalizeSwing(1000)).toBe(SWING_MAX);
  });

  it("ignores absent and non-finite values", () => {
    expect(normalizeSwing(undefined)).toBeUndefined();
    expect(normalizeSwing(Number.NaN)).toBeUndefined();
    expect(normalizeSwing(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it("only reaches synthOptions when abcjs would act on it", () => {
    expect(
      prepareToolInput({ abcNotation: BASE_ABC, swing: 33 }).synthOptions,
    ).not.toHaveProperty("swing");
    expect(
      prepareToolInput({ abcNotation: BASE_ABC, swing: 66 }).synthOptions.swing,
    ).toBe(66);
    expect(
      prepareToolInput({ abcNotation: BASE_ABC, swing: 90 }).synthOptions.swing,
    ).toBe(SWING_MAX);
  });
});

// -----------------------------------------------------------------------------
// drumIntro
// -----------------------------------------------------------------------------

describe("normalizeDrumIntro", () => {
  it("drops zero and negatives, which mean no count-in", () => {
    expect(normalizeDrumIntro(0)).toBeUndefined();
    expect(normalizeDrumIntro(-2)).toBeUndefined();
    expect(normalizeDrumIntro(undefined)).toBeUndefined();
    expect(normalizeDrumIntro(Number.NaN)).toBeUndefined();
  });

  it("keeps whole bars and clamps at the maximum", () => {
    expect(normalizeDrumIntro(1)).toBe(1);
    expect(normalizeDrumIntro(2)).toBe(2);
    expect(normalizeDrumIntro(2.9)).toBe(2); // abcjs parseInt's it anyway
    expect(normalizeDrumIntro(99)).toBe(DRUM_INTRO_MAX);
  });

  it("rides into synthOptions as abcjs's own option name", () => {
    const prepared = prepareToolInput({ abcNotation: BASE_ABC, drumIntro: 2 });
    expect(prepared.synthOptions.drumIntro).toBe(2);

    expect(
      prepareToolInput({ abcNotation: BASE_ABC, drumIntro: 0 }).synthOptions,
    ).not.toHaveProperty("drumIntro");
  });
});

// -----------------------------------------------------------------------------
// buildSynthOptions — what the widget re-applies on every settings change
// -----------------------------------------------------------------------------
//
// The widget's currentSynthOptions() is a thin wrapper over this, and both
// setTune() (playback) and getMidiFile() (export) read from it, so a tool
// option dropped here is a tool option that silently stops working the moment
// the user touches the instrument or sound selector.

describe("buildSynthOptions", () => {
  it("carries instrument, sound font, and every tool option together", () => {
    const toolSynthOptions = prepareToolInput({
      abcNotation: BASE_ABC,
      swing: 66,
      drumIntro: 2,
    }).synthOptions;

    const opts = buildSynthOptions({
      instrument: "Flute",
      soundFont: "musyngkite",
      toolSynthOptions,
    });

    expect(opts.program).toBe(73); // GM flute
    expect(opts.soundFontUrl).toContain("MusyngKite");
    expect(opts.soundFontVolumeMultiplier).toBe(3.0);
    // The tool-call options survive an instrument/sound change.
    expect(opts.swing).toBe(66);
    expect(opts.drumIntro).toBe(2);
  });

  it("re-applies the same tool options under a different instrument", () => {
    const toolSynthOptions = { swing: 60, drumIntro: 1 };
    const before = buildSynthOptions({
      instrument: "Acoustic Grand Piano",
      soundFont: "default",
      toolSynthOptions,
    });
    const after = buildSynthOptions({
      instrument: "Cello",
      soundFont: "dry",
      toolSynthOptions,
    });

    expect(before.program).toBe(0);
    expect(after.program).toBe(42);
    expect(after.soundFontVolumeMultiplier).toBe(0.4);
    for (const key of ["swing", "drumIntro"] as const) {
      expect(after[key]).toBe(before[key]);
    }
  });

  it("falls back to piano and the default bank for unknown names", () => {
    const opts = buildSynthOptions({ instrument: "Theremin" });
    expect(opts.program).toBe(0);
    expect(opts.soundFontUrl).toContain("FluidR3_GM");
  });
});
