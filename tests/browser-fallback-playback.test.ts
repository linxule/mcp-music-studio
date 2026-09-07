/**
 * @file The two claims the fallback page makes about itself, pinned.
 *
 * Both were false before 2026-09:
 *  * "Render & Play" awaited `setTune(..., false, ...)` and never called
 *    `play()` — it rendered and primed, and nothing sounded.
 *  * the style selector's "None (melody only)" still let abcjs synthesise
 *    bass and chords from the ABC's chord symbols, because `chordsOff` was
 *    never set (and deliberately still isn't — see src/browser-fallback.ts).
 *
 * The page is a generated HTML string, so these assert on the script it emits.
 */
import { describe, expect, it } from "vitest";
import { generatePlayerHtml } from "../src/browser-fallback";

const ABC = `X:1
T:Fallback probe
M:4/4
L:1/8
K:C
"C"CDEF GABc |
`;

const html = generatePlayerHtml({ abcNotation: ABC });

describe("Render & Play actually plays", () => {
  it("calls play() after setTune, not just setTune", () => {
    expect(html).toContain("await synthControl.setTune(visualObj[0], false, opts);");
    expect(html).toContain("await synthControl.play();");
  });

  it("routes the button through the playing branch", () => {
    // The button calls renderFromEditor(), which must ask for playback.
    expect(html).toContain('onclick="renderFromEditor()"');
    expect(html).toMatch(/function renderFromEditor\(\)[\s\S]*?render\(true\)/);
  });

  it("gates playback behind the argument, so nothing autoplays on load", () => {
    expect(html).toContain("if (startPlaying) {");
    // Initial render and both selector changes must NOT start audio.
    expect(html).toContain("render(false);");
    expect(html).toMatch(
      /getElementById\('style-select'\)\.addEventListener\('change', function \(\) \{ render\(false\); \}\)/,
    );
    expect(html).toMatch(
      /getElementById\('instrument-select'\)\.addEventListener\('change', function \(\) \{ render\(false\); \}\)/,
    );
  });

  it("swallows a blocked play rather than surfacing it as a failure", () => {
    // Autoplay policy is not an error worth shouting about — the transport's
    // own play button still works.
    expect(html).toMatch(/catch \(e\) \{[\s\S]*?console\.debug\('Playback did not start:'/);
  });
});

describe("the style selector's 'none' option is honest", () => {
  it("no longer promises melody only", () => {
    expect(html).toContain("<option value=\"\">No preset accompaniment</option>");
    expect(html).not.toContain("None (melody only)");
  });

  it("still leaves chord-symbol accompaniment on, as documented", () => {
    // The decision, made explicit: chord symbols belong to the composer, the
    // preset belongs to the widget, and this selector only picks the latter.
    expect(html).not.toContain("chordsOff");
  });
});
