// =============================================================================
// Widget height policy (src/frame-size.ts)
//
// The ext-apps SDK reports each widget's intrinsic height to the host, and a
// host with a flexible container sizes the frame to it. Before this policy the
// Strudel widget's intrinsic height was the length of its code (a stage taller
// than the screen after the first re-measure), and the sheet's was a `vh`
// feedback loop. These pin the spec's Container Dimensions semantics: fixed
// height → fill; maxHeight → never exceed it; fullscreen → fill.
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  SHEET_INLINE_CAP,
  STRUDEL_INLINE_CAP,
  inlineMaxHeight,
  resolveFrameSize,
} from "../src/frame-size";

const CAP = { share: 0.5, min: 400, max: 700 };

describe("inlineMaxHeight", () => {
  it("takes a share of the screen, clamped to the cap's range", () => {
    expect(inlineMaxHeight(1000, CAP)).toBe(500);
    expect(inlineMaxHeight(600, CAP)).toBe(400); // phone: floor
    expect(inlineMaxHeight(2160, CAP)).toBe(700); // 4K: ceiling
  });

  it("falls back to the ceiling when the screen height is unknown or junk", () => {
    expect(inlineMaxHeight(undefined, CAP)).toBe(700);
    expect(inlineMaxHeight(0, CAP)).toBe(700);
    expect(inlineMaxHeight(Number.NaN, CAP)).toBe(700);
  });
});

describe("resolveFrameSize", () => {
  it("fills a fixed-height container (100vh — the frame is the container)", () => {
    expect(
      resolveFrameSize({ containerDimensions: { height: 480 } }, 1000, CAP),
    ).toEqual({ mode: "fill", height: null });
  });

  it("fills a fixed-height container in fullscreen as well", () => {
    expect(
      resolveFrameSize(
        { displayMode: "fullscreen", containerDimensions: { height: 900 } },
        1000,
        CAP,
      ),
    ).toEqual({ mode: "fill", height: null });
  });

  it("fullscreen over a FLEXIBLE container reports the host's max as its height", () => {
    // The frame follows our size reports here, so filling has to be reported.
    expect(
      resolveFrameSize(
        { displayMode: "fullscreen", containerDimensions: { maxHeight: 1100 } },
        1000,
        CAP,
      ),
    ).toEqual({ mode: "fill", height: 1100 });
  });

  it("fullscreen with no dimensions fills whatever frame the host granted", () => {
    expect(resolveFrameSize({ displayMode: "fullscreen" }, 1000, CAP)).toEqual({
      mode: "fill",
      height: null,
    });
  });

  it("inline never exceeds the host's maxHeight", () => {
    expect(
      resolveFrameSize(
        { displayMode: "inline", containerDimensions: { maxHeight: 420 } },
        1000,
        CAP,
      ),
    ).toEqual({ mode: "flow", maxHeight: 420 });
  });

  it("inline under a generous maxHeight still fits the screen", () => {
    expect(
      resolveFrameSize(
        { displayMode: "inline", containerDimensions: { maxHeight: 5000 } },
        1000,
        CAP,
      ),
    ).toEqual({ mode: "flow", maxHeight: 500 });
  });

  it("inline with no container info caps at a share of the screen", () => {
    expect(resolveFrameSize(undefined, 1000, CAP)).toEqual({ mode: "flow", maxHeight: 500 });
    expect(resolveFrameSize({ containerDimensions: null }, 1000, CAP)).toEqual({
      mode: "flow",
      maxHeight: 500,
    });
  });

  it("ignores non-positive or non-numeric dimensions", () => {
    expect(
      resolveFrameSize({ containerDimensions: { height: 0, maxHeight: -5 } }, 1000, CAP),
    ).toEqual({ mode: "flow", maxHeight: 500 });
  });
});

describe("the shipped caps", () => {
  it("keep both widgets on a 1080p laptop screen with room to spare", () => {
    const laptop = 1040; // screen.availHeight on a 1920×1080 display
    expect(inlineMaxHeight(laptop, SHEET_INLINE_CAP)).toBeLessThan(laptop);
    expect(inlineMaxHeight(laptop, STRUDEL_INLINE_CAP)).toBeLessThan(laptop);
  });

  it("never shrink the Strudel stage below its old fixed ~400px", () => {
    expect(inlineMaxHeight(500, STRUDEL_INLINE_CAP)).toBeGreaterThanOrEqual(400);
  });
});
