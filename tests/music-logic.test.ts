import { describe, expect, it } from "vitest";
import {
  DEFAULT_INSTRUMENT,
  DEFAULT_STYLE,
  DRUM_INTRO_MAX,
  INSTRUMENTS,
  SWING_MAX,
  SWING_STRAIGHT,
  applyStyleToAbc,
  buildSynthOptions,
  findInstrument,
  injectTempoHeader,
  isSoundFontName,
  isStyleName,
  normalizeDrumIntro,
  normalizeSwing,
  prepareToolInput,
  resolveInvocationSettings,
} from "../src/music-logic";
import { ABC_GUIDES } from "../src/abc-guide";

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
// General MIDI instrument table
// -----------------------------------------------------------------------------
//
// The table used to hold 30 names while the tool description called it "the full
// list" and the guide printed all 128 — so "Banjo" silently played a piano.

describe("INSTRUMENTS covers General MIDI", () => {
  it("maps every GM program 0-127 exactly once", () => {
    const programs = Object.values(INSTRUMENTS);
    expect(programs.length).toBe(128);
    expect([...programs].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 128 }, (_, i) => i),
    );
  });

  it("keeps the historical names (saved widget selections must not break)", () => {
    for (const [name, program] of Object.entries({
      "Acoustic Grand Piano": 0,
      "Electric Piano": 4,
      "Church Organ": 19,
      "Acoustic Guitar (Nylon)": 24,
      "Electric Guitar (Clean)": 27,
      "String Ensemble": 48,
      "Alto Sax": 65,
      "Flute": 73,
      "Pan Flute": 75,
      "Steel Drums": 114,
    })) {
      expect(INSTRUMENTS[name]).toBe(program);
    }
  });

  it("resolves every name the instruments guide advertises", () => {
    // The guide topic lists "NN Name | NN Name" rows. An agent that reads the
    // guide and passes one of those names back must get that exact program.
    const rows = [...ABC_GUIDES.instruments.matchAll(/(?:^|\| )(\d{1,3}) ([^|\n]+)/gm)];
    expect(rows.length).toBeGreaterThan(50);
    for (const [, program, rawName] of rows) {
      const name = rawName!.trim();
      const resolved = findInstrument(name);
      expect(resolved, `guide name "${name}"`).toBeDefined();
      expect(INSTRUMENTS[resolved!], `guide name "${name}"`).toBe(Number(program));
    }
  });
});

describe("findInstrument", () => {
  it.each([
    ["banjo", "Banjo", 105],
    ["Banjo", "Banjo", 105],
    ["Sitar", "Sitar", 104],
    ["xylophone", "Xylophone", 13],
    ["kalimba", "Kalimba", 108],
    ["harpsichord", "Harpsichord", 6],
    // Fuzzy, but deterministic: the LOWEST GM program among the matches.
    ["sax", "Soprano Sax", 64],
    ["piano", "Acoustic Grand Piano", 0],
    ["slap bass", "Slap Bass 1", 36],
    // Alias for a program whose canonical key here is spelled differently.
    ["Electric Piano 1", "Electric Piano", 4],
    ["String Ensemble 1", "String Ensemble", 48],
    ["Hammond Organ", "Drawbar Organ", 16],
  ])("resolves %j to %s (GM %i)", (query, expected, program) => {
    expect(findInstrument(query as string)).toBe(expected);
    expect(INSTRUMENTS[expected as string]).toBe(program);
  });

  it("returns undefined rather than a silent piano for a non-instrument", () => {
    expect(findInstrument("kazoo")).toBeUndefined();
    expect(findInstrument("theremin")).toBeUndefined();
    expect(findInstrument("   ")).toBeUndefined();
  });
});

describe("resolveInvocationSettings surfaces the resolution", () => {
  it("says nothing when the name matched exactly", () => {
    const settings = resolveInvocationSettings({ instrument: "banjo" });
    expect(settings.instrument).toBe("Banjo");
    expect(settings.warning).toBeUndefined();
  });

  it("reports a fuzzy match", () => {
    const settings = resolveInvocationSettings({ instrument: "sax" });
    expect(settings.instrument).toBe("Soprano Sax");
    expect(settings.requestedInstrument).toBe("sax");
    expect(settings.warning).toContain("Soprano Sax");
    expect(settings.warning).toContain("GM program 64");
  });

  it("reports the fallback for an unknown name", () => {
    const settings = resolveInvocationSettings({ instrument: "kazoo" });
    expect(settings.instrument).toBe(DEFAULT_INSTRUMENT);
    expect(settings.requestedInstrument).toBe("kazoo");
    expect(settings.warning).toContain("Unknown instrument");
    expect(settings.warning).toContain("kazoo");
  });

  it("carries the resolution through prepareToolInput", () => {
    const prepared = prepareToolInput({ abcNotation: BASE_ABC, instrument: "kazoo" });
    expect(prepared.instrument).toBe(DEFAULT_INSTRUMENT);
    expect(prepared.warning).toContain("Unknown instrument");
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

// =============================================================================
// Codex review #17 — a user-supplied string must never index an object through
// its prototype.
//
// Repro before the fix: `INSTRUMENT_ALIASES["constructor"]` resolved through
// Object.prototype to the `Object` constructor, and findInstrument returned it
// as if it were an instrument name. resolveInvocationSettings then called
// `.toLowerCase()` on a function and threw
// `TypeError: instrument.toLowerCase is not a function` — a nonsense
// instrument name became a crash instead of the honest "no such instrument".
// `buildSynthOptions({instrument:"constructor"})` likewise handed abcjs a
// FUNCTION as its GM `program`.
// =============================================================================

describe("prototype keys are not instruments (Codex #17)", () => {
  const PROTOTYPE_KEYS = [
    "constructor",
    "Constructor",
    "toString",
    "hasOwnProperty",
    "valueOf",
    "isPrototypeOf",
  ];

  it("findInstrument never returns an inherited property", () => {
    for (const key of PROTOTYPE_KEYS) {
      const found = findInstrument(key);
      expect(typeof found === "undefined" || typeof found === "string").toBe(
        true,
      );
      if (typeof found === "string") {
        expect(Object.hasOwn(INSTRUMENTS, found)).toBe(true);
      }
    }
  });

  it("resolveInvocationSettings survives them instead of throwing", () => {
    for (const key of PROTOTYPE_KEYS) {
      const settings = resolveInvocationSettings({ instrument: key });
      expect(typeof settings.instrument).toBe("string");
      expect(Object.hasOwn(INSTRUMENTS, settings.instrument)).toBe(true);
    }
  });

  it("buildSynthOptions returns a numeric GM program for them", () => {
    for (const key of PROTOTYPE_KEYS) {
      const opts = buildSynthOptions({ instrument: key });
      expect(typeof opts.program).toBe("number");
      expect(opts.program).toBe(0);
    }
  });

  it("isStyleName and isSoundFontName reject them", () => {
    for (const key of PROTOTYPE_KEYS) {
      expect(isStyleName(key)).toBe(false);
      expect(isSoundFontName(key)).toBe(false);
      // applyStyleToAbc must therefore leave the score alone rather than
      // splicing an inherited value in after the K: line.
      expect(applyStyleToAbc(BASE_ABC, key)).toBe(BASE_ABC);
    }
  });

  it("prepareToolInput keeps a usable style/instrument for them", () => {
    const prepared = prepareToolInput({
      abcNotation: BASE_ABC,
      instrument: "constructor",
      style: "toString",
    });
    expect(Object.hasOwn(INSTRUMENTS, prepared.instrument)).toBe(true);
    expect(prepared.style).toBe(DEFAULT_STYLE);
  });
});
