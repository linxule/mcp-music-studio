// =============================================================================
// Widget layout guards (source-text, in the style of widget-display-mode.test.ts)
//
// The DOM half of the sizing and score-follow fixes. The policies themselves are
// unit-tested in frame-size.test.ts and sheet-follow.test.ts; these pin that the
// widgets actually use them and that the old layout bugs don't creep back:
//
//  * sheet music: `max-height: 80vh` on the score, where vh is the auto-sized
//    frame's own height (a feedback loop), and a follow built on
//    scrollIntoView() that hid the lower staff and fought hand scrolling;
//  * Strudel: min-heights that made the length of the code the height of the
//    widget, so a re-measure pushed the stage past the bottom of the screen;
//  * both: never declaring the display modes they support.
// =============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");

const ABC = read("src/mcp-app.ts");
const ABC_CSS = read("src/mcp-app.css");
const ABC_HTML = read("mcp-app.html");
const STRUDEL = read("src/strudel-app.ts");
const STRUDEL_CSS = read("src/strudel-app.css");

/** CSS with comments removed, so prose about the old rules doesn't count. */
const rules = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("both widgets follow the host's container", () => {
  for (const [label, source] of [
    ["mcp-app.ts", ABC],
    ["strudel-app.ts", STRUDEL],
  ] as const) {
    it(`${label} declares the display modes it supports`, () => {
      expect(source).toContain('{ availableDisplayModes: ["inline", "fullscreen"] }');
    });

    it(`${label} re-derives its height on display-mode and container changes`, () => {
      expect(source).toContain("resolveFrameSize(");
      expect(source).toContain("if (ctx.displayMode || ctx.containerDimensions) syncFrameSize();");
      // A granted fullscreen must resize even if the host sends no context update.
      expect(source).toMatch(/if \(result\?\.mode\) displayMode = result\.mode;\s*syncFullscreenButton\(\);\s*syncFrameSize\(\);/);
    });
  }
});

describe("both widgets take the host's fonts and safe area", () => {
  for (const [label, source, css] of [
    ["mcp-app", ABC, ABC_CSS],
    ["strudel-app", STRUDEL, STRUDEL_CSS],
  ] as const) {
    it(`${label} applies host fonts and ADDS safe-area insets to its gutter`, () => {
      expect(source).toContain("applyHostFonts(ctx.styles.css.fonts)");
      expect(source).toContain("applySafeAreaInsets(ctx.safeAreaInsets)");
      // Inline padding replaced the CSS gutter; zero insets meant no gutter.
      expect(source).not.toMatch(/mainEl\.style\.padding/);
      const main = rules(css).match(/(^|\n)\.main \{[^}]*\}/)?.[0] ?? "";
      for (const side of ["top", "right", "bottom", "left"]) {
        expect(main).toContain(`var(--safe-${side}, 0px)`);
      }
    });
  }

  it("falls back to system fonts when the host sends none", () => {
    expect(read("src/global.css")).toContain(
      "font-family: var(--font-sans, system-ui, -apple-system, sans-serif);",
    );
    expect(STRUDEL_CSS).toContain(
      "font-family: var(--font-sans, system-ui, -apple-system, sans-serif);",
    );
  });
});

describe("neither widget can be panned sideways on a phone", () => {
  // On iOS the widgets were wider than the frame (Strudel: a toolbar that
  // never wrapped, 587px in a 380px frame), so the whole document panned
  // sideways and cut off the clefs, Play and the line numbers.
  for (const [label, css] of [
    ["mcp-app.css", ABC_CSS],
    ["strudel-app.css", STRUDEL_CSS],
  ] as const) {
    it(`${label} clips horizontal overflow at the root and stops iOS text inflation`, () => {
      const html = rules(css).match(/(^|\n)html \{[^}]*\}/)?.[0] ?? "";
      expect(html).toContain("overflow-x: clip;");
      expect(html).toContain("text-size-adjust: 100%;");
    });
  }

  it("the Strudel toolbar wraps and its buttons don't break mid-label", () => {
    const css = rules(STRUDEL_CSS);
    expect(css).toMatch(/\.toolbar \{[^}]*flex-wrap: wrap;/);
    expect(css).toMatch(/\.control-btn \{[^}]*white-space: nowrap;/);
  });

  it("the Strudel editor always wraps lines, without saving the change", () => {
    const fn = STRUDEL.slice(STRUDEL.indexOf("function syncEditorToWidth()"));
    expect(fn).toContain('if (first) changeEditorSetting(editor, "isLineWrappingEnabled", true);');
    // A fresh <strudel-editor> starts over, so it gets wrapping too.
    expect(STRUDEL).toMatch(/currentTheme = null;\s*editorCompact = null;/);
    // A phone host whose frame is wider than the screen still counts as compact.
    const compact = STRUDEL.slice(STRUDEL.indexOf("function isCompactStage("));
    expect(compact).toContain('app.getHostContext()?.platform === "mobile"');
    expect(STRUDEL).toMatch(/new ResizeObserver\(\(\) => \{\s*syncVizCanvasSize\(\);\s*syncEditorToWidth\(\);/);
  });

  it("applies the editor theme without persisting it for later widgets", () => {
    const fn = STRUDEL.slice(STRUDEL.indexOf("function applyEditorTheme("));
    expect(fn.slice(0, fn.indexOf("\n}\n"))).toContain('changeEditorSetting(editor, "theme", wanted);');
    expect(STRUDEL).toContain('const wanted = theme || DEFAULT_EDITOR_THEME;');
  });
});

describe("sheet music widget", () => {
  it("no longer sizes the score from vh", () => {
    expect(rules(ABC_CSS)).not.toMatch(/max-height:\s*\d+vh/);
    expect(rules(ABC_CSS)).toContain("max-height: var(--frame-max-height, none)");
  });

  it("keeps the score in the frame when the editor is open (Codex review of #24)", () => {
    // A hand-resized editor under a 420px cap pushed the whole score below the
    // frame: 0px of it visible, the document 689px tall in a 420px frame.
    const main = rules(ABC_CSS).match(/(^|\n)\.main \{[^}]*\}/)?.[0] ?? "";
    expect(main).toContain("overflow-y: auto;");
    const editor = rules(ABC_CSS).match(/(^|\n)\.abc-editor \{[^}]*\}/)?.[0] ?? "";
    expect(editor).toContain(
      "max-height: calc(var(--frame-max-height, var(--frame-height, 100vh)) * 0.4);",
    );
  });

  it("does not smooth-scroll by CSS (the follow scrolls explicitly)", () => {
    expect(rules(ABC_CSS)).not.toContain("scroll-behavior");
  });

  it("follows the playing SYSTEM and scrolls only the score", () => {
    expect(ABC).not.toMatch(/\.scrollIntoView\(/);
    expect(ABC).toContain("followScrollTarget({");
    expect(ABC).toContain("sheetSectionEl.scrollTo({");
  });

  it("stands down while the reader scrolls by hand", () => {
    expect(ABC).toMatch(/followLine = line;\s*if \(userIsScrolling\(\)\) return;/);
    for (const event of ["wheel", "touchmove", "keydown", "pointerdown"]) {
      expect(ABC).toContain(`sheetSectionEl.addEventListener("${event}"`);
    }
  });

  it("lets a line-end annotation spill into the card instead of being cut at the SVG", () => {
    const css = rules(ABC_CSS);
    expect(css).toMatch(/\.sheet-section #sheet-music svg \{\s*overflow: visible !important;/);
    expect(css).toMatch(/\.sheet-section \{\s*overflow-x: hidden;/);
  });

  it("makes room for a long line-end annotation instead of letting it clip (#28)", () => {
    // Every engraving goes through engraveScore(): two renderAbc calls, both
    // in it (the plain one, and the re-engrave with a wider paddingright).
    const calls = ABC.match(/ABCJS\.renderAbc\(/g) ?? [];
    expect(calls).toHaveLength(2);
    const fn = ABC.slice(ABC.indexOf("function engraveScore("));
    const engrave = fn.slice(0, fn.indexOf("\n}\n"));
    expect(engrave.match(/ABCJS\.renderAbc\(/g)).toHaveLength(2);
    expect(engrave).toContain("{ ...SCORE_RENDER_OPTIONS, paddingright }");
    expect(ABC).toContain(
      'const SCORE_RENDER_OPTIONS = { responsive: "resize", add_classes: true } as const;',
    );
    // Full renders, the editor and the streaming preview all use it.
    expect(ABC).toContain("state.visualObj = engraveScore(abcWithStyle);");
    expect(ABC).toContain("const visualObj = engraveScore(effective);");
    expect(ABC).toMatch(/partialRenderTimer = setTimeout\([\s\S]*?engraveScore\(abcWithStyle\);/);
    // Measured in SVG user units, against the viewBox.
    const measure = ABC.slice(ABC.indexOf("function overhangPadding("));
    expect(measure.slice(0, measure.indexOf("\n}\n"))).toMatch(
      /querySelectorAll<SVGGraphicsElement>\(OVERHANG_TEXT_SELECTOR\)[\s\S]*?getBBox\(\)[\s\S]*?paddingRightToFit\(edges, width\)/,
    );
  });

  it("tells the model to keep section labels off a line's last bar", () => {
    expect(read("src/abc-guide.ts")).toContain(
      "Put section labels on the first bar of a line and keep them short",
    );
  });

  it("keeps the score keyboard-scrollable", () => {
    expect(ABC_HTML).toContain('<section class="sheet-section" tabindex="0" aria-label="Sheet music">');
  });
});

describe("strudel widget", () => {
  it("has no content-driven min-heights on the stage or editor", () => {
    expect(rules(STRUDEL_CSS)).not.toMatch(/min-height:\s*3\d\dpx/);
  });

  it("gives the stage a decided height and lets the editor fill it", () => {
    const css = rules(STRUDEL_CSS);
    expect(css).toContain("height: var(--frame-max-height, 100%)");
    expect(css).toContain('[data-frame="fill"] .main');
    expect(css).toMatch(/\.cm-editor \{\s*height: 100% !important;/);
  });

  it("does not size the editor wrapper from script any more", () => {
    expect(STRUDEL).not.toContain('sibling.style.minHeight');
  });
});
