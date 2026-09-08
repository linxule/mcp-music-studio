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

/** Advance past a `'…'` / `"…"` literal; returns the index just past it. */
function skipStringLiteral(code: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < code.length) {
    const c = code[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    if (c === "\n") return i; // unterminated — bail at the line end
    i++;
  }
  return i;
}

/**
 * Blank out everything that is NOT executable code, preserving offsets.
 *
 * Three classes of text can contain a look-alike and must not activate a
 * visual layer we then have nothing to draw into:
 *
 *   - `// line comments` and `/* block comments *​/` — the guide's own examples
 *     comment out `.pianoroll()` calls.
 *   - string and template literals — `s("bd").note("piano roll")` is innocent,
 *     but so is a pattern that quotes shader source or a URL. A string
 *     containing `.pianoroll()` or `initHydra(` used to stage a WebGL layer for
 *     a pattern that never asked for one.
 *
 * Strings also used to swallow code: `s("http://x // y").pianoroll()` had the
 * rest of the line stripped as a comment (the old `(^|[^:])` guard only covered
 * `://`), so the real draw call went undetected. Skipping literals *first*
 * removes the need for that guard entirely.
 *
 * Template `${…}` bodies ARE scanned — they are code — so a draw call inside an
 * interpolation still counts. Every skipped character is replaced with a space
 * (newlines kept) so offsets and line structure survive for anything that wants
 * to report a position later.
 *
 * Regex literals are deliberately NOT tracked: Strudel patterns essentially
 * never contain one, and the only cost of getting it wrong is a stray quote
 * inside a regex opening a phantom string — which can suppress a detection, not
 * corrupt the source (nothing here rewrites the pattern).
 */
export function stripNonCode(code: string): string {
  const n = code.length;
  const out = code.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };

  let i = 0;
  let mode: "code" | "template" = "code";
  let brace = 0;
  const templateBraces: number[] = [];

  while (i < n) {
    const c = code[i];

    if (mode === "template") {
      if (c === "\\") {
        blank(i, i + 2);
        i += 2;
        continue;
      }
      if (c === "`") {
        blank(i, i + 1);
        mode = "code";
        i++;
        continue;
      }
      if (c === "$" && code[i + 1] === "{") {
        blank(i, i + 2);
        brace++;
        templateBraces.push(brace);
        mode = "code";
        i += 2;
        continue;
      }
      blank(i, i + 1);
      i++;
      continue;
    }

    if (c === "/" && code[i + 1] === "/") {
      let j = i;
      while (j < n && code[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = skipStringLiteral(code, i, c);
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "`") {
      blank(i, i + 1);
      mode = "template";
      i++;
      continue;
    }
    if (c === "{") {
      brace++;
      i++;
      continue;
    }
    if (c === "}") {
      if (templateBraces.length > 0 && templateBraces[templateBraces.length - 1] === brace) {
        templateBraces.pop();
        brace--;
        blank(i, i + 1);
        mode = "template";
        i++;
        continue;
      }
      brace = Math.max(0, brace - 1);
      i++;
      continue;
    }
    i++;
  }

  return out.join("");
}

export interface VizIntent {
  /** Pattern draws with a Strudel 2D visual (pianoroll, scope, ...). */
  strudelViz: boolean;
  /** Pattern calls initHydra() — stage the WebGL layer. */
  hydra: boolean;
  /** Any visual at all — reveal the backdrop + scrim. */
  any: boolean;
}

/** Inspect pattern code (comments and string literals ignored) for visual intent. */
export function detectViz(code: string): VizIntent {
  const scan = stripNonCode(code);
  const strudelViz = VIZ_METHOD_RE.test(scan) || VIZ_ALL_RE.test(scan);
  const hydra = HYDRA_INIT_RE.test(scan);
  return { strudelViz, hydra, any: strudelViz || hydra };
}
