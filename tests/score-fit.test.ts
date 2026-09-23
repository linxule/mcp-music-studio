// =============================================================================
// Right-edge room for text abcjs hangs off a note (src/score-fit.ts, #28)
//
// "^Stretto: truth in augmentation" in a line's last bar ran ~50 SVG units past
// the right edge and was clipped on device. The widget measures overhanging
// text after engraving and re-engraves once with a wider `paddingright`; this
// is the arithmetic. The browser half is guarded in widget-frame-layout.test.ts.
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  ABCJS_SCREEN_PADDING_RIGHT,
  OVERHANG_MARGIN,
  paddingRightToFit,
} from "../src/score-fit";

describe("paddingRightToFit", () => {
  it("leaves a score whose text all fits alone", () => {
    expect(paddingRightToFit([120, 540, 769.9], 770)).toBeNull();
    expect(paddingRightToFit([], 770)).toBeNull();
  });

  it("widens the padding by the overhang plus a margin", () => {
    // The measured case: viewBox 770, the label ends at 820.
    expect(paddingRightToFit([300, 820], 770)).toBe(
      ABCJS_SCREEN_PADDING_RIGHT + 50 + OVERHANG_MARGIN,
    );
  });

  it("uses the worst overhang of several", () => {
    expect(paddingRightToFit([790, 830.2, 801], 770)).toBe(
      Math.ceil(ABCJS_SCREEN_PADDING_RIGHT + 60.2 + OVERHANG_MARGIN),
    );
  });

  it("builds on a padding other than abcjs's default", () => {
    expect(paddingRightToFit([800], 770, 40)).toBe(40 + 30 + OVERHANG_MARGIN);
  });

  it("ignores sub-unit rounding and unusable numbers", () => {
    expect(paddingRightToFit([770.4], 770)).toBeNull();
    expect(paddingRightToFit([Number.NaN, Number.POSITIVE_INFINITY], 770)).toBeNull();
    expect(paddingRightToFit([900], 0)).toBeNull();
    expect(paddingRightToFit([900], Number.NaN)).toBeNull();
  });
});
