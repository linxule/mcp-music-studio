/**
 * @file Room at the right edge for text abcjs hangs off a note (#28): pure,
 *       so it is testable.
 *
 * abcjs places an annotation (`"^Stretto: truth in augmentation"`) at its
 * note and lets it run right, and it reserves no horizontal room for it. One
 * that starts in a line's last bar ends past the SVG's right edge, and the
 * score card clipped it ("Stretto: truth in augmenta"). Chord symbols and
 * lyrics are centred on their note and can overhang the same way. The widget
 * measures that text after engraving, and if any of it overhangs it engraves
 * once more with abcjs's `paddingright` option widened by the overhang.
 *
 * Only the padding changes. abcjs lays the staff out at a fixed width (740 px
 * unless the tune sets `%%staffwidth`), and the right padding only widens the
 * SVG's viewBox, so the second engraving is the same layout with a little
 * more room, scaled down slightly to fit the frame. (The exception is a tune
 * that sets `%%stretchlast`, where padding feeds the last-line stretch.)
 */

/**
 * abcjs's `paddingright` on screen when nothing sets it (write/renderer.js
 * `setPadding`: 15; 68 for print). A tune's own `%%rightmargin` outranks the
 * option, so a re-engrave cannot move it.
 */
export const ABCJS_SCREEN_PADDING_RIGHT = 15;

/** Clear space left after the longest overhang, in SVG user units. */
export const OVERHANG_MARGIN = 6;

/** Text abcjs hangs off a note without reserving room for it (`add_classes`). */
export const OVERHANG_TEXT_SELECTOR = ".abcjs-annotation, .abcjs-chord, .abcjs-lyric";

/**
 * The `paddingright` that brings every right edge inside the SVG, or null when
 * nothing overhangs (or the geometry is unusable). Edges and width are in SVG
 * user units, which don't depend on how wide the frame happens to be.
 */
export function paddingRightToFit(
  rightEdges: readonly number[],
  viewBoxWidth: number,
  currentPadding = ABCJS_SCREEN_PADDING_RIGHT,
): number | null {
  if (!(viewBoxWidth > 0)) return null;
  let right = Number.NEGATIVE_INFINITY;
  for (const edge of rightEdges) {
    if (Number.isFinite(edge) && edge > right) right = edge;
  }
  const overhang = right - viewBoxWidth;
  // Half a unit is glyph rounding, not a clipped letter.
  if (!(overhang > 0.5)) return null;
  return Math.ceil(currentPadding + overhang + OVERHANG_MARGIN);
}
