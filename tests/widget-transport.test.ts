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
    const fn = body(ABC, "function applySettings(");
    expect(fn).toContain("wakeAudio();");
    // The #25 re-engrave runs AFTER the wait, inside the same step.
    expect(fn).toMatch(/transportQueue\.run\(\(\) => \{\s*prepare\?\.\(\);\s*return applySettingsNow\(\);/);
    expect(body(ABC, "async function renderAbc(")).toMatch(
      /trackTransport\(synthControl, [^\n]*\);\s*queueWarp\(synthControl, transportQueue, [\s\S]{0,400}?\}\);\s*synthControl\.load\(/,
    );
  });

  it("queues an edit's re-prime and a tempo change the same way", () => {
    // Both used to start a load straight away: setTune(…, true) in the edit,
    // go() inside abcjs's setWarp().
    const apply = body(ABC, "async function applyEditorAbc(");
    // The score is drawn at once; only the audio queues (Kimi review: queueing
    // the engrave left the old score up for the whole load).
    expect(apply.indexOf("visualObj = engraveEdit(abc, effective, messages);")).toBeGreaterThan(0);
    expect(apply.indexOf("visualObj = engraveEdit(")).toBeLessThan(apply.indexOf("await transportQueue.run("));
    // Re-primed whenever its score is still on screen (a cancel, or a ▶ since,
    // must not leave the old tune under it); skipped once a newer one replaced it.
    expect(apply).toMatch(
      /await transportQueue\.run\(\(\) =>\s*!disposed && state\.synthControl === synthControl && state\.visualObj === visualObj\s*\? primeEdit\(edit\)/,
    );
    const prime = body(ABC, "async function primeEdit(");
    // Loop is put back before any early return (Codex final review).
    expect(prime.indexOf("restoreLoop(synthControl, transport);")).toBeLessThan(
      prime.indexOf("if (state.visualObj !== visualObj) {"),
    );
    // Two quick edits don't stop the music: the replaced one hands "it was playing" on.
    expect(prime).toContain("supersededEditWasPlaying = wasPlaying;");
    expect(prime).toContain("const wasPlaying = transport.wasPlaying || supersededEditWasPlaying;");
    // The transport is read after the wait, and the load starts inside the step.
    expect(prime.indexOf("readTransport(synthControl)")).toBeGreaterThanOrEqual(0);
    expect(prime).toMatch(/await synthControl\s*\.setTune\(/);
  });

  it("ignores timer events from a score an edit has already replaced", () => {
    expect(ABC).toMatch(/onEvent\(ev: NoteTimingEvent\) \{[\s\S]{0,300}if \(first && !first\.isConnected\) return;/);
  });

  it("a gesture after teardown releases nothing", () => {
    expect(body(ABC, "function wakeAudio()")).toContain("if (disposed) return;");
  });

  it("a cancel's pause is recorded, so nothing later reads the widget as playing", () => {
    expect(body(ABC, "function stopPlayback()")).toContain(
      "pauseTransport(state.synthControl)",
    );
  });

  it("keeps Loop through an edit too", () => {
    expect(body(ABC, "async function primeEdit(")).toContain(
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

  it("after a Sound change, says whether the tune plays on (not always 'Click ▶ to play')", () => {
    const handler = ABC.slice(ABC.indexOf('soundFontSelect.addEventListener("change"'));
    const fn = handler.slice(0, handler.indexOf("\n});\n"));
    expect(fn).not.toContain('.then(() => setStatus("Click ▶ to play"))');
    expect(fn).toMatch(
      /if \(!control \|\| statusEl\.textContent !== LOADING_SOUNDS\) return;\s*const playing = readTransport\(control\)\.wasPlaying;\s*setStatus\(withTransposeNote\(playing \? "Playing\.\.\." : "Click ▶ to play"\)\);/,
    );
  });

  it("empties the sample cache after the wait, not before it", () => {
    // A load finishing during the wait refilled it from the old bank.
    const handler = ABC.slice(ABC.indexOf('soundFontSelect.addEventListener("change"'));
    const fn = handler.slice(0, handler.indexOf("\n});\n"));
    expect(fn).toContain("applySettings(resetSoundsCache)");
    expect(fn).not.toMatch(/resetSoundsCache\(\)/);
    // The liveness check still runs first, synchronously.
    expect(fn.indexOf("soundsCacheLooksLive(hasPrimedAudio)")).toBeLessThan(
      fn.indexOf("applySettings(resetSoundsCache)"),
    );
  });

  it("a failed load says so, forgets the failed samples, and leaves ▶ to retry", () => {
    // The recovery itself (flags reset, one report) is trackTransport's, in
    // synth-transport.test.ts; forgetFailedSounds is in soundfont-cache.test.ts.
    expect(body(ABC, "async function renderAbc(")).toContain(
      "trackTransport(synthControl, (event) => onTransportEvent(synthControl, event));",
    );
    const handler = body(ABC, "function onTransportEvent(");
    expect(handler).toMatch(
      /if \(event\.type === "load-failed"\) void forgetFailedSounds\(\);\s*if \(disposed \|\| state\.synthControl !== control\) return;/,
    );
    expect(handler).toContain('classList.remove("abcjs-loading")');
    expect(handler).toContain("setStatus(withTransposeNote(LOAD_FAILED_STATUS), true);");
    // …and takes it down when a ▶ retries it successfully.
    expect(handler).toMatch(/case "started":[\s\S]{0,500}?return showTransportStatus\("Playing\.\.\."\);/);
    expect(body(ABC, "function showTransportStatus(")).toContain(
      "if (error && !statusEl.textContent?.startsWith(LOAD_FAILED_STATUS)) return;",
    );
    // Nobody paints over it: not the autoplay's catch…
    expect(body(ABC, "async function renderAbc(")).toMatch(
      /if \(!statusEl\.classList\.contains\("error"\)\) \{\s*setStatus\(withTransposeNote\("Click ▶ to play"\)\);/,
    );
    // …nor an edit, whose score is on screen whether or not the sounds load.
    const edit = body(ABC, "async function primeEdit(");
    expect(edit).toMatch(/const primed = await synthControl\s*\.setTune\(visualObj\[0\], true, currentSynthOptions\(\) as SynthOptions\)\s*\.then\(\s*\(\) => true,\s*\(\) => false,\s*\);/);
    expect(edit).toContain("if (primed && (wasPlaying || forcePlay)) {");
  });

  it("says Paused after a ▶ pause and Finished at the end, not 'Playing...'", () => {
    // Which transport changes are reported (a ▶ pause yes, a loop restart
    // no) is reportPlayback's, in synth-transport.test.ts.
    const handler = body(ABC, "function onTransportEvent(");
    expect(handler).toContain('case "paused":\n      return showTransportStatus("Paused");');
    expect(handler).toContain(
      'case "finished":\n      return showTransportStatus("Finished — ▶ to play again");',
    );
    // Neither paints over an error, and both keep the transposition note.
    const show = body(ABC, "function showTransportStatus(");
    expect(show).toContain('const error = statusEl.classList.contains("error");');
    expect(show).toContain("setStatus(withTransposeNote(text));");
  });

  it("says so when autoplay is blocked, instead of leaving 'Rendering...' up", () => {
    // A blocked play() never rejects, it waits: the check is on the context.
    const render = body(ABC, "async function renderAbc(");
    expect(render).toMatch(
      /resumeAudioContext\(audioContext\(\), AUDIO_SETTLE_MS\)\.then\(\(running\) => \{\s*if \(!running && autoplayLoading\(synthControl\)\) \{\s*setStatus\(withTransposeNote\("Click ▶ to play"\)\);/,
    );
  });

  it("any gesture in the widget resumes audio, so a parked autoplay can start", () => {
    expect(ABC).toMatch(
      /for \(const type of \["pointerdown", "keydown", "pointerup", "touchend"\]\) \{\s*document\.addEventListener\(type, wakeAudio, \{ capture: true, passive: true \}\);/,
    );
    expect(body(ABC, "function wakeAudio()")).toContain("resumeAudioContext(audioContext(),");
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
