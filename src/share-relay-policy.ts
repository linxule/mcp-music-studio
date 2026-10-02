// What the share page's WebMCP relay offers a browser agent (src/share-host.ts).
// Pure, so tests can hold it without mounting the page.

export const RELAY_EXCLUDED_TOOLS = ["explain-selection", "suggest-edit"];

/**
 * Tools that make sound. Anyone can craft a share link, so on this page
 * nothing runs without a deliberate human press: these are offered to the
 * browser's agent only after a person pressed Play here once (the widget
 * reports `humanPlayed` in its state). Staging (set-pattern), stop and undo
 * are always offered.
 */
export const RELAY_AFTER_HUMAN_PLAY = ["play-current-music", "swap-pattern"];

/** The relay's exclusion on this page, given whether a person has pressed Play. */
export function shareRelayExclude(humanPlayed: () => boolean): (name: string) => boolean {
  return (name) => RELAY_EXCLUDED_TOOLS.includes(name) || (!humanPlayed() && RELAY_AFTER_HUMAN_PLAY.includes(name));
}

/**
 * Every relayed tool returns the widget's whole state, including the link
 * author's code — third-party content for the agent (WebMCP's
 * untrustedContentHint), on writes as much as reads (Codex + Kimi review).
 */
export function shareRelayAnnotations(): Record<string, unknown> {
  return { untrustedContentHint: true };
}
