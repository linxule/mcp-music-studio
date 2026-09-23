// =============================================================================
// Widget transport guards (source-text, like widget-display-mode.test.ts)
//
// Playback-state bugs in the two widgets' integration with abcjs and Strudel:
//
//  * abcjs only offsets its note timer by a count-in when the CURSOR CONTROL
//    carries `extraMeasuresAtBeginning`; `drumIntro` never reaches the timer.
//    A count-in tune lit its notes two bars early and ended the transport two
//    bars before the audio.
//  * `setTune()` pauses, rewinds and clears Loop, so changing the instrument or
//    sound bank mid-tune silently stopped the music.
//  * Strudel: a cancel didn't supersede a render still loading, which went on
//    to autoplay the cancelled pattern; a stop nobody announced (hush()) left
//    the status reading "Playing...".
// =============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), "utf8");

const ABC = read("mcp-app.ts");
const STRUDEL = read("strudel-app.ts");

const body = (source: string, signature: string) => {
  const start = source.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf("\n}\n", start));
};

describe("sheet music transport", () => {
  it("offsets the note timer by the drum count-in on every setTune", () => {
    const fn = body(ABC, "function currentSynthOptions()");
    expect(fn).toContain("cursorControl.extraMeasuresAtBeginning =");
    expect(fn).toContain("options.drumIntro");
  });

  it("keeps playing (and looping) through an instrument or sound change", () => {
    const fn = body(ABC, "async function applySettingsNow()");
    expect(fn).toContain("const transport = readTransport(control);");
    expect(fn).toContain("restoreLoop(control, transport);");
    expect(fn).toMatch(/if \(transport\.wasPlaying\) \{\s*await \(control\.play\(\)/);
  });

  it("keeps Loop through an edit too", () => {
    expect(body(ABC, "async function applyEditorAbc(")).toContain(
      "restoreLoop(synthControl, transport);",
    );
  });

  it("keeps the Loop button lit through a tempo change on every controller it builds (#31)", () => {
    // One construction site, and it wraps setWarp before anything can call it.
    expect(ABC.match(/new ABCJS\.synth\.SynthController\(\)/g)).toHaveLength(1);
    expect(body(ABC, "async function renderAbc(")).toMatch(
      /new ABCJS\.synth\.SynthController\(\);[\s\S]*?keepLoopLitThroughWarp\(synthControl\);[\s\S]*?synthControl\.load\(/,
    );
  });
});

describe("strudel transport", () => {
  it("a cancel supersedes any render still loading, and stops playback", () => {
    const handler = STRUDEL.slice(STRUDEL.indexOf("app.ontoolcancelled = "));
    const fn = handler.slice(0, handler.indexOf("\n};\n"));
    expect(fn).toContain("renderGeneration++;");
    expect(fn).toContain('pendingPartialCode = "";');
    expect(fn).toContain("getEditor()?.stop?.();");
  });

  it("says Ready when playback stops without an evaluation, unless an error is up", () => {
    expect(STRUDEL).toMatch(
      /if \(!started && !isRecording && !statusEl\.classList\.contains\("error"\)\) \{\s*setStatus\("Ready", "normal"\);/,
    );
  });
});
