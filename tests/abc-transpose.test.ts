/**
 * Transposition must move the *notation*, not just the MIDI stream.
 *
 * The tool used to emit `%%MIDI transpose N`, which shifted playback while the
 * printed score and its K: header stayed in the original key — so the sheet
 * music on screen disagreed with the audio coming out of it. These tests pin
 * the replacement (`ABCJS.strTranspose`) by re-parsing the transposed string
 * and asserting on the key signature and the actual note pitches.
 */
import { describe, expect, it } from "vitest";
import ABCJS from "abcjs";
import { transposeAbc } from "../src/abc-transpose";
import { DEFAULT_ABC_NOTATION } from "../src/abc-guide";

/** Key signature root + accidental of the first tune, e.g. "Eb". */
function keyOf(abc: string): string {
  const key = ABCJS.parseOnly(abc)[0].getKeySignature();
  const acc = key.acc ?? "";
  return `${key.root}${acc === "natural" ? "" : acc}`;
}

/** Every sounding pitch in the tune, in order (abcjs `pitch` units). */
function pitchesOf(abc: string): number[] {
  const pitches: number[] = [];
  const tune = ABCJS.parseOnly(abc)[0];
  for (const line of tune.lines ?? []) {
    for (const staff of line.staff ?? []) {
      for (const voice of staff.voices ?? []) {
        for (const el of voice as Array<Record<string, any>>) {
          for (const note of el.pitches ?? []) {
            pitches.push(note.pitch as number);
          }
        }
      }
    }
  }
  return pitches;
}

describe("transposeAbc", () => {
  it("moves the key signature and the notes of the default tune together", () => {
    const original = DEFAULT_ABC_NOTATION;
    const up3 = transposeAbc(original, 3);

    // C major up a minor third is E-flat major — in the notation, not just MIDI.
    expect(keyOf(original)).toBe("C");
    expect(keyOf(up3)).toBe("Eb");
    expect(up3).toMatch(/^K:\s*Eb/m);

    // Every printed pitch moves up two diatonic steps (a third).
    const before = pitchesOf(original);
    const after = pitchesOf(up3);
    expect(after).toHaveLength(before.length);
    expect(before.length).toBeGreaterThan(0);
    for (const [i, pitch] of after.entries()) {
      expect(pitch - before[i]).toBe(2);
    }
  });

  it("transposes downwards too", () => {
    const down2 = transposeAbc("X:1\nT:D\nM:4/4\nL:1/4\nK:D\nD E F G |", -2);
    expect(down2).toMatch(/^K:\s*C/m);
  });

  it("moves chord symbols with the notes, so style presets stay in key", () => {
    const abc = 'X:1\nT:Chords\nM:4/4\nL:1/4\nK:C\n"C"C D E F | "G7"G A B c |]';
    const up3 = transposeAbc(abc, 3);
    expect(up3).toContain('"Eb"');
    expect(up3).toContain('"Bb7"');
    expect(up3).not.toContain('"C"');
  });

  it("survives quoted V: name attributes in a multi-voice score", () => {
    // The same shape the deleted stripVoiceNameQuotes() claimed abcjs choked on.
    const abc = [
      "X:1",
      "T:Two Voices",
      "M:4/4",
      "L:1/4",
      'V:1 clef=treble name="Melody Line"',
      'V:2 clef=bass name="Bass"',
      "K:C",
      "[V:1] C E G c |]",
      "[V:2] C,2 G,2 |]",
    ].join("\n");

    const up2 = transposeAbc(abc, 2);
    expect(up2).toMatch(/^K:\s*D/m);
    // The voice names are untouched — and still quoted, in full.
    expect(up2).toContain('name="Melody Line"');
    expect(up2).toContain('name="Bass"');
  });

  it("is a no-op for zero, undefined, and non-finite shifts", () => {
    const abc = DEFAULT_ABC_NOTATION;
    expect(transposeAbc(abc, 0)).toBe(abc);
    expect(transposeAbc(abc, undefined)).toBe(abc);
    expect(transposeAbc(abc, Number.NaN)).toBe(abc);
  });

  it("returns the input unchanged when parsing throws", () => {
    const abc = DEFAULT_ABC_NOTATION;
    const boom = () => {
      throw new Error("parser exploded");
    };
    expect(transposeAbc(abc, 4, boom as never)).toBe(abc);
  });

  it("returns the input unchanged when parsing yields no tune", () => {
    const abc = DEFAULT_ABC_NOTATION;
    expect(transposeAbc(abc, 4, () => [] as never)).toBe(abc);
  });

  it("does not throw on non-ABC prose (abcjs transposes it as a tune body)", () => {
    // abcjs has no "this isn't music" verdict — it reads bare prose as a tune
    // body and shifts the letters it recognises as pitches. Documented here so
    // the behaviour is a known quantity: callers feed this validated ABC only.
    const junk = "this is not ABC notation at all";
    expect(() => transposeAbc(junk, 4)).not.toThrow();
    expect(typeof transposeAbc(junk, 4)).toBe("string");
  });

  it("never emits the audio-only %%MIDI transpose directive", () => {
    expect(transposeAbc(DEFAULT_ABC_NOTATION, 5)).not.toContain(
      "%%MIDI transpose",
    );
  });
});
