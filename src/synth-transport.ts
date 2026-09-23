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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
}

const tracked = new WeakMap<object, Tracked>();

/** Transport calls whose promise outlives the load (`_play()`, a seek). */
const PLAYING_CALLS = ["play", "setWarp", "randomAccess"] as const;

function track(set: Set<Promise<unknown>>, result: unknown): void {
  if (!result || typeof (result as Promise<unknown>).then !== "function") return;
  const promise = result as Promise<unknown>;
  set.add(promise);
  const settle = () => {
    set.delete(promise);
  };
  promise.then(settle, settle);
}

/**
 * Record every load and every play on `control`, for {@link whenTransportIdle}.
 *
 * Call it BEFORE `load()`: `load()` hands the Play button and the progress bar
 * `self.play` and `self.randomAccess` by reference. `go()` and `setWarp()` are
 * looked up on the instance whenever abcjs calls them, so those wraps can land
 * at any point.
 */
export function trackTransport(control: object): void {
  const raw = internals(control) as unknown as Record<string, unknown>;
  const state: Tracked = { loads: new Set(), calls: new Set() };
  tracked.set(control, state);
  const wrap = (name: string, into: Set<Promise<unknown>>) => {
    const original = raw[name];
    if (typeof original !== "function") return;
    raw[name] = (...args: unknown[]) => {
      const result = (original as (...a: unknown[]) => unknown)(...args);
      track(into, result);
      return result;
    };
  };
  wrap("go", state.loads);
  for (const name of PLAYING_CALLS) wrap(name, state.calls);
}

/**
 * Resolve once nothing is loading or starting on `control`, or as soon as
 * `stillWanted()` goes false.
 *
 * It waits on the tracked promises rather than on `isLoading`, for two
 * reasons. The `_play()` that follows a load resumes the AudioContext before
 * it flips `isStarted`, so "not loading" arrives before "playing". And `go()`
 * clears `isLoading` only on success: after a failed soundfont fetch it stays
 * true forever, and every later `play()` spins in `runWhenReady`. Such a play
 * has no load in flight to wait for, so it is not waited on. A fresh prime is
 * exactly what gets it moving again.
 *
 * A load can hang. `go()` first awaits `AudioContext.resume()`, which under a
 * blocked autoplay stays pending until something resumes the context during
 * a user gesture. The caller wakes the context from the gesture that asked
 * for the change, and `stillWanted` is polled so that a superseded controller
 * is never waited on.
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
  while (busy() && stillWanted()) {
    await Promise.race([
      Promise.allSettled([...state.loads, ...state.calls]),
      sleep(pollMs),
    ]);
  }
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
