/**
 * Fullscreen for the share page's stage. iPhone Safari has no Element
 * Fullscreen API (only video can go fullscreen), so `requestFullscreen` is
 * missing there and the button did nothing (field test, 2026-10-03). Where the
 * API is missing, disabled or refused, the stage fills the viewport with CSS
 * instead: the browser's own bars stay, but the page is all player.
 */
export const VIEWPORT_FILL_CLASS = "viewport-fill";

export interface FullscreenStage {
  requestFullscreen?: () => Promise<void> | void;
  classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean };
}

export interface FullscreenDocument {
  fullscreenEnabled?: boolean;
  fullscreenElement?: unknown;
  exitFullscreen?: () => Promise<void>;
}

/** Enter fullscreen; always succeeds, natively where the browser allows it. */
export async function enterStageFullscreen(stage: FullscreenStage, doc: FullscreenDocument): Promise<"native" | "viewport"> {
  if (typeof stage.requestFullscreen === "function" && doc.fullscreenEnabled !== false) {
    try {
      await stage.requestFullscreen();
      return "native";
    } catch {
      // No activation, or the browser refused: fall back to the viewport.
    }
  }
  stage.classList.add(VIEWPORT_FILL_CLASS);
  return "viewport";
}

/** Leave either kind of fullscreen. */
export async function leaveStageFullscreen(stage: FullscreenStage, doc: FullscreenDocument): Promise<void> {
  stage.classList.remove(VIEWPORT_FILL_CLASS);
  if (doc.fullscreenElement && doc.exitFullscreen) await doc.exitFullscreen().catch(() => undefined);
}

/** Whether the stage is fullscreen by either route. */
export function stageIsFullscreen(stage: FullscreenStage, doc: FullscreenDocument): boolean {
  return Boolean(doc.fullscreenElement) || stage.classList.contains(VIEWPORT_FILL_CLASS);
}
