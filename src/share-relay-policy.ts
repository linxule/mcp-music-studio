// What the share page's WebMCP relay offers a browser agent (src/share-host.ts).
// Pure, so tests can hold it without mounting the page.

/** Widget tools that need the review panel, which this page does not have. */
export const RELAY_EXCLUDED_TOOLS = ["explain-selection", "suggest-edit"];

/**
 * Tools that make sound. Anyone can craft a share link, so on this page
 * nothing runs until Play is pressed on the page: these are offered to the
 * browser's agent only after a press of Play there (the widget reports
 * `playPressed` in its state). Whoever presses it — a person, or anything
 * that can click in the page — could also just press Play directly. Staging (set-pattern), stop and undo
 * are always offered.
 */
export const RELAY_AFTER_PLAY_PRESS = ["play-current-music", "swap-pattern"];

/** The relay's exclusion on this page, given whether Play has been pressed on it. */
export function shareRelayExclude(playPressed: () => boolean): (name: string) => boolean {
  return (name) => RELAY_EXCLUDED_TOOLS.includes(name) || (!playPressed() && RELAY_AFTER_PLAY_PRESS.includes(name));
}

/**
 * Every relayed tool returns the widget's whole state, including the link
 * author's code — third-party content for the agent (WebMCP's
 * untrustedContentHint), on writes as much as reads (Codex + Kimi review).
 */
export function shareRelayAnnotations(): Record<string, unknown> {
  return { untrustedContentHint: true };
}
