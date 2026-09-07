/**
 * The browser-fallback player loads abcjs from a CDN by version number, while
 * the ext-apps widget bundles whatever `node_modules/abcjs` resolves to. Those
 * two used to drift in silence — the fallback HTML hard-coded a version in two
 * separate URLs, so a dependency bump left the fallback rendering with a
 * different abcjs than the widget and nothing caught it.
 *
 * One constant now feeds both URLs, and this test pins it to what is installed.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { ABCJS_CDN_BASE, ABCJS_CDN_VERSION } from "../src/abcjs-version";
import { generatePlayerHtml } from "../src/browser-fallback";

const require = createRequire(import.meta.url);
const installed = require("abcjs/package.json") as { version: string };

describe("abcjs CDN version", () => {
  it("matches the installed abcjs package version", () => {
    expect(ABCJS_CDN_VERSION).toBe(installed.version);
  });

  it("builds a pinned jsDelivr base (no floating range)", () => {
    expect(ABCJS_CDN_BASE).toBe(
      `https://cdn.jsdelivr.net/npm/abcjs@${installed.version}`,
    );
    expect(ABCJS_CDN_BASE).not.toMatch(/[@^~][^0-9]*[\^~]/);
  });

  it("is the only abcjs version the fallback page names", () => {
    const html = generatePlayerHtml({
      abcNotation: "X:1\nT:Version Check\nK:C\nCDEF|",
    });

    // Both the stylesheet and the script tag are present...
    expect(html).toContain(`${ABCJS_CDN_BASE}/abcjs-audio.css`);
    expect(html).toContain(`${ABCJS_CDN_BASE}/dist/abcjs-basic-min.js`);

    // ...and every abcjs CDN reference in the page agrees on the version.
    const versions = new Set(
      [...html.matchAll(/cdn\.jsdelivr\.net\/npm\/abcjs@([^/"']+)/g)].map(
        (m) => m[1],
      ),
    );
    expect([...versions]).toEqual([installed.version]);
  });
});
