/**
 * @file The fallback / share page gets the widget's annotation fit (#28).
 *
 * The page's script is an inline string, so it can't import src/score-fit.ts.
 * These pull its `overhangPadding` out of the generated HTML, run it against a
 * stand-in SVG, and hold it to the widget's `paddingRightToFit` on the same
 * geometry, so the two can't drift.
 */
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { generatePlayerHtml } from "../src/browser-fallback";
import { paddingRightToFit } from "../src/score-fit";

const html = generatePlayerHtml({
  abcNotation: 'X:1\nT:Fit probe\nM:4/4\nL:1/8\nK:C\n"^Stretto: truth in augmentation"CDEF GABc |\n',
});

function pageOverhangPadding(): (el: unknown, tunes: unknown) => number | null {
  const start = html.indexOf("function overhangPadding(el, tunes) {");
  expect(start).toBeGreaterThan(0);
  const end = html.indexOf("\n    }\n", start);
  const source = html.slice(start, end + "\n    }".length);
  return vm.runInNewContext(`(${source})`);
}

function fakeScore(viewBoxWidth: number, rightEdges: number[], rightmargin?: number) {
  const svg = {
    viewBox: { baseVal: { width: viewBoxWidth } },
    querySelectorAll: (selector: string) => {
      expect(selector).toBe(".abcjs-annotation, .abcjs-chord, .abcjs-lyric");
      return rightEdges.map((edge) => ({ getBBox: () => ({ x: edge - 40, width: 40 }) }));
    },
  };
  const el = { querySelector: () => svg };
  const tunes = [{ formatting: rightmargin === undefined ? {} : { rightmargin } }];
  return { el, tunes };
}

describe("fallback page annotation fit (#28)", () => {
  const overhangPadding = pageOverhangPadding();

  it.each([
    { width: 770, edges: [820] },
    { width: 770, edges: [300, 771] },
    { width: 770, edges: [770.4] },
    { width: 770, edges: [500] },
    { width: 770, edges: [] },
  ])("agrees with the widget: width $width, edges $edges", ({ width, edges }) => {
    const { el, tunes } = fakeScore(width, edges);
    expect(overhangPadding(el, tunes)).toBe(paddingRightToFit(edges, width));
  });

  it("leaves a tune that sets its own %%rightmargin alone", () => {
    const { el, tunes } = fakeScore(770, [900], 20);
    expect(overhangPadding(el, tunes)).toBeNull();
  });

  it("renders through the fitting engraver", () => {
    expect(html).toContain("var visualObj = engrave(sheetEl, fullAbc);");
    expect(html).toMatch(/opts\.paddingright = pad;\s*return ABCJS\.renderAbc\(el, abc, opts\);/);
  });
});
