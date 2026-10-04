/**
 * @file Character offsets between the user's raw ABC and the ABC abcjs drew.
 *
 * abcjs reports every clicked element's `startChar`/`endChar` against the
 * string it was handed, which is `effectiveAbc(raw)` — the raw notation with a
 * style preset's `%%MIDI` block inserted after `K:` and, after a pick from the
 * Instrument menu, the first voice's `%%MIDI program` number rewritten
 * (`deriveEffectiveAbc`, src/abc-program.ts). The editor shows the RAW text,
 * so a click has to be mapped back before it can select anything there, and an
 * editor selection mapped forward before abcjs can highlight it.
 *
 * Pure and abcjs-free. The edits are rebuilt the same way `deriveEffectiveAbc`
 * builds the text, and `tests/abc-offsets.test.ts` holds the two to each other
 * over the guide corpus, every style and an override.
 */
import { findLeadingProgram } from "./abc-program.js";
import { applyStyleToAbc } from "./music-logic.js";

/** One replacement, in the coordinates of the text BEFORE it was applied. */
interface TextEdit {
  start: number;
  removed: number;
  inserted: number;
}

export interface AbcOffsetMap {
  /** The effective ABC these edits produce (equal to `deriveEffectiveAbc`). */
  effective: string;
  /** An offset into the effective ABC → the raw ABC. */
  toRaw(offset: number): number;
  /** An offset into the raw ABC → the effective ABC. */
  toEffective(offset: number): number;
}

/**
 * The style preset is a pure insertion. Where it went is found by diffing
 * rather than re-deriving `applyStyleToAbc`'s rule, so the two cannot drift:
 * the common prefix ends where the insertion starts, and if the remainder does
 * not line up the text was not a pure insertion and `null` says so.
 */
function insertionEdit(before: string, after: string): TextEdit | null {
  const inserted = after.length - before.length;
  if (inserted === 0) return before === after ? { start: 0, removed: 0, inserted: 0 } : null;
  if (inserted < 0) return null;
  let start = 0;
  while (start < before.length && before[start] === after[start]) start++;
  return after.slice(start + inserted) === before.slice(start) ? { start, removed: 0, inserted } : null;
}

/** Map `offset` through one edit, forwards (before → after). */
function forward(offset: number, edit: TextEdit): number {
  // What starts where text is inserted comes after the insertion.
  if (edit.removed === 0) return offset < edit.start ? offset : offset + edit.inserted;
  if (offset <= edit.start) return offset;
  if (offset >= edit.start + edit.removed) return offset - edit.removed + edit.inserted;
  return edit.start; // inside replaced text: its start
}

/** Map `offset` through one edit, backwards (after → before). */
function backward(offset: number, edit: TextEdit): number {
  if (offset <= edit.start) return offset;
  if (offset >= edit.start + edit.inserted) return offset - edit.inserted + edit.removed;
  return edit.start; // inside inserted text (a %%MIDI block): where it went in
}

/**
 * The offset map for `raw` under the widget's current options, or `null` if
 * the derivation can't be described as these edits (then a click selects
 * nothing rather than the wrong characters).
 */
export function abcOffsetMap(
  raw: string,
  options: { style: string; programOverride?: number | null },
): AbcOffsetMap | null {
  const edits: TextEdit[] = [];
  let text = raw;
  const program = options.programOverride;
  if (program !== undefined && program !== null && Number.isInteger(program)) {
    const leading = findLeadingProgram(raw);
    if (leading) {
      const replacement = String(program);
      edits.push({
        start: leading.replaceStart,
        removed: leading.replaceEnd - leading.replaceStart,
        inserted: replacement.length,
      });
      text = raw.slice(0, leading.replaceStart) + replacement + raw.slice(leading.replaceEnd);
    }
  }
  const styled = applyStyleToAbc(text, options.style);
  const styleEdit = insertionEdit(text, styled);
  if (!styleEdit) return null;
  edits.push(styleEdit);
  return {
    effective: styled,
    toRaw: (offset) => edits.reduceRight((o, edit) => backward(o, edit), offset),
    toEffective: (offset) => edits.reduce((o, edit) => forward(o, edit), offset),
  };
}
