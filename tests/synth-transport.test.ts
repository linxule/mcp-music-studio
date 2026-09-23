// =============================================================================
// The sheet-music widget's transport fixes (src/synth-transport.ts), run
// against abcjs's REAL SynthController.
//
// Only the audio is stubbed: `go()` (AudioContext resume + midiBuffer
// init/prime, which need Web Audio and the network) is replaced by a stand-in
// that sets the same flags and objects, and the transport UI is a DOM-free
// copy of create-synth-control.js's button state. Everything else — setTune,
// setWarp, destroy, play/runWhenReady/_play, pause, toggleLoop — is abcjs's
// own code, so a test here that pins upstream behaviour fails the day abcjs
// changes it.
// =============================================================================

import ABCJS from "abcjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keepLoopLitThroughWarp } from "../src/synth-transport";

const TUNE = ABCJS.parseOnly(`X:1
T:Transport
M:4/4
L:1/8
Q:1/4=120
K:G
G2 B2 d2 B2 | c2 e2 d4 |]`)[0]!;

// abcjs finds its AudioContext on `window.abcjsAudioContext`
// (active-audio-context.js); _play() resumes it before starting.
const hadWindow = "window" in globalThis;
beforeAll(() => {
  const g = globalThis as { window?: Record<string, unknown> };
  g.window ??= {};
  g.window.abcjsAudioContext = { state: "running", resume: () => Promise.resolve() };
});
afterAll(() => {
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
});

/** create-synth-control.js without the DOM: which buttons are pushed. */
function fakeUi() {
  return {
    loop: false,
    play: false,
    warpField: 100,
    tempoText: "",
    disable() {},
    setProgress() {},
    setTempo(tempo: number) {
      this.tempoText = String(Math.round(tempo));
    },
    setWarp(tempo: number, warp: number) {
      this.warpField = Math.round(warp);
      this.setTempo(tempo);
    },
    resetAll() {
      this.loop = false;
      this.play = false;
    },
    pushPlay(push: boolean) {
      this.play = push;
    },
    pushLoop(push: boolean) {
      this.loop = push;
    },
  };
}

const noop = () => {};

interface Harness {
  ctrl: Record<string, any> & ABCJS.SynthObjectController;
  ui: ReturnType<typeof fakeUi>;
  /** go() calls in flight right now, and the most ever at once. */
  loads: { now: number; max: number; calls: number };
}

/**
 * A real SynthController with its audio stubbed. `load()` decides how long
 * each go() takes (resolve = primed; reject = a failed soundfont fetch).
 */
function harness(load: (call: number) => Promise<void> = () => Promise.resolve()): Harness {
  const ctrl = new ABCJS.synth.SynthController() as Harness["ctrl"];
  const ui = fakeUi();
  const loads = { now: 0, max: 0, calls: 0 };
  ctrl.control = ui; // what load() would have built
  // Stand-in for synth-controller.js go(): same flags, same objects, no audio.
  ctrl.go = () => {
    ctrl.isLoading = true;
    loads.now += 1;
    loads.calls += 1;
    loads.max = Math.max(loads.max, loads.now);
    ctrl.currentTempo = 120 * (ctrl.warp / 100);
    ui.setTempo(ctrl.currentTempo);
    ctrl.midiBuffer ??= { duration: 4, start: noop, pause: noop, stop: noop, seek: noop, finished: noop };
    return load(loads.calls).then(
      () => {
        loads.now -= 1;
        ctrl.timer = { start: noop, pause: noop, stop: noop, reset: noop, setProgress: noop };
        ctrl.isLoaded = true;
        ctrl.isLoading = false; // abcjs clears it only on success
        return { status: "created" };
      },
      (error: unknown) => {
        loads.now -= 1;
        throw error;
      },
    );
  };
  return { ctrl, ui, loads };
}

/** A controller that is playing with Loop on, as a user would leave it. */
async function playingWithLoop(h = harness()): Promise<Harness> {
  await h.ctrl.setTune(TUNE, false);
  await h.ctrl.play();
  h.ctrl.toggleLoop();
  expect(h.ctrl.isStarted).toBe(true);
  expect(h.ui.loop).toBe(true);
  return h;
}

// -----------------------------------------------------------------------------
// #31 — a tempo change turned the Loop button off while the tune kept looping
// -----------------------------------------------------------------------------

describe("Loop survives a tempo change (#31)", () => {
  it("upstream: abcjs's setWarp() leaves Loop on but its button dark", async () => {
    // If this starts failing, abcjs re-lights Loop itself and
    // keepLoopLitThroughWarp() can go.
    const { ctrl, ui } = await playingWithLoop();
    await ctrl.setWarp(150);
    expect(ctrl.isLooping).toBe(true);
    expect(ctrl.isStarted).toBe(true);
    expect(ui.play).toBe(true);
    expect(ui.loop).toBe(false);
  });

  it("keeps the button lit, playing or paused", async () => {
    const playing = await playingWithLoop();
    keepLoopLitThroughWarp(playing.ctrl);
    await playing.ctrl.setWarp(150);
    expect(playing.ctrl.isLooping).toBe(true);
    expect(playing.ui.loop).toBe(true);

    const paused = await playingWithLoop();
    keepLoopLitThroughWarp(paused.ctrl);
    await paused.ctrl.play(); // toggles to pause
    await paused.ctrl.setWarp(80);
    expect(paused.ctrl.isStarted).toBe(false);
    expect(paused.ui.loop).toBe(true);
  });

  it("re-lights it at once, not only after the re-prime", async () => {
    let release = noop;
    // The first load (the play) primes at once; the warp's re-prime waits.
    const h = await playingWithLoop(
      harness((call) =>
        call === 1 ? Promise.resolve() : new Promise<void>((resolve) => (release = resolve)),
      ),
    );
    keepLoopLitThroughWarp(h.ctrl);
    const done = h.ctrl.setWarp(150);
    expect(h.ui.loop).toBe(true);
    release();
    await done;
    expect(h.ui.loop).toBe(true);
  });

  it("leaves Loop dark when it was off, and a toggle after the change works", async () => {
    const h = harness();
    await h.ctrl.setTune(TUNE, false);
    await h.ctrl.play();
    keepLoopLitThroughWarp(h.ctrl);
    await h.ctrl.setWarp(150);
    expect(h.ui.loop).toBe(false);
    h.ctrl.toggleLoop();
    expect(h.ctrl.isLooping).toBe(true);
    expect(h.ui.loop).toBe(true);
  });
});
