import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  // ---------------------------------------------------------------------------
  // Quoted V: name attributes
  // ---------------------------------------------------------------------------
  //
  // A `stripVoiceNameQuotes()` pass used to run over every tune here, on the
  // theory that abcjs couldn't render `V:1 name="Melody"`. It can — and the
  // regex was lossy, collapsing `name="Melody Line"` to a voice called
  // `Melody`. These pin the quoted form all the way into the page.

  it("keeps quoted V: voice names intact, spaces and all", () => {
    const fixture = readFileSync(
      join(import.meta.dirname, "fixtures/abc/02-multiple-voices.abc"),
      "utf-8",
    );
    const html = generatePlayerHtml({ abcNotation: fixture });

    // The textarea copy is HTML-escaped (" becomes &quot;), the INIT JSON copy
    // keeps the raw quote. Both must still carry the full name.
    expect(html).toContain("name=&quot;Melody&quot;");
    expect(html).toContain('name=\\"Melody\\"');
    // Never the unquoted, truncated form the old stripper produced.
    expect(html).not.toContain("name=Melody");
    expect(html).toContain("Studio fixture 02");
  });

  it("does not truncate a multi-word quoted voice name", () => {
    const abc = 'X:1\nT:Wide\nM:4/4\nL:1/4\nV:1 name="Melody Line"\nK:C\nCDEF|';
    const html = generatePlayerHtml({ abcNotation: abc });
    expect(html).toContain("Melody Line");
    // The old regex left `name=Melody` with " Line" orphaned outside it.
    expect(html).not.toContain("name=Melody ");
  });

  // ---------------------------------------------------------------------------
  // title
  // ---------------------------------------------------------------------------

  it("uses the title argument for the heading and document title", () => {
    const html = generatePlayerHtml({
      abcNotation: ABC,
      title: "Overridden Name",
    });
    expect(html).toContain("<title>Overridden Name — Music Studio</title>");
    expect(html).toContain('class="piece-title anim d2">Overridden Name<');
    // The T: header no longer supplies the heading.
    expect(html).not.toContain(">Fallback Tune<");
  });

  it("falls back to the T: header when no title is given", () => {
    const html = generatePlayerHtml({ abcNotation: ABC });
    expect(html).toContain("<title>Fallback Tune — Music Studio</title>");
  });

  it("escapes a title argument rather than injecting it raw", () => {
    const html = generatePlayerHtml({
      abcNotation: ABC,
      title: 'Danger <script>alert("x")</script>',
    });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  // ---------------------------------------------------------------------------
  // swing / drumIntro
  // ---------------------------------------------------------------------------

  it("passes only swing values abcjs honours through to the synth options", () => {
    // 33 was the old schema's headline "light swing" — abcjs ignores it.
    const ignored = generatePlayerHtml({ abcNotation: ABC, swing: 33 });
    expect(ignored).toContain('"swing":0');

    const real = generatePlayerHtml({ abcNotation: ABC, swing: 66 });
    expect(real).toContain('"swing":66');

    // abcjs clamps at 75; the page should carry the clamped value, not 100.
    const clamped = generatePlayerHtml({ abcNotation: ABC, swing: 100 });
    expect(clamped).toContain('"swing":75');
  });

  it("carries drumIntro into the player's synth options", () => {
    const html = generatePlayerHtml({ abcNotation: ABC, drumIntro: 2 });
    expect(html).toContain('"drumIntro":2');
    expect(html).toContain("opts.drumIntro = INIT.drumIntro");

    const none = generatePlayerHtml({ abcNotation: ABC });
    expect(none).toContain('"drumIntro":0');
  });

  // ---------------------------------------------------------------------------
  // transpose
  // ---------------------------------------------------------------------------

  it("transposes the notation itself, key signature included", () => {
    const html = generatePlayerHtml({ abcNotation: ABC, transpose: 3 });

    // C major up three semitones is E-flat, and it shows in the embedded ABC.
    expect(html).toContain("K:Eb");
    expect(html).not.toContain("K:C\n");
    // The old audio-only directive is gone — it moved playback while the
    // printed score stayed in the original key.
    expect(html).not.toContain("%%MIDI transpose");
    // The notes moved with it (C D E F -> Eb F G Ab, written E F G A).
    expect(html).toContain("EFGA|");
  });

  it("leaves the notation alone when no transposition is asked for", () => {
    const html = generatePlayerHtml({ abcNotation: ABC });
    expect(html).toContain("K:C");
    expect(html).toContain("CDEF|");
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

  it("leaves the code alone when no bpm is supplied", () => {
    const html = generateStrudelPlayerHtml({ code: CODE });
    const init = readInit(html);
    expect(init.code).toBe(CODE);
    expect(init.cps).toBeNull();
    expect(init.tempoPolicy).toBeNull();
  });

  it("rewrites a nested-paren setcps argument without corrupting parens", () => {
    // The old regex turned `setcps(120 / (60 * 4))` into `setcps(0.5))`,
    // a syntax error that silently killed the pattern. See src/shared/tempo.ts.
    const html = generateStrudelPlayerHtml({
      code: 'setcps(120 / (60 * 4))\nsound("bd hh")',
      bpm: 120,
    });
    expect(html).toContain("setcps(0.5)");
    expect(html).not.toContain("setcps(0.5))");
    // The tempo is replaced in place, not prepended alongside the original.
    expect(html).not.toContain("120 / (60 * 4)");
  });

  // ---------------------------------------------------------------------------
  // "unchanged-ambiguous": the pattern owns the setcps name
  // ---------------------------------------------------------------------------

  it("carries cps into INIT (code untouched) when the pattern binds setcps", () => {
    // A `const setcps = …` binding puts a prepended call in its temporal dead
    // zone, so tempo.ts returns the source byte for byte. The only route left
    // for the requested tempo is the runtime API, via INIT.cps.
    const code = 'const setcps = (x) => x\nsound("bd hh")';
    const html = generateStrudelPlayerHtml({ code, bpm: 120 });
    const init = readInit(html);

    expect(init.code).toBe(code);
    expect(init.tempoPolicy).toBe("unchanged-ambiguous");
    expect(init.cps).toBeCloseTo(0.5, 4);
    // …and the page knows to apply it after evaluation.
    expect(html).toContain("ed.repl.setCps(INIT.cps)");
    expect(html).toContain("INIT.tempoPolicy !== 'unchanged-ambiguous'");
  });

  it("does not apply a runtime tempo for the policies that bake it in", () => {
    for (const code of ['sound("bd hh")', 'setcps(0.7)\nsound("bd")']) {
      const init = readInit(generateStrudelPlayerHtml({ code, bpm: 120 }));
      expect(init.tempoPolicy).not.toBe("unchanged-ambiguous");
      expect(init.code).toContain("setcps(0.5)");
    }
  });

  // ---------------------------------------------------------------------------
  // Load failure + evaluation outcome (S7)
  // ---------------------------------------------------------------------------

  it("bounds the editor wait and offers a retry instead of polling forever", () => {
    const html = generateStrudelPlayerHtml({ code: CODE });
    expect(html).toContain("EDITOR_TIMEOUT_MS");
    expect(html).toContain("waitForEditor(EDITOR_TIMEOUT_MS)");
    expect(html).toContain("Strudel editor did not initialize");
    expect(html).toContain("Couldn't load the Strudel player");
    expect(html).toContain('id="retry-btn"');
    expect(html).toContain("location.reload()");
  });

  it("reads the evaluation outcome out of repl.state instead of assuming success", () => {
    // StrudelMirror.evaluate() never rejects — repl.evaluate() catches
    // everything and parks it on repl.state.evalError — so a try/catch alone
    // left a broken pattern reading "Playing..." forever.
    const html = generateStrudelPlayerHtml({ code: CODE });
    expect(html).toContain("await ed.evaluate(true)");
    expect(html).toContain("state.evalError");
    expect(html).toContain("state.schedulerError");
    expect(html).toContain("state.started");
    expect(html).toContain("'Error: '");
  });

  // ---------------------------------------------------------------------------
  // Title (T9)
  // ---------------------------------------------------------------------------

  it("defaults the page title when none is given", () => {
    const html = generateStrudelPlayerHtml({ code: CODE });
    expect(html).toContain("<title>Strudel Live Pattern — MCP Music Studio</title>");
    expect(html).toContain("<h1>Strudel Live Pattern</h1>");
  });

  it("renders a supplied title in both the <title> and the <h1>", () => {
    const html = generateStrudelPlayerHtml({ code: CODE, title: "Kick Pulse" });
    expect(html).toContain("<title>Kick Pulse — MCP Music Studio</title>");
    expect(html).toContain("<h1>Kick Pulse</h1>");
    expect(html).not.toContain("<h1>Strudel Live Pattern</h1>");
  });

  it("HTML-escapes the title so it can't break out of the markup", () => {
    const html = generateStrudelPlayerHtml({
      code: CODE,
      title: '</h1><script>alert(1)</script> & "x"',
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;/h1&gt;&lt;script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;x&quot;");
  });

  it("falls back to the default when the title is blank", () => {
    const html = generateStrudelPlayerHtml({ code: CODE, title: "   " });
    expect(html).toContain("<h1>Strudel Live Pattern</h1>");
  });
});
