/**
 * @file The sheet-music widget's reach into abcjs's SynthController.
 *
 * Pure: no DOM, no abcjs import. `tests/synth-transport.test.ts` drives these
 * against the REAL `ABCJS.synth.SynthController` (with its audio stubbed out),
 * so each fix is checked against the abcjs code it works around, not against a
 * model of it. Every function leans on a detail of abcjs 6.7.x
 * `src/synth/synth-controller.js`, quoted where it is used.
 */

/** abcjs's transport UI (`create-synth-control.js`), as far as we touch it. */
interface TransportUi {
  pushLoop(push: boolean): void;
  /** Writes the % field and the BPM readout. */
  setWarp(tempo: number, warp: number): void;
}

/** The SynthController members the widget reads or wraps. */
interface SynthInternals {
  warp?: number;
  isStarted?: boolean;
  isLooping?: boolean;
  isLoading?: boolean;
  control?: TransportUi | null;
  go(): unknown;
  play(): unknown;
  pause(): void;
  toggleLoop(): void;
  setWarp(warp: unknown): unknown;
  randomAccess?(ev: unknown): unknown;
}

const internals = (control: object) => control as SynthInternals;

// =============================================================================
// Transport state
// =============================================================================

/** What `setTune()` throws away that the listener would want kept. */
export interface TransportState {
  wasPlaying: boolean;
  wasLooping: boolean;
  /** The tempo field, in percent (abcjs `warp`; 100 = as written). */
  warp: number;
}

export function readTransport(control: object): TransportState {
  const raw = internals(control);
  const warp = Number(raw.warp);
  return {
    wasPlaying: Boolean(raw.isStarted),
    wasLooping: Boolean(raw.isLooping),
    warp: warp > 0 ? warp : 100,
  };
}

/**
 * `setTune()` pauses, rewinds, and switches Loop off (`pause()`,
 * `resetAll()`, `isLooping = false`). Put Loop back; the caller decides
 * whether to play again.
 */
export function restoreLoop(control: object, { wasLooping }: TransportState): void {
  const raw = internals(control);
  if (wasLooping && !raw.isLooping) raw.toggleLoop();
}

/**
 * Pause, and record that we did.
 *
 * abcjs's `pause()` stops the timer and the buffer but leaves `isStarted`
 * true; only `_play()` flips it (`self.isStarted = !self.isStarted`). A widget
 * paused from code (a cancelled tool call) therefore still read as playing:
 * the next instrument, sound or Style change started the music the user had
 * just cancelled, and the next ▶ toggled it "off" and played nothing.
 */
export function pauseTransport(control: object): void {
  const raw = internals(control);
  raw.pause();
  raw.isStarted = false;
}

// =============================================================================
// Tempo carried into a new controller (#26)
// =============================================================================

/** The parts of a parsed abcjs tune that set its tempo. */
export interface TempoSource {
  getBeatsPerMeasure(): number;
  millisecondsPerMeasure(): number;
}

/** The BPM abcjs shows for `tune` at `warp` percent: `go()`'s own formula. */
export function warpedTempo(tune: TempoSource, warp: number): number {
  const millisecondsPerMeasure = (tune.millisecondsPerMeasure() * 100) / warp;
  return Math.round((tune.getBeatsPerMeasure() / millisecondsPerMeasure) * 60000);
}

/**
 * Start a fresh controller at the tempo the listener had set on the old one.
 *
 * `go()` reads `self.warp` for the playback speed but updates only the BPM
 * readout (`control.setTempo`). The % field is written only inside
 * `setWarp()`, so setting `warp` alone would play at 150% under a field that
 * still says 100. Writing it also fills the BPM readout of a re-render that
 * does not autoplay, which is otherwise blank until the first ▶. Call after
 * `load()`, which builds the field.
 */
export function carryWarp(control: object, warp: number, tune: TempoSource): void {
  if (!(warp > 0)) return;
  const raw = internals(control);
  raw.warp = warp;
  raw.control?.setWarp(warpedTempo(tune, warp), warp);
}

// =============================================================================
// Loop through a tempo change (#31)
// =============================================================================

/**
 * Keep the Loop button lit through a tempo change (#31).
 *
 * `setWarp()` re-primes by way of `destroy()`, which ends in
 * `control.resetAll()` and so un-pushes every transport button, but it never
 * touches `isLooping`. It re-lights Play (through `play()`); nothing re-lights
 * Loop. The tune went on looping under a dark button, and the next click on
 * Loop turned looping OFF. The % field reaches `setWarp` as `self.setWarp`
 * (`onWarp`), an instance lookup, so wrapping the instance method catches it.
 */
export function keepLoopLitThroughWarp(control: object): void {
  const raw = internals(control);
  const setWarp = raw.setWarp;
  const relight = () => raw.control?.pushLoop(Boolean(raw.isLooping));
  raw.setWarp = (warp: unknown) => {
    const done = Promise.resolve(setWarp(warp));
    // destroy() → resetAll() has already run, synchronously: fix the button
    // now rather than after the re-prime, and again once it lands.
    relight();
    return done.then(
      (value) => {
        relight();
        return value;
      },
      (error: unknown) => {
        relight();
        throw error;
      },
    );
  };
}

// =============================================================================
// One load at a time (#33)
// =============================================================================
//
// `setTune(tune, true, …)` calls `go()` straight away. Only `play()` waits for a
// load already in flight (`runWhenReady` polls `isLoading`). So an instrument
// or sound change made while the autoplay was still priming put a second
// `midiBuffer.init()` + `prime()` on the same buffer, and the first load's
// `_play()` then started whatever state was left.

interface Tracked {
  /** In-flight `go()` calls: AudioContext resume, then init + prime. */
  loads: Set<Promise<unknown>>;
  /** Transport calls that load and may then START playback. */
  calls: Set<Promise<unknown>>;
  /** Waiting {@link whenTransportIdle} calls, woken when one of those settles. */
  waiters: Set<() => void>;
}

const tracked = new WeakMap<object, Tracked>();

/**
 * `_play()` calls not yet settled, per controller. `_play()` resumes the
 * AudioContext BEFORE it flips `isStarted`, so a play can be past its load
 * (`isLoading` false) and still not started.
 */
const playsInFlight = new WeakMap<object, number>();

/** When the gesture in progress began (pointerdown / keydown). */
let gestureStartedAt = Number.NEGATIVE_INFINITY;

/** A click follows its own press within this; later, it is a new gesture. */
const PRESS_TO_CLICK_MS = 1000;

/**
 * Note the start of a user gesture, from a capture-phase pointerdown/keydown
 * listener. {@link joinPendingPlay} uses it to recognise the ▶ press that
 * released a parked autoplay.
 */
export function noteGestureStart(now = performance.now()): void {
  gestureStartedAt = now;
}

/** Transport calls whose promise outlives the load (`_play()`, a seek). */
const PLAYING_CALLS = ["play", "setWarp", "randomAccess"] as const;

function track(state: Tracked, set: Set<Promise<unknown>>, result: unknown): void {
  if (!result || typeof (result as Promise<unknown>).then !== "function") return;
  const promise = result as Promise<unknown>;
  set.add(promise);
  const settle = () => {
    set.delete(promise);
    for (const wake of [...state.waiters]) wake();
  };
  promise.then(settle, settle);
}

/** What the transport did, for the widget's status line. */
export type TransportEvent =
  | { type: "load-failed"; error: unknown }
  | { type: "started" }
  /** A ▶ pause. A pause from code (setTune, pauseTransport) is not reported. */
  | { type: "paused" }
  /** The tune ran to its end with Loop off. A loop restart is not an end. */
  | { type: "finished" };

/**
 * Record every load and every play on `control`, for {@link whenTransportIdle},
 * let a second ▶ join a play that is still starting, and recover from a failed
 * load, reporting it to `onEvent`.
 *
 * Call it BEFORE `load()`: `load()` hands the Play button and the progress bar
 * `self.play` and `self.randomAccess` by reference. `go()` and `setWarp()` are
 * looked up on the instance whenever abcjs calls them, so those wraps can land
 * at any point.
 */
export function trackTransport(
  control: object,
  onEvent: (event: TransportEvent) => void = () => {},
): void {
  const raw = internals(control) as unknown as Record<string, unknown>;
  const state: Tracked = { loads: new Set(), calls: new Set(), waiters: new Set() };
  tracked.set(control, state);
  const wrap = (name: string, into: Set<Promise<unknown>>) => {
    const original = raw[name];
    if (typeof original !== "function") return;
    raw[name] = (...args: unknown[]) => {
      const result = (original as (...a: unknown[]) => unknown)(...args);
      track(state, into, result);
      return result;
    };
  };
  recoverFromFailedLoads(raw, onEvent);
  reportPlayback(raw, onEvent);
  wrap("go", state.loads);
  for (const name of PLAYING_CALLS) wrap(name, state.calls);
  joinPendingPlay(raw);
}

/**
 * Leave a controller whose load failed ready to load again.
 *
 * `go()` clears `isLoading` only on success, so after a failed sample fetch
 * every ▶ spun in runWhenReady forever. A prime that failed half-way also
 * kept `isLoaded` from the load before it, over a buffer it never finished
 * (and, after a tempo change, no timer). Both are reset so the next ▶ loads
 * again, but only for the latest load: a superseded one failing late must not
 * unload the controller that replaced it.
 */
function recoverFromFailedLoads(
  raw: Record<string, unknown>,
  onEvent: (event: TransportEvent) => void,
): void {
  const go = raw.go as () => unknown;
  let latest = 0;
  raw.go = () => {
    const load = ++latest;
    const result = go();
    if (!result || typeof (result as Promise<unknown>).then !== "function") return result;
    return (result as Promise<unknown>).catch((error: unknown) => {
      if (load === latest) {
        raw.isLoading = false;
        raw.isLoaded = false;
        onEvent({ type: "load-failed", error });
      }
      throw error;
    });
  };
  // A ▶ that was polling in runWhenReady when the load failed calls _play()
  // without checking isLoaded, and would start the half-primed buffer.
  const play = raw._play as () => unknown;
  raw._play = () => (raw.isLoaded ? play() : Promise.resolve({ status: "not-loaded" }));
}

/**
 * Report what `_play()` and `finished()` do to the transport. Every start and
 * every ▶ pause goes through `_play()` (▶, an autoplay, a re-prime or tempo
 * change playing on), which `play()` reaches as `self._play`; the timer's
 * end-of-tune callback calls `self.finished()`. Both are instance lookups.
 */
function reportPlayback(
  raw: Record<string, unknown>,
  onEvent: (event: TransportEvent) => void,
): void {
  const play = raw._play as () => unknown;
  raw._play = () => {
    const wasStarted = Boolean(raw.isStarted);
    playsInFlight.set(raw, (playsInFlight.get(raw) ?? 0) + 1);
    const settled = () => playsInFlight.set(raw, (playsInFlight.get(raw) ?? 1) - 1);
    return Promise.resolve(play()).then(
      (value) => {
        settled();
        if (!wasStarted && raw.isStarted) onEvent({ type: "started" });
        else if (wasStarted && !raw.isStarted) onEvent({ type: "paused" });
        return value;
      },
      (error: unknown) => {
        settled();
        throw error;
      },
    );
  };
  const finished = raw.finished as () => unknown;
  raw.finished = () => {
    const wasStarted = Boolean(raw.isStarted);
    const result = finished();
    // "continue" is a loop restart.
    if (result !== "continue" && wasStarted && !raw.isStarted) {
      onEvent({ type: "finished" });
    }
    return result;
  };
}

/**
 * A `play()` while another is still waiting for a load joins it.
 *
 * `_play()` toggles `isStarted`, so a second play() queued behind a load
 * (runWhenReady polls every 500 ms) switched the tune off within half a second
 * of it starting. That is what the ▶ you are told to press did to an autoplay
 * parked on blocked audio, and to a slow first load clicked twice. Only while
 * something is loading: a play stuck on a stalled load that a later re-prime
 * went round would otherwise swallow every ▶.
 */
function joinPendingPlay(raw: Record<string, unknown>): void {
  const play = raw.play as () => unknown;
  let starting: Promise<unknown> | null = null;
  /** When the last play() that went through here settled. */
  let settledAt = Number.NEGATIVE_INFINITY;
  raw.play = () => {
    // Still loading, or loaded and inside _play() resuming the context before
    // it flips isStarted: the second toggle would switch the first one off.
    if (starting && (raw.isLoading || (playsInFlight.get(raw) ?? 0) > 0)) return starting;
    // The press that released a parked autoplay. Its pointerdown woke the
    // audio, the load (samples already cached) finished before the click, and
    // the click's play() toggled the tune straight off again (Codex review).
    // A start that landed during this very gesture is what the press asked for.
    const now = performance.now();
    if (raw.isStarted && settledAt > gestureStartedAt && now - gestureStartedAt < PRESS_TO_CLICK_MS) {
      settledAt = Number.NEGATIVE_INFINITY;
      return Promise.resolve({ status: "joined" });
    }
    const result = play();
    if (result && typeof (result as Promise<unknown>).then === "function") {
      const pending = result as Promise<unknown>;
      starting = pending;
      const done = () => {
        if (starting !== pending) return;
        starting = null;
        settledAt = performance.now();
      };
      pending.then(done, done);
    }
    return result;
  };
}

/**
 * Resolve once nothing is loading or starting on `control`, or as soon as
 * `stillWanted()` goes false.
 *
 * It waits on the tracked promises rather than on `isLoading`, for two
 * reasons. The `_play()` that follows a load resumes the AudioContext before
 * it flips `isStarted`, so "not loading" arrives before "playing". And a
 * `play()` spinning in `runWhenReady` while `isLoading` is set has no load of
 * its own to wait for: it is not waited on while the flag stays up.
 *
 * A load can hang. `go()` first awaits `AudioContext.resume()`, which under a
 * blocked autoplay stays pending until something resumes the context during
 * a user gesture. The caller wakes the context from the gesture that asked
 * for the change, and `stillWanted` is polled so that a superseded controller
 * is never waited on. Each poll subscribes to nothing: `track()` wakes the
 * waiters when a call settles. Racing a fresh `Promise.allSettled()` of the
 * pending calls every poll added a reaction to each of them every 100 ms for
 * as long as a load hung.
 */
export async function whenTransportIdle(
  control: object,
  stillWanted: () => boolean,
  pollMs = 100,
): Promise<void> {
  const state = tracked.get(control);
  if (!state) return;
  const raw = internals(control);
  const busy = () =>
    state.loads.size > 0 || (state.calls.size > 0 && !raw.isLoading);
  while (busy() && stillWanted()) await nextSettle(state, pollMs);
}

/** Resolve when a tracked call settles, or after `ms` to re-check the caller. */
function nextSettle(state: Tracked, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      state.waiters.delete(wake);
      resolve();
    };
    const timer = setTimeout(wake, ms);
    state.waiters.add(wake);
  });
}

const noop = () => {};

/**
 * How long a queued change waits (for the change before it, then for the
 * controller to go idle) before it runs anyway. abcjs fetches each sample
 * with a bare XMLHttpRequest (load-note.js: onload and onerror, no timeout),
 * so one stalled request kept go() pending forever and every change queued
 * behind it never applied. Long enough for a slow first load of a large bank;
 * a load still running after that is presumed dead, and the change's own
 * load starts beside it.
 */
export const TRANSPORT_WAIT_LIMIT_MS = 15_000;

/** Resolve when `promise` settles or after `ms`, whichever is first. */
function settledWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, ms);
    promise.then(done, done);
  });
}

/**
 * Transport changes, one at a time, each run once the live controller is idle.
 *
 * Every change that re-primes goes through here: instrument and sound changes,
 * edits, and the % field. The live controller is re-read after each wait: one
 * replaced mid-wait (a new tool call, a Style re-render) may be loading its own
 * autoplay, and a change run on it then was the #33 double load again, on the
 * replacement.
 */
export class TransportQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    /** The widget's live controller, if any. */
    private readonly current: () => object | null,
    /** False once the widget is torn down. */
    private readonly alive: () => boolean = () => true,
    private readonly limitMs = TRANSPORT_WAIT_LIMIT_MS,
  ) {}

  /**
   * Run `step` after every earlier step, once the live controller is idle.
   *
   * Strictly one at a time: the next step's turn comes when this one settles,
   * or `limitMs` after it STARTED if it never does (its setTune stuck on a dead
   * sample request). Deadlines used to count from when a step was queued, so
   * every step behind a hung one timed out together and three re-primes ran
   * side by side on one buffer (Codex review).
   */
  run<T>(step: () => T | PromiseLike<T>): Promise<T> {
    const previous = this.tail;
    let release: () => void = noop;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous
      .then(() => this.waitIdle())
      .then(() => {
        const result = Promise.resolve().then(step);
        void settledWithin(result, this.limitMs).then(release);
        return result;
      });
  }

  /** Is `control` still the widget's live controller? */
  isCurrent(control: object): boolean {
    return this.alive() && this.current() === control;
  }

  /** Wait, from this step's turn, until the live controller is idle. */
  private async waitIdle(): Promise<void> {
    const deadline = Date.now() + this.limitMs;
    let control = this.current();
    while (control && this.alive() && Date.now() < deadline) {
      const waitingOn = control;
      await whenTransportIdle(
        waitingOn,
        () => this.isCurrent(waitingOn) && Date.now() < deadline,
      );
      control = this.current();
      if (control === waitingOn) return;
    }
  }
}

/**
 * Send the % field's tempo changes through `queue`.
 *
 * abcjs's `setWarp()` calls `go()` directly, so a change made while a load was
 * in flight (the autoplay, a sound change, an edit, the previous tempo) put a
 * second init + prime on the same buffer. The field reaches it as
 * `self.setWarp` (`onWarp`), an instance lookup. A burst from the field's
 * spinner collapses to its last value, and a change for a controller that
 * has since been replaced is dropped.
 */
export function queueWarp(
  control: object,
  queue: TransportQueue,
  /**
   * Asked when the % field is changed; the answer is called once the change
   * has run. setWarp() plays on regardless of what happened meanwhile (it
   * restarts whatever was playing when it BEGAN), so the widget uses this to
   * stop a tempo change from undoing a cancel.
   */
  watch?: () => () => void,
): void {
  const raw = internals(control);
  const setWarp = raw.setWarp;
  let latest = 0;
  raw.setWarp = (warp: unknown) => {
    const request = ++latest;
    const after = watch?.();
    return queue.run(async () => {
      if (request !== latest || !queue.isCurrent(control)) return undefined;
      const result = await setWarp(warp);
      after?.();
      return result;
    });
  };
}

// =============================================================================
// Re-priming for new settings
// =============================================================================

export interface ReprimeHooks {
  /** `setTune(tune, true, options)`: pauses, rewinds, re-primes. */
  prime(): Promise<unknown>;
  /**
   * False once something newer has the transport: a cancel, an edit, a new
   * render or a teardown. Checked after every await.
   */
  stillWanted(): boolean;
  /** The change was superseded after it had started the music again. */
  onSuperseded?(): void;
}

/**
 * Re-prime `control` for new synth settings (instrument, sound bank) and hand
 * the transport back as the listener left it: Loop kept, and playing again
 * (from bar 1, since `setTune()` rewinds) only if it was playing.
 *
 * `prime()` must pass `userAction: true`. abcjs never clears `isLoaded`, so
 * with `false` the next ▶ replays the previous settings' buffer.
 */
export async function reprime(control: object, hooks: ReprimeHooks): Promise<void> {
  const transport = readTransport(control);
  await hooks.prime();
  // A cancel keeps the controller, so "is it still ours?" is not enough: the
  // music must not come back after the user stopped it.
  if (!hooks.stillWanted()) return;
  restoreLoop(control, transport);
  if (!transport.wasPlaying) return;
  await internals(control).play();
  if (!hooks.stillWanted()) hooks.onSuperseded?.();
}
