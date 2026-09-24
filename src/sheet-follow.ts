/**
 * @file Where the score should scroll while it plays — pure, so it is testable.
 *
 * The follow used to call `scrollIntoView({ block: "nearest" })` on the FIRST
 * highlighted notehead of every beat. Three things went wrong:
 *
 *  * "nearest" scrolls just far enough to show that one notehead, at the
 *    bottom edge. On a two-staff system that is a treble note, so the bass
 *    staff under it stayed out of view — until a beat where the top voice
 *    rested, the bass note became "first", and the view lurched down mid-line.
 *  * It ran on every beat with smooth scrolling, so a hand scroll during
 *    playback was pulled back within a beat or two.
 *  * `scrollIntoView` scrolls every scrollable ancestor, not just the score.
 *
 * Now the unit is the SYSTEM (all staves of one line: abcjs's timing events
 * carry its `top`/`height`), the view moves only when the playing system is out
 * of view or a new one starts below the reading band, and it moves the score
 * scroller alone. The caller also stands down for a few seconds after the user
 * scrolls by hand.
 */

export interface FollowInput {
  /** Playing system's top and bottom, px, in the scroller's content coordinates. */
  systemTop: number;
  systemBottom: number;
  scrollTop: number;
  /** The scroller's clientHeight / scrollHeight. */
  viewHeight: number;
  scrollHeight: number;
  /** A different system than the last event's. */
  lineChanged: boolean;
}

/** Space left above the system when it is brought to the top of the view. */
export const FOLLOW_MARGIN_PX = 12;

/**
 * A new system whose top already sits in the upper part of the view (and fits)
 * is left where it is: the lines after it are visible, which is what reading
 * ahead needs, and the title stays on screen for the first line.
 */
export const READING_BAND = 1 / 3;

/** How long a hand scroll suspends the follow. */
export const USER_SCROLL_GRACE_MS = 4000;

/** The scrollTop to move to, or null to leave the view alone. */
export function followScrollTarget(input: FollowInput): number | null {
  const { systemTop, systemBottom, scrollTop, viewHeight, scrollHeight } = input;
  if (!(viewHeight > 0) || !Number.isFinite(systemTop) || !Number.isFinite(systemBottom)) {
    return null;
  }
  const maxScroll = Math.max(0, scrollHeight - viewHeight);
  if (maxScroll === 0) return null; // the whole score fits

  const viewBottom = scrollTop + viewHeight;
  const fullyVisible = systemTop >= scrollTop && systemBottom <= viewBottom;
  if (fullyVisible) {
    if (!input.lineChanged) return null;
    if (systemTop - scrollTop <= viewHeight * READING_BAND) return null;
  }

  // Bring the system to the top so the lines after it show below; a system
  // taller than the view at least shows its first staff.
  const target = Math.min(maxScroll, Math.max(0, Math.round(systemTop - FOLLOW_MARGIN_PX)));
  return Math.abs(target - scrollTop) < 2 ? null : target;
}
