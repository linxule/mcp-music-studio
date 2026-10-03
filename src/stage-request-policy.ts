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
  /**
   * The piece with this code asks for the stage. Returns whether the caller
   * should open it now. When the stage is already open, the asking piece
   * becomes the one it is open for — leaving then declines THIS piece, not the
   * one that opened it earlier (Codex review, round 2).
   */
  requested(code: string, stageIsOpen: boolean): boolean;
  /** The stage was opened at this piece's request. */
  opened(code: string): void;
  /** The listener left the stage (button or Escape). */
  left(): void;
}

export function createPieceStagePolicy(): PieceStagePolicy {
  let openedFor: string | null = null;
  let declinedFor: string | null = null;
  const shouldOpen = (code: string) => declinedFor === null || declinedFor !== code;
  return {
    shouldOpen,
    requested(code, stageIsOpen) {
      if (!shouldOpen(code)) return false;
      if (stageIsOpen) {
        openedFor = code;
        return false;
      }
      return true;
    },
    opened(code) {
      openedFor = code;
    },
    left() {
      if (openedFor !== null) declinedFor = openedFor;
      openedFor = null;
    },
  };
}
