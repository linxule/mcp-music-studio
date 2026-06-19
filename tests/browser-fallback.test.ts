import { describe, expect, it } from "vitest";
import { generatePlayerHtml } from "../src/browser-fallback";
import { generateStrudelPlayerHtml } from "../src/strudel-browser-fallback";

describe("generatePlayerHtml (ABC browser fallback)", () => {
  const ABC = "X:1\nT:Fallback Tune\nK:C\nCDEF|";

  it("returns a non-empty self-contained HTML document", () => {
    const html = generatePlayerHtml({ abcNotation: ABC });
    expect(typeof html).toBe("string");
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("references ABCJS (loads it from a CDN script tag)", () => {
    const html = generatePlayerHtml({ abcNotation: ABC });
    expect(html.toLowerCase()).toContain("abcjs");
    // The fallback emits the abcjs CDN script.
    expect(html).toContain("cdn.jsdelivr.net/npm/abcjs");
  });

  it("embeds the supplied ABC notation content", () => {
    const html = generatePlayerHtml({ abcNotation: ABC });
    // The note sequence survives into the rendered HTML (textarea + INIT JSON).
    expect(html).toContain("CDEF|");
    // The title is extracted from T: and shown (HTML-escaped where needed).
    expect(html).toContain("Fallback Tune");
  });

  it("HTML-escapes ABC content so angle brackets can't break the markup", () => {
    // A T: header with markup-significant characters must be escaped in output.
    const tricky = 'X:1\nT:Tune <b>&"\nK:C\nCDEF|';
    const html = generatePlayerHtml({ abcNotation: tricky });
    // Raw, unescaped injection of the title must NOT appear.
    expect(html).not.toContain("Tune <b>");
    // Escaped forms are present instead.
    expect(html).toContain("&lt;b&gt;");
  });

  it("bakes injected tempo into the embedded notation when tempo is given", () => {
    const html = generatePlayerHtml({ abcNotation: ABC, tempo: 132 });
    expect(html).toContain("Q:1/4=132");
  });
});

describe("generateStrudelPlayerHtml (Strudel browser fallback)", () => {
  const CODE = 'sound("bd hh")';

  it("returns a non-empty self-contained HTML document", () => {
    const html = generateStrudelPlayerHtml({ code: CODE });
    expect(typeof html).toBe("string");
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("embeds the supplied code (HTML-escaped) inside the strudel editor", () => {
    const html = generateStrudelPlayerHtml({ code: CODE });
    expect(html).toContain("<strudel-editor");
    // escapeHtml turns " into &quot;, so the escaped form is what appears.
    expect(html).toContain("sound(&quot;bd hh&quot;)");
    // The raw double-quoted form must NOT be embedded verbatim.
    expect(html).not.toContain('sound("bd hh")');
  });

  it("loads the Strudel REPL from its CDN", () => {
    const html = generateStrudelPlayerHtml({ code: CODE });
    expect(html).toContain("@strudel/repl");
  });

  it("prepends setcps when a bpm is supplied", () => {
    const html = generateStrudelPlayerHtml({ code: CODE, bpm: 120 });
    expect(html).toContain("setcps(");
  });
});
