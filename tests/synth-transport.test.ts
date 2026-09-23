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
import {
  TransportQueue,
  carryWarp,
  keepLoopLitThroughWarp,
  pauseTransport,
  queueWarp,
  readTransport,
  reprime,
  restoreLoop,
  trackTransport,
  warpedTempo,
  whenTransportIdle,
} from "../src/synth-transport";

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
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A load that waits until released (or fails). */
function gate() {
  let release = noop;
  let fail: (error: unknown) => void = noop;
  const promise = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { promise, release: () => release(), fail: (error: unknown) => fail(error) };
}

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

// -----------------------------------------------------------------------------
// A pause from code (a cancelled tool call) must read as paused
// -----------------------------------------------------------------------------

describe("pauseTransport", () => {
  it("upstream: pause() leaves isStarted true, so the next ▶ plays nothing", async () => {
    const h = harness();
    await h.ctrl.setTune(TUNE, false);
    await h.ctrl.play();
    h.ctrl.pause();
    expect(h.ctrl.isStarted).toBe(true);
    expect(readTransport(h.ctrl).wasPlaying).toBe(true);
    await h.ctrl.play(); // _play() toggles isStarted: this "pauses" a stopped tune
    expect(h.ctrl.isStarted).toBe(false);
    expect(h.ui.play).toBe(false);
  });

  it("records the pause, and the next ▶ plays", async () => {
    const h = harness();
    await h.ctrl.setTune(TUNE, false);
    await h.ctrl.play();
    pauseTransport(h.ctrl);
    expect(readTransport(h.ctrl).wasPlaying).toBe(false);
    expect(h.ui.play).toBe(false);
    await h.ctrl.play();
    expect(h.ctrl.isStarted).toBe(true);
    expect(h.ui.play).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// #33 — a settings change during the autoplay load started a second load
// -----------------------------------------------------------------------------

describe("one load at a time (#33)", () => {
  /** A controller whose first load (the autoplay) waits for `first`. */
  async function autoplaying(first: ReturnType<typeof gate>) {
    const h = harness((call) => (call === 1 ? first.promise : Promise.resolve()));
    trackTransport(h.ctrl);
    await h.ctrl.setTune(TUNE, false);
    const autoplay = h.ctrl.play() as unknown as Promise<unknown>;
    expect(h.ctrl.isLoading).toBe(true);
    return { ...h, autoplay };
  }

  it("upstream: setTune(…, true) starts a load on top of one in flight", async () => {
    const first = gate();
    const h = harness((call) => (call === 1 ? first.promise : Promise.resolve()));
    await h.ctrl.setTune(TUNE, false);
    const autoplay = h.ctrl.play();
    await h.ctrl.setTune(TUNE, true); // what an instrument change used to do
    expect(h.loads.max).toBe(2);
    first.release();
    await autoplay;
  });

  it("waits for the autoplay's prime AND the start that follows it", async () => {
    // _play() resumes the AudioContext before it flips isStarted, so there is
    // a gap after the load in which the tune is "loaded" but not yet playing.
    const audio = (globalThis as { window: { abcjsAudioContext: { resume: () => Promise<void> } } })
      .window.abcjsAudioContext;
    const resume = audio.resume;
    audio.resume = () => sleep(40);
    try {
      const first = gate();
      const h = await autoplaying(first);
      let idle = false;
      const waiting = whenTransportIdle(h.ctrl, () => true, 5).then(() => {
        idle = true;
      });
      await sleep(30);
      expect(idle).toBe(false);
      first.release();
      await waiting;
      // The wait spans that gap too, so the change reads the transport as playing.
      expect(h.ctrl.isLoading).toBe(false);
      expect(h.ctrl.isStarted).toBe(true);
    } finally {
      audio.resume = resume;
    }
  });

  it("so a change queued behind it re-primes after it, once, and keeps playing", async () => {
    const first = gate();
    const h = await autoplaying(first);
    const change = whenTransportIdle(h.ctrl, () => true, 5).then(() =>
      reprime(h.ctrl, { prime: () => h.ctrl.setTune(TUNE, true), stillWanted: () => true }),
    );
    first.release();
    await change;
    expect(h.loads.max).toBe(1);
    expect(h.loads.calls).toBe(2);
    expect(h.ctrl.isStarted).toBe(true);
    expect(h.ui.play).toBe(true);
  });

  it("covers a first ▶ and a tempo change the same way", async () => {
    const first = gate();
    const h = harness((call) => (call === 2 ? first.promise : Promise.resolve()));
    trackTransport(h.ctrl);
    await h.ctrl.setTune(TUNE, false);
    await h.ctrl.play();
    const warp = h.ctrl.setWarp(150); // destroy() + a fresh load
    let idle = false;
    const waiting = whenTransportIdle(h.ctrl, () => true, 5).then(() => {
      idle = true;
    });
    await sleep(30);
    expect(idle).toBe(false);
    first.release();
    await Promise.all([warp, waiting]);
  });

  it("stops waiting on a controller that has been superseded while its load hangs", async () => {
    // A load parked on AudioContext.resume() under a blocked autoplay.
    const h = await autoplaying(gate());
    let wanted = true;
    setTimeout(() => (wanted = false), 20);
    await whenTransportIdle(h.ctrl, () => wanted, 5); // resolves, never hangs
    expect(h.ctrl.isLoading).toBe(true);
  });

  it("does not wait on a failed load, nor on a ▶ spinning on abcjs's stuck isLoading", async () => {
    const h = harness((call) =>
      call === 1 ? Promise.reject(new Error("soundfont 404")) : Promise.resolve(),
    );
    trackTransport(h.ctrl);
    await h.ctrl.setTune(TUNE, false);
    await expect(h.ctrl.play() as unknown as Promise<unknown>).rejects.toThrow("soundfont 404");
    expect(h.ctrl.isLoading).toBe(true); // upstream: go() clears it only on success
    const spinning = h.ctrl.play() as unknown as Promise<unknown>; // runWhenReady polls forever
    await whenTransportIdle(h.ctrl, () => true, 5);
    // A fresh prime (a different sound bank, say) is what gets that ▶ moving.
    await reprime(h.ctrl, { prime: () => h.ctrl.setTune(TUNE, true), stillWanted: () => true });
    await spinning;
    expect(h.ctrl.isStarted).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Edits and tempo changes wait their turn too (TransportQueue, queueWarp)
// -----------------------------------------------------------------------------

describe("TransportQueue: one re-prime at a time, on the live controller", () => {
  /** A tracked controller whose autoplay's load waits on `first`. */
  async function loading(first: ReturnType<typeof gate>) {
    const h = harness((call) => (call === 1 ? first.promise : Promise.resolve()));
    trackTransport(h.ctrl);
    await h.ctrl.setTune(TUNE, false);
    const autoplay = h.ctrl.play() as unknown as Promise<unknown>;
    return { ...h, autoplay };
  }

  it("upstream: a tempo change starts a second load on top of one in flight", async () => {
    const first = gate();
    const h = await loading(first);
    const warp = h.ctrl.setWarp(150);
    expect(h.loads.max).toBe(2);
    first.release();
    await Promise.all([h.autoplay, warp]);
  });

  it("a queued re-prime (an edit's setTune) waits for the autoplay, then keeps it playing", async () => {
    const first = gate();
    const h = await loading(first);
    const queue = new TransportQueue(() => h.ctrl);
    const edit = queue.run(() =>
      reprime(h.ctrl, { prime: () => h.ctrl.setTune(TUNE, true), stillWanted: () => true }),
    );
    await sleep(20);
    expect(h.loads.calls).toBe(1);
    first.release();
    await edit;
    expect(h.loads.max).toBe(1);
    expect(h.loads.calls).toBe(2);
    expect(h.ctrl.isStarted).toBe(true);
  });

  it("a tempo change through queueWarp waits too", async () => {
    const first = gate();
    const h = await loading(first);
    queueWarp(h.ctrl, new TransportQueue(() => h.ctrl));
    const warp = h.ctrl.setWarp(150);
    await sleep(20);
    expect(h.loads.calls).toBe(1);
    first.release();
    await Promise.all([h.autoplay, warp]);
    expect(h.loads.max).toBe(1);
    expect(h.ctrl.warp).toBe(150);
    expect(h.ctrl.isStarted).toBe(true);
    expect(h.ui.warpField).toBe(150);
  });

  it("a burst from the % field's spinner re-primes once, at the last value", async () => {
    const first = gate();
    const h = await loading(first);
    queueWarp(h.ctrl, new TransportQueue(() => h.ctrl));
    const burst = [110, 120, 130, 140].map((warp) => h.ctrl.setWarp(warp));
    first.release();
    await Promise.all([h.autoplay, ...burst]);
    expect(h.loads.max).toBe(1);
    expect(h.loads.calls).toBe(2);
    expect(h.ctrl.warp).toBe(140);
  });

  it("drops a queued tempo change for a controller that has been replaced", async () => {
    const first = gate();
    const h = await loading(first);
    let current: object = h.ctrl;
    queueWarp(h.ctrl, new TransportQueue(() => current));
    const warp = h.ctrl.setWarp(150);
    current = harness().ctrl; // a new tool call built another
    first.release();
    await Promise.all([h.autoplay, warp]);
    expect(h.loads.calls).toBe(1);
    expect(h.ctrl.warp).toBe(100);
  });

  it("settles on the replacement too: its own autoplay may still be loading", async () => {
    const firstA = gate();
    const a = await loading(firstA);
    const firstB = gate();
    const b = await loading(firstB); // B's autoplay is loading
    let current: object = a.ctrl;
    const queue = new TransportQueue(() => current);
    const change = queue.run(() => {
      const control = current as Harness["ctrl"];
      return control.setTune(TUNE, true);
    });
    await sleep(20);
    current = b.ctrl; // replaced while the change waits on A
    firstA.release();
    await sleep(150);
    expect(b.loads.calls).toBe(1); // still waiting, on B now
    firstB.release();
    await Promise.all([change, a.autoplay, b.autoplay]);
    expect(b.loads.max).toBe(1);
    expect(b.loads.calls).toBe(2);
  });

  it("keeps going after a step throws", async () => {
    const queue = new TransportQueue(() => null);
    await expect(queue.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(queue.run(() => 7)).resolves.toBe(7);
  });
});

// -----------------------------------------------------------------------------
// A ▶ pressed while a play is still starting (a parked autoplay)
// -----------------------------------------------------------------------------

describe("a ▶ while a play is still starting", () => {
  /** An autoplay whose load waits on `first`, and a ▶ pressed meanwhile. */
  async function autoplayThenClick(track: boolean) {
    const first = gate();
    const h = harness((call) => (call === 1 ? first.promise : Promise.resolve()));
    if (track) trackTransport(h.ctrl);
    await h.ctrl.setTune(TUNE, false);
    const autoplay = h.ctrl.play() as unknown as Promise<unknown>;
    const click = h.ctrl.play() as unknown as Promise<unknown>;
    first.release();
    await Promise.all([autoplay, click]);
    return h;
  }

  it("upstream: the ▶ switches the tune off as soon as the autoplay starts it", async () => {
    // runWhenReady polls isLoading every 500 ms, then _play() toggles.
    const h = await autoplayThenClick(false);
    expect(h.ctrl.isStarted).toBe(false);
    expect(h.ui.play).toBe(false);
  });

  it("joins the autoplay instead: one load, and it keeps playing", async () => {
    const h = await autoplayThenClick(true);
    expect(h.loads.calls).toBe(1);
    expect(h.ctrl.isStarted).toBe(true);
    expect(h.ui.play).toBe(true);
  });

  it("the next ▶ after it has started still pauses", async () => {
    const h = await autoplayThenClick(true);
    await h.ctrl.play();
    expect(h.ctrl.isStarted).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// reprime — the settings change itself
// -----------------------------------------------------------------------------

describe("reprime", () => {
  const prime = (h: Harness) => () => h.ctrl.setTune(TUNE, true);

  it("carries on playing, from the top, with Loop kept", async () => {
    const h = await playingWithLoop();
    await reprime(h.ctrl, { prime: prime(h), stillWanted: () => true });
    expect(h.loads.calls).toBe(2);
    expect(h.ctrl.isStarted).toBe(true);
    expect(h.ctrl.isLooping).toBe(true);
    expect(h.ui.loop).toBe(true);
  });

  it("stays paused when it was paused", async () => {
    const h = await playingWithLoop();
    await h.ctrl.play(); // pause
    await reprime(h.ctrl, { prime: prime(h), stillWanted: () => true });
    expect(h.loads.calls).toBe(2);
    expect(h.ctrl.isStarted).toBe(false);
  });

  /** A playing controller whose NEXT load waits for `next`. */
  async function playingThenSlow(next: ReturnType<typeof gate>) {
    return playingWithLoop(harness((call) => (call === 1 ? Promise.resolve() : next.promise)));
  }

  it("a cancel landing mid-prime: the new sound is primed, the music stays stopped", async () => {
    const next = gate();
    const h = await playingThenSlow(next);
    let generation = 1;
    const mine = generation;
    const change = reprime(h.ctrl, { prime: prime(h), stillWanted: () => generation === mine });
    // ontoolcancelled: newGeneration() + stopPlayback(); the controller stays.
    generation += 1;
    pauseTransport(h.ctrl);
    next.release();
    await change;
    expect(h.loads.calls).toBe(2);
    expect(h.ctrl.isStarted).toBe(false);
    expect(h.ui.play).toBe(false);
  });

  it("…which a same-controller check alone let through: the music came back", async () => {
    // The guard the widget had before: the controller is still the widget's,
    // so the change went on to restart the tune the user had just cancelled.
    const next = gate();
    const h = await playingThenSlow(next);
    const change = reprime(h.ctrl, { prime: prime(h), stillWanted: () => true });
    pauseTransport(h.ctrl);
    next.release();
    await change;
    expect(h.ctrl.isStarted).toBe(true);
  });

  it("a cancel landing while play() starts: the music is stopped again", async () => {
    const h = await playingWithLoop();
    let wanted = true;
    const play = h.ctrl.play;
    h.ctrl.play = () => {
      const started = play();
      wanted = false; // the cancel arrives while _play() is resuming audio
      return started;
    };
    let superseded = 0;
    await reprime(h.ctrl, {
      prime: prime(h),
      stillWanted: () => wanted,
      onSuperseded: () => {
        superseded += 1;
        pauseTransport(h.ctrl);
      },
    });
    expect(superseded).toBe(1);
    expect(h.ctrl.isStarted).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// #26 — a Style change reset the tempo and Loop (and played when paused)
// -----------------------------------------------------------------------------

describe("carrying the transport into a new controller (#26)", () => {
  it("computes the BPM abcjs shows, from go()'s own formula", () => {
    // Q:1/4=120 in 4/4.
    expect(warpedTempo(TUNE, 100)).toBe(120);
    expect(warpedTempo(TUNE, 150)).toBe(180);
    expect(warpedTempo(TUNE, 50)).toBe(60);
  });

  it("reads the tempo field, defaulting to 100%", () => {
    const h = harness();
    expect(readTransport(h.ctrl).warp).toBe(100);
    h.ctrl.warp = 150;
    expect(readTransport(h.ctrl).warp).toBe(150);
    h.ctrl.warp = Number.NaN;
    expect(readTransport(h.ctrl).warp).toBe(100);
  });

  /** What renderAbc does with a Style change's carry: the new controller's life. */
  async function restyle(old: Harness, autoplay: boolean): Promise<Harness> {
    const carry = readTransport(old.ctrl);
    const next = harness();
    carryWarp(next.ctrl, carry.warp, TUNE); // after load()
    await next.ctrl.setTune(TUNE, false);
    restoreLoop(next.ctrl, carry); // setTune() switched Loop off
    if (autoplay) await next.ctrl.play();
    return next;
  }

  it("keeps the tempo and Loop, and the field shows the tempo it plays at", async () => {
    const old = await playingWithLoop();
    keepLoopLitThroughWarp(old.ctrl);
    await old.ctrl.setWarp(150);
    const next = await restyle(old, readTransport(old.ctrl).wasPlaying);
    expect(next.ctrl.warp).toBe(150);
    expect(next.ui.warpField).toBe(150);
    expect(next.ui.tempoText).toBe("180");
    expect(next.ctrl.currentTempo).toBe(180); // what go() then plays at
    expect(next.ctrl.isLooping).toBe(true);
    expect(next.ui.loop).toBe(true);
    expect(next.ctrl.isStarted).toBe(true);
  });

  it("writes the readout at 100% too, so a paused re-render still shows its BPM", () => {
    const h = harness();
    carryWarp(h.ctrl, 100, TUNE);
    expect(h.ctrl.warp).toBe(100);
    expect(h.ui.warpField).toBe(100);
    expect(h.ui.tempoText).toBe("120");
  });

  it("ignores a nonsense tempo", () => {
    const h = harness();
    carryWarp(h.ctrl, 0, TUNE);
    expect(h.ctrl.warp).toBe(100);
    expect(h.ui.tempoText).toBe("");
  });

  it("a paused tune, or one stopped by a cancel, reads as not playing", async () => {
    const paused = await playingWithLoop();
    await paused.ctrl.play(); // the user's pause
    expect(readTransport(paused.ctrl).wasPlaying).toBe(false);

    const cancelled = await playingWithLoop();
    pauseTransport(cancelled.ctrl); // ontoolcancelled → stopPlayback()
    expect(readTransport(cancelled.ctrl).wasPlaying).toBe(false);
  });
});
