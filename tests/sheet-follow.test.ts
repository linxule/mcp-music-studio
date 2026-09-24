// =============================================================================
// Score follow during playback (src/sheet-follow.ts)
//
// The follow used to scrollIntoView({ block: "nearest" }) the first lit
// notehead on every beat: on a two-staff system the bass staff stayed below the
// fold, the view lurched mid-line whenever the top voice rested, and a hand
// scroll was pulled back within a beat. The unit is now the whole system, and
// the view moves only when it has to.
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  FOLLOW_MARGIN_PX,
  followScrollTarget,
  type FollowInput,
} from "../src/sheet-follow";

// A 500px view over a 2000px score; systems are 180px tall.
const base: FollowInput = {
  systemTop: 0,
  systemBottom: 180,
  scrollTop: 0,
  viewHeight: 500,
  scrollHeight: 2000,
  lineChanged: false,
};

const at = (over: Partial<FollowInput>) => followScrollTarget({ ...base, ...over });

describe("followScrollTarget", () => {
  it("leaves the view alone while the playing system is fully visible", () => {
    expect(at({ systemTop: 200, systemBottom: 380 })).toBeNull();
  });

  it("brings the WHOLE system into view, not just its top staff", () => {
    // Treble staff visible, bass staff cut off at the bottom edge — the old bug.
    const target = at({ systemTop: 400, systemBottom: 580 });
    expect(target).toBe(400 - FOLLOW_MARGIN_PX);
  });

  it("puts a new system that starts low in the view at the top, to show what follows", () => {
    expect(at({ systemTop: 300, systemBottom: 480, lineChanged: true })).toBe(
      300 - FOLLOW_MARGIN_PX,
    );
  });

  it("does not move for a new system already in the upper third (keeps the title up on line 1)", () => {
    expect(at({ systemTop: 80, systemBottom: 260, lineChanged: true })).toBeNull();
  });

  it("scrolls back up to a system above the view", () => {
    expect(at({ scrollTop: 900, systemTop: 300, systemBottom: 480 })).toBe(
      300 - FOLLOW_MARGIN_PX,
    );
  });

  it("clamps to the end of the score", () => {
    expect(at({ systemTop: 1900, systemBottom: 2000, lineChanged: true })).toBe(1500);
  });

  it("shows the top of a system taller than the view", () => {
    expect(at({ systemTop: 700, systemBottom: 1400 })).toBe(700 - FOLLOW_MARGIN_PX);
  });

  it("does nothing when the whole score fits", () => {
    expect(at({ scrollHeight: 500, systemTop: 400, systemBottom: 580 })).toBeNull();
  });

  it("does nothing for sub-pixel corrections", () => {
    // A system taller than the view, already shown from (almost) its top.
    expect(at({ scrollTop: 401, systemTop: 412, systemBottom: 1200 })).toBeNull();
  });

  it("does nothing without usable geometry", () => {
    expect(at({ viewHeight: 0, systemTop: 900, systemBottom: 1000 })).toBeNull();
    expect(at({ systemTop: Number.NaN })).toBeNull();
  });
});
