/**
 * Notation-level transposition.
 *
 * The tool used to emit `%%MIDI transpose N`, an audio-only directive: the
 * synth played in the new key while the printed score and its `K:` header
 * stayed in the old one. Anyone reading the sheet music got the wrong notes.
 *
 * `ABCJS.strTranspose(abc, tuneObjArray, steps)` (public API since 6.x) rewrites
 * the ABC *string* instead — key signatures, accidentals, note letters and chord
 * symbols all move together — so the score and the audio agree. It needs a
 * parsed tune whose character offsets line up with the string being rewritten,
 * hence the `parseOnly` round-trip on the very same text.
 *
 * Lives in its own module because it needs ABCJS: `music-logic.ts` is imported
 * (via `shared/tool-defs.ts`) by the Cloudflare Worker and must stay
 * dependency-light.
 */
import ABCJS from "abcjs";

/**
 * Transpose ABC by `steps` semitones, notation and key signature together.
 *
 * Returns the input unchanged for a falsy/zero shift, for unparseable ABC, or
 * if abcjs throws — transposition is a nicety, never a reason to lose the
 * score.
 */
export function transposeAbc(
  abc: string,
  steps: number | undefined,
  parse: (abc: string) => ABCJS.TuneObjectArray = (input) =>
    ABCJS.parseOnly(input),
): string {
  if (!steps || !Number.isFinite(steps)) return abc;
  try {
    const parsed = parse(abc);
    // abcjs types TuneObjectArray as a 1-tuple, but unparseable input really
    // does come back empty at runtime — hence the widened length check.
    if (!parsed || (parsed as unknown as unknown[]).length === 0) return abc;
    return ABCJS.strTranspose(abc, parsed, Math.trunc(steps));
  } catch (err) {
    console.warn("Transpose failed; leaving notation unchanged:", err);
    return abc;
  }
}
