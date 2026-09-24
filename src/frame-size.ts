/**
 * @file How tall each widget should be, from what the host tells us.
 *
 * The ext-apps SDK reports the widget's height to the host on every resize
 * (`ui/notifications/size-changed`), measuring `<html>` at `height:
 * max-content` — the layout's INTRINSIC height. A host with a flexible
 * container then sizes the frame to that number. Neither widget used to have a
 * stable intrinsic height:
 *
 *  * Strudel: the code editor's full height. It only stayed ~400px because the
 *    SDK happened to measure before the editor existed; the first resize after
 *    that (the chat column changing width, entering fullscreen) re-measured and
 *    the frame jumped to the height of every line of code — a stage taller than
 *    the screen, with the visuals cut off.
 *  * Sheet music: `.sheet-section { max-height: 80vh }`, where `vh` is the
 *    frame's own height, which is the number being reported — a feedback loop
 *    that settles at roughly five times the toolbar's height regardless of the
 *    screen.
 *
 * The ext-apps spec's "Container Dimensions" section says what to do instead:
 * a fixed `containerDimensions.height` means fill the frame; `maxHeight` means
 * size to content, up to that maximum. Fullscreen means take over the window.
 * {@link resolveFrameSize} turns that into one of two policies, and each widget
 * applies it with CSS (see `applyFrameSize`).
 */

/** The slice of `McpUiHostContext` this module reads. */
export interface HostSizing {
  displayMode?: string;
  containerDimensions?: { height?: number; maxHeight?: number } | null;
}

export type FrameSize =
  /** Occupy exactly this many px; `null` means the whole frame (100vh). */
  | { mode: "fill"; height: number | null }
  /** Size to content, but never taller than this many px. */
  | { mode: "flow"; maxHeight: number };

export interface InlineCap {
  /** Fraction of the screen's available height an inline widget may take. */
  share: number;
  min: number;
  max: number;
}

/** Sheet music: sized to the score, up to most of the screen. */
export const SHEET_INLINE_CAP: InlineCap = { share: 0.7, min: 420, max: 860 };
/** Strudel: a fixed stage; the code scrolls inside it. */
export const STRUDEL_INLINE_CAP: InlineCap = { share: 0.55, min: 400, max: 640 };

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

/**
 * The tallest an INLINE widget should be when the host sets no maximum: a share
 * of the screen, so it fits on a laptop and on a phone. `screenHeight` is
 * `screen.availHeight` — not the frame's viewport, which in an auto-sized frame
 * is just the height we last reported.
 */
export function inlineMaxHeight(screenHeight: number | undefined, cap: InlineCap): number {
  const screen = positive(screenHeight);
  if (screen === null) return cap.max;
  return Math.min(cap.max, Math.max(cap.min, Math.round(screen * cap.share)));
}

export function resolveFrameSize(
  ctx: HostSizing | undefined,
  screenHeight: number | undefined,
  cap: InlineCap,
): FrameSize {
  const dims = ctx?.containerDimensions ?? {};
  const fixed = positive(dims.height);
  const max = positive(dims.maxHeight);

  // Fixed container: the host sized the frame; fill it exactly (100vh — the
  // frame IS the container, and vh can't disagree with it the way a number
  // copied out of an older context can).
  if (fixed !== null) return { mode: "fill", height: null };

  // Fullscreen over a flexible container: the frame follows our reports, so
  // "fill the window" has to be reported as a height. Up to the host's max if
  // it gave one; otherwise whatever frame the host granted.
  if (ctx?.displayMode === "fullscreen") return { mode: "fill", height: max };

  const inlineCap = inlineMaxHeight(screenHeight, cap);
  return { mode: "flow", maxHeight: max !== null ? Math.min(max, inlineCap) : inlineCap };
}

/**
 * Publish a {@link FrameSize} to CSS: `data-frame="fill|flow"` on `<html>` plus
 * `--frame-height` (fill) or `--frame-max-height` (flow). The stylesheets own
 * what each widget does with them.
 */
export function applyFrameSize(size: FrameSize, root: HTMLElement = document.documentElement): void {
  root.dataset.frame = size.mode;
  if (size.mode === "fill") {
    root.style.setProperty("--frame-height", size.height === null ? "100vh" : `${size.height}px`);
    root.style.removeProperty("--frame-max-height");
  } else {
    root.style.setProperty("--frame-max-height", `${size.maxHeight}px`);
    root.style.removeProperty("--frame-height");
  }
}

export interface SafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Publish the host's safe-area insets as `--safe-*` custom properties.
 *
 * Each widget's CSS ADDS them to its own gutter. Writing them straight into
 * `.main`'s inline padding (what both widgets used to do) replaced that
 * gutter instead: a host reporting zero insets took the sheet's 8px padding
 * down to nothing.
 */
export function applySafeAreaInsets(
  insets: SafeAreaInsets,
  root: HTMLElement = document.documentElement,
): void {
  for (const side of ["top", "right", "bottom", "left"] as const) {
    const px = Number.isFinite(insets[side]) ? Math.max(0, insets[side]) : 0;
    root.style.setProperty(`--safe-${side}`, `${px}px`);
  }
}

/** `screen.availHeight`, when the environment has one. */
export function screenAvailHeight(): number | undefined {
  try {
    return typeof screen !== "undefined" ? screen.availHeight : undefined;
  } catch {
    return undefined;
  }
}
