// H() used to flatten every non-number to 0, so pitch could never drive a
// shader. hapNumber() follows @strudel/core's noteToMidi for note names.
import { describe, expect, it } from "vitest";
import { hapNumber, noteNameToMidi } from "../src/shared/hap-number";

describe("noteNameToMidi (Strudel's rule)", () => {
  it.each([
    ["c3", 48],
    ["a4", 69],
    ["c", 48], // default octave 3
    ["eb4", 63],
    ["f#2", 42],
    ["cs3", 49], // `s` = sharp
    ["bf3", 58], // `f` = flat
    ["C-1", 0],
  ])("%s → %i", (name, midi) => {
    expect(noteNameToMidi(name)).toBe(midi);
  });

  it("returns null for anything that isn't a note name", () => {
    expect(noteNameToMidi("bd")).toBeNull();
    expect(noteNameToMidi("")).toBeNull();
    expect(noteNameToMidi("h3")).toBeNull();
  });
});

describe("hapNumber", () => {
  it("passes numbers and numeric strings through", () => {
    expect(hapNumber(0.5)).toBe(0.5);
    expect(hapNumber("3")).toBe(3);
    expect(hapNumber("-1.5")).toBe(-1.5);
    expect(hapNumber(Number.NaN)).toBe(0);
  });

  it("turns notes into MIDI numbers, bare or in a control object", () => {
    expect(hapNumber("e3")).toBe(52);
    expect(hapNumber({ note: "g3", s: "sawtooth" })).toBe(55);
    expect(hapNumber({ note: 60 })).toBe(60);
    expect(hapNumber({ n: 4, s: "piano" })).toBe(4);
  });

  it("turns a frequency into its MIDI pitch", () => {
    expect(hapNumber({ freq: 440 })).toBeCloseTo(69);
    expect(hapNumber({ freq: 220 })).toBeCloseTo(57);
  });

  it("lets freq outrank note, as Strudel does (Codex)", () => {
    // note("c3").freq(440) sounds at 440 Hz.
    expect(hapNumber({ note: "c3", freq: 440 })).toBeCloseTo(69);
  });

  it("never returns NaN or Infinity (Codex)", () => {
    expect(hapNumber("c-")).toBe(0);
    expect(hapNumber({ freq: Infinity })).toBe(0);
    expect(hapNumber(Infinity)).toBe(0);
  });

  it("gives 0 for what can't be a number", () => {
    expect(hapNumber("bd")).toBe(0);
    expect(hapNumber({ s: "bd" })).toBe(0);
    expect(hapNumber(undefined)).toBe(0);
    expect(hapNumber(null)).toBe(0);
  });
});
