/**
 * openStage(): whether a piece's request to show the stage is honoured.
 *
 * A listener who leaves a stage a piece opened has declined it — for THAT
 * piece. The decline used to last for the page's lifetime, so one "back to
 * the code" silenced openStage() for every later piece (Kimi review, 0.11).
 * Now it holds only while the same code asks again; a different piece (or an
 * edited one) asks afresh. Pure, so it is tested without the widget.
 */
export interface PieceStagePolicy {
  /** May the piece with this code open the stage? */
  shouldOpen(code: string): boolean;
  /** The stage was opened at this piece's request. */
  opened(code: string): void;
  /** The listener left the stage (button or Escape). */
  left(): void;
}

export function createPieceStagePolicy(): PieceStagePolicy {
  let openedFor: string | null = null;
  let declinedFor: string | null = null;
  return {
    shouldOpen: (code) => declinedFor === null || declinedFor !== code,
    opened(code) {
      openedFor = code;
    },
    left() {
      if (openedFor !== null) declinedFor = openedFor;
      openedFor = null;
    },
  };
}
