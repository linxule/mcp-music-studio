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

  /** Pull the JSON payload the page hands to the REPL and parse it as a browser would. */
  function readInit(html: string): { code: string; autoplay: boolean } {
    const m = html.match(
      /<script type="application\/json" id="init-data">([\s\S]*?)<\/script>/,
    );
    expect(m, "init-data JSON block must be present").toBeTruthy();
    return JSON.parse(m![1]!);
  }

  it("hands the code to the REPL as JSON, not as HTML-escaped editor text", () => {
    const html = generateStrudelPlayerHtml({ code: CODE });
    expect(html).toContain("<strudel-editor");
    // The editor element ships EMPTY — <strudel-editor> reads innerHTML verbatim
    // and never entity-decodes it, so HTML-escaped code would reach the
    // evaluator as `sound(&quot;bd hh&quot;)` and throw a SyntaxError.
    expect(html).not.toContain("&quot;bd hh&quot;");
    expect(readInit(html).code).toBe(CODE);
  });

  it("round-trips quotes and an HTML comment terminator inside a string", () => {
    // `-->` inside a string used to close the <!-- ... --> comment wrapper and
    // spill the rest of the pattern into the document as markup.
    const tricky = 'sound("bd").gain(0.8) // <-- watch out --> & "quoted"';
    const html = generateStrudelPlayerHtml({ code: tricky });
    expect(readInit(html).code).toBe(tricky);
    // Nothing markup-significant escapes the JSON block.
    expect(html).not.toContain('// <-- watch out --> & "quoted"');
  });

  it("escapes a </script> payload so it cannot break out of the JSON block", () => {
    const attack = 'sound("bd") // </script><script>globalThis.pwned=1</script>';
    const html = generateStrudelPlayerHtml({ code: attack });
    expect(html).not.toContain("<script>globalThis.pwned=1");
    expect(readInit(html).code).toBe(attack);
  });

  it("loads the code into the editor via setCode after the REPL is ready", () => {
    const html = generateStrudelPlayerHtml({ code: CODE });
    expect(html).toContain("ed.setCode(INIT.code)");
  });

  it("calls evaluate with a single boolean (StrudelMirror's real signature)", () => {
    const html = generateStrudelPlayerHtml({ code: CODE });
    expect(html).toContain("ed.evaluate(true)");
    // The old two-argument form made the boolean an ignored second parameter.
    expect(html).not.toMatch(/ed\.evaluate\(\s*code\s*,/);
  });

  it("guards autoplay's document click so the Play button can't double-evaluate", () => {
    const html = generateStrudelPlayerHtml({ code: CODE, autoplay: true });
    expect(html).toContain("function autoStart(ev)");
    // Bails when playback already started, and ignores clicks on the transport.
    expect(html).toContain("if (playing)");
    expect(html).toContain("closest('.controls')");
    // The unguarded once-only listener is gone.
    expect(html).not.toMatch(/function autoStart\(\)\s*\{\s*startPattern\(\);/);
  });

  it("omits the autoplay click handler when autoplay is false", () => {
    const html = generateStrudelPlayerHtml({ code: CODE, autoplay: false });
    expect(html).not.toContain("autoStart");
    expect(readInit(html).autoplay).toBe(false);
  });

  it("loads the Strudel REPL from its CDN", () => {
    const html = generateStrudelPlayerHtml({ code: CODE });
    expect(html).toContain("@strudel/repl");
  });

  it("prepends setcps when a bpm is supplied", () => {
    const html = generateStrudelPlayerHtml({ code: CODE, bpm: 120 });
    const init = readInit(html);
    expect(init.code).toContain("setcps(");
    expect(init.code.endsWith(CODE)).toBe(true);
  });
});
