// =============================================================================
// H() values as numbers — pure, shared by the widget and the share page
//
// Hydra parameters are numeric, and H(pattern) hands a shader whatever value
// the hap under the playhead carries. Until 0.5.12 anything that wasn't
// already a number became 0, so H("<c3 e3 g3>") or H(note("c3 e3")) drove a
// shader with nothing. Now a note becomes its MIDI number — by Strudel's own
// rule (@strudel/core noteToMidi: letter, accidentals `#`/`s` up and `b`/`f`
// down, default octave 3, `(octave + 1) * 12 + chroma`), so c3 = 48, a4 = 69.
// A frequency becomes its MIDI pitch too, so the same shader follows either.
// =============================================================================

const CHROMAS: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const ACCIDENTALS: Record<string, number> = { "#": 1, b: -1, s: 1, f: -1 };

/** Strudel's noteToMidi, or null when `text` isn't a note name. */
export function noteNameToMidi(text: string): number | null {
  const match = /^([a-gA-G])([#bsf]*)(-?[0-9]*)$/.exec(text);
  if (!match) return null;
  const [, letter, accidentals, octave] = match;
  const offset = accidentals.split("").reduce((sum, a) => sum + ACCIDENTALS[a], 0);
  const oct = octave === "" ? 3 : Number(octave);
  return (oct + 1) * 12 + CHROMAS[letter.toLowerCase()] + offset;
}

/**
 * A hap value as the number a shader should see; 0 when there is none, and
 * never NaN or ±Infinity. `freq` outranks `note`, as in Strudel's valueToMidi
 * (note("c3").freq(440) sounds at 440 Hz, so the shader sees 69, not 48).
 */
export function hapNumber(value: unknown): number {
  const n = rawHapNumber(value);
  return Number.isFinite(n) ? n : 0;
}

function rawHapNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed !== "" && Number.isFinite(Number(trimmed))) return Number(trimmed);
    return noteNameToMidi(trimmed) ?? 0;
  }
  if (value && typeof value === "object") {
    const v = value as { note?: unknown; n?: unknown; freq?: unknown; value?: unknown };
    if (typeof v.freq === "number" && v.freq > 0) return 12 * Math.log2(v.freq / 440) + 69;
    if (v.note !== undefined) return rawHapNumber(v.note);
    if (v.n !== undefined) return rawHapNumber(v.n);
    if (v.value !== undefined) return rawHapNumber(v.value);
  }
  return 0;
}
