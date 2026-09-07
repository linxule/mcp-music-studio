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

  it("leaves the code alone when no bpm is supplied", () => {
    const html = generateStrudelPlayerHtml({ code: CODE });
    expect(html).not.toContain("setcps(");
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
});
