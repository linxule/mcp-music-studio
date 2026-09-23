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
//  * That change then started a second load on top of the autoplay's (#33),
//    and restarted music the user had cancelled while it primed.
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
    // The behaviour itself (Loop kept, play only if playing, never after a
    // cancel) is reprime(), exercised in synth-transport.test.ts.
    const fn = body(ABC, "async function applySettingsNow()");
    expect(fn).toContain("await reprime(control, {");
    expect(fn).toContain("await control.setTune(tune, true, currentSynthOptions() as SynthOptions);");
  });

  it("re-checks the generation, not just the controller, after a settings prime", () => {
    // ontoolcancelled bumps the generation but KEEPS the controller, so an
    // identity check alone let a prime in flight restart cancelled music.
    const fn = body(ABC, "async function applySettingsNow()");
    expect(fn).toMatch(/const generation = renderGeneration;/);
    expect(fn).toContain(
      "stillWanted: () => state.synthControl === control && !isStale(generation),",
    );
  });

  it("queues a settings change behind any load already in flight (#33)", () => {
    const fn = body(ABC, "function applySettings()");
    expect(fn).toContain("wakeAudio();");
    expect(fn).toContain("applySettingsChain.then(settleTransport).then(applySettingsNow)");
    expect(body(ABC, "async function renderAbc(")).toMatch(
      /trackTransport\(synthControl\);\s*synthControl\.load\(/,
    );
  });

  it("a cancel's pause is recorded, so nothing later reads the widget as playing", () => {
    expect(body(ABC, "function stopPlayback()")).toContain(
      "pauseTransport(state.synthControl)",
    );
  });

  it("keeps Loop through an edit too", () => {
    expect(body(ABC, "async function applyEditorAbc(")).toContain(
      "restoreLoop(synthControl, transport);",
    );
  });

  it("a Style change carries tempo and Loop, and plays only if it was playing (#26)", () => {
    const handler = ABC.slice(ABC.indexOf('styleSelect.addEventListener("change"'));
    const fn = handler.slice(0, handler.indexOf("\n});\n"));
    expect(fn).toContain("const carry = control ? readTransport(control) : null;");
    expect(fn).toContain("const autoplay = Boolean(carry?.wasPlaying) || autoplayLoading(control);");
    expect(fn).toContain("renderAbc(state.currentAbc, undefined, { autoplay, carry });");

    const render = body(ABC, "async function renderAbc(");
    // Tempo onto the new controller once load() has built its % field…
    expect(render).toMatch(/synthControl\.load\([\s\S]*?carryWarp\(synthControl, transport\.carry\.warp/);
    // …Loop back after setTune() cleared it, and only for a current render…
    expect(render).toMatch(
      /if \(isStale\(generation\)\) \{[\s\S]*?if \(transport\.carry\) restoreLoop\(synthControl, transport\.carry\);/,
    );
    // …and no play() unless asked.
    expect(render).toMatch(/if \(!transport\.autoplay\) \{[\s\S]*?return;\s*\}[\s\S]*?synthControl\.play\(\)/);
  });

  it("a stale autoplay (cancelled, or taken over) does not count as playing", () => {
    expect(body(ABC, "function autoplayLoading(")).toContain(
      "!isStale(pendingAutoplay.generation)",
    );
  });

  it("every full render says whether it autoplays: nothing is inferred", () => {
    const code = ABC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    // Every call, but not the declaration or ABCJS.renderAbc.
    const calls = code.match(/[^.\w]renderAbc\((?!\s*abcNotation)/g) ?? [];
    const explicit = code.match(/[^.\w]renderAbc\([^)]*\{ autoplay[^}]*\}\)/g) ?? [];
    expect(explicit.length).toBe(3); // tool input, Style change, editor fallback
    expect(calls.length).toBe(explicit.length);
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
