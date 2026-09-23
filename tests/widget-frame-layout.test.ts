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

  it("the Strudel editor wraps lines on a narrow stage, without saving the change", () => {
    const fn = STRUDEL.slice(STRUDEL.indexOf("function syncEditorToWidth()"));
    expect(fn).toContain('changeEditorSetting(editor, "isLineWrappingEnabled"');
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
