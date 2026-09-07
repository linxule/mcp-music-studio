// =============================================================================
// Visualization detection — pure helpers shared by the Strudel widget and tests
//
// DOM-free by design so vitest can exercise it in Node. The widget
// (src/strudel-app.ts) decides whether to reveal the visuals backdrop and
// whether to stage the Hydra (WebGL) layer based on these predicates.
// =============================================================================

const DRAW_METHODS =
  "pianoroll|punchcard|wordfall|spiral|pitchwheel|tscope|scope|fscope|spectrum";

/**
 * Strudel draw methods that paint onto `#test-canvas` (all resolve through
 * @strudel/draw's getDrawContext()). Matches `.pianoroll(` etc.
 */
export const VIZ_METHOD_RE = new RegExp(`\\.(${DRAW_METHODS})\\s*\\(`);

/**
 * The other documented form: `all(pianoroll)` on its own line draws every
 * running pattern into one roll. The draw method is passed as a bare reference
 * here, so VIZ_METHOD_RE (which needs a leading dot) never sees it.
 */
export const VIZ_ALL_RE = new RegExp(`\\ball\\s*\\(\\s*(${DRAW_METHODS})\\b`);

/**
 * Hydra activation. `initHydra()` is exported into the REPL's eval scope by
 * @strudel/hydra (bundled with @strudel/repl since 1.x) and creates/reuses
 * `#hydra-canvas`. Also matches `all(...)`-style usage since the call is what
 * matters, not the receiver.
 */
export const HYDRA_INIT_RE = /\binitHydra\s*\(/;

/**
 * Strip `//` line comments so a commented-out `.pianoroll()` (the guide uses
 * such examples) doesn't flip the backdrop on with nothing to draw. The
 * `(^|[^:])` guard avoids stripping the `//` inside protocol URLs like
 * `https://…` (e.g. in samples('https://...') calls).
 */
export function stripLineComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

export interface VizIntent {
  /** Pattern draws with a Strudel 2D visual (pianoroll, scope, ...). */
  strudelViz: boolean;
  /** Pattern calls initHydra() — stage the WebGL layer. */
  hydra: boolean;
  /** Any visual at all — reveal the backdrop + scrim. */
  any: boolean;
}

/** Inspect pattern code (comments ignored) for visual intent. */
export function detectViz(code: string): VizIntent {
  const scan = stripLineComments(code);
  const strudelViz = VIZ_METHOD_RE.test(scan) || VIZ_ALL_RE.test(scan);
  const hydra = HYDRA_INIT_RE.test(scan);
  return { strudelViz, hydra, any: strudelViz || hydra };
}
