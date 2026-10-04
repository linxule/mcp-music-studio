// =============================================================================
// The stage runtime — four primitives an audiovisual piece is built from
//
// Pattern code in the widget is real browser JavaScript. Pieces made in
// claude.ai on 2026-10-01 (tests/fixtures/pieces/) drew on their own canvases,
// fed them to Hydra, re-rendered them as ASCII, spoke, and took taps. Every one
// of them also rebuilt the same plumbing by hand, and got it wrong in the same
// ways:
//
//   - a clock: `H(signal(t => t))` was 0 forever (a Fraction, see
//     hap-number.ts), so two pieces froze at bar 1 with no error;
//   - an animation loop with a `window.__raf` leak guard, because a
//     re-evaluation otherwise left the old loop drawing;
//   - note onsets: `pattern.queryArc(last, now).filter(h => h.hasOnset())`;
//   - a pointer listener that had to skip the editor and the buttons.
//
// So the widget (and the share page, which carries a copy — see
// tests/share-page-stage.test.ts) publishes four globals:
//
//   cycle()               → the cycle being HEARD now, as a number
//   onFrame(fn)           → fn({ cycle, dt, time, playing }) every frame
//   onEvent(pattern, fn)  → fn(event) as each event of `pattern` becomes audible
//   onTap(fn)             → fn({ x, y, cycle, next }) for taps on the stage (0..1)
//   say(text, { voice })  → a PATTERN that plays the words as a sample
//   sing(line, notes)     → a PATTERN that plays the words ON the notes
//
// The DUET field test (claude.ai web, desktop and phone apps) is why the last
// two exist: speech never played and taps sounded only sometimes. A tap
// quantised "two steps ahead" of a hand-built clock could land BEFORE the
// scheduler's horizon — events it had already committed — and vanish;
// tap.next(n) returns a slot past it. And browser speechSynthesis never started
// in the app's webview, even after a tap — and lives outside the audio graph
// anyway. say() has the hosted Worker render the words (src/shared/tts.ts) and
// registers the clip as a sample, so speech is scheduled, mixed and recorded
// like any other sound.
//
// Every registration belongs to the evaluation that made it. A successful
// re-evaluation replaces the previous set; a failed one keeps it (the old
// pattern is still playing, so its visuals should be too); teardown ends all.
//
// Pure: everything browser-specific comes in through StageEnv, so the tests
// drive it with a fake clock and a fake requestAnimationFrame.
// =============================================================================

import { noteNameToMidi } from "./hap-number.js";
import { normalizeTts, ttsSampleName, ttsUrl, type TtsRequest } from "./tts.js";
import { analyseWords, type AnalysedWord } from "./sing-dsp.js";
import {
  autoOctave,
  buildPhrase,
  layoutWords,
  noteSource,
  spokenMedianHz,
  ttsWordsUrl,
  wordSpeeds,
  type SungReport,
  type SungWord,
} from "./sing.js";
import {
  createRememberStore,
  type RememberChange,
  type RememberedEntry,
  type RememberHandle,
  type RememberOptions,
} from "./remember-store.js";

export type { RememberChange, RememberedEntry, RememberHandle, RememberOptions } from "./remember-store.js";

export interface StageEnv {
  /** The cycle being heard now, or null when there is no running scheduler. */
  audibleCycle(): number | null;
  /** Is the scheduler running? */
  isPlaying(): boolean;
  requestFrame(callback: (ms: number) => void): number;
  cancelFrame(id: number): void;
  /** Deliver taps on the stage, normalised to 0..1; returns an unsubscribe. */
  listenTaps(deliver: (x: number, y: number) => void): () => void;
  /**
   * The cycle up to which the scheduler has already queried and committed
   * events — a tap placed before it can never sound. Null when unknown.
   */
  scheduledUntil?(): number | null;
  /** Where say() clips are rendered (the hosted Worker's origin). */
  ttsOrigin?: string;
  /** Register a sample URL under a name (Strudel's samples({ name: url })). */
  registerSample?(name: string, url: string): void;
  /** A pattern playing the named sound (Strudel's s(name)). */
  sound?(name: string): unknown;
  /** Start downloading a clip now, so its first trigger isn't late. */
  prefetch?(url: string): void;
  /** Silence raw browser speechSynthesis (a stop, a new evaluation, teardown). */
  cancelSpeech?(): void;
  /**
   * sing(): the line's word timings and its decoded clip (mono), with the
   * clip registered as the sample `ttsSampleName(request)`. Rejects after
   * reporting a load failure itself (like say()).
   */
  loadSung?(request: TtsRequest): Promise<SungClip>;
  /** A pattern that plays whatever `get()` returns when queried, silence while null. */
  lazyPattern?(get: () => unknown): unknown;
  /** Strudel's timecat / stepcat: [weight, pattern] pairs in one cycle. */
  timecat?(...pairs: Array<[number, unknown]>): unknown;
  /** Turn a non-pattern (a single-quoted mini-notation string) into one. */
  toPattern?(value: unknown): unknown;
  /** Cycles per second, for converting the tap margin. */
  cps?(): number | null;
  /** A registered callback threw. Called once per registration, not per frame. */
  reportError(api: string, error: unknown): void;
  /**
   * Sees every tap delivered to the piece (a live session logs them), AFTER
   * the piece's tap callbacks ran: `changedState` says whether they wrote
   * remember() state — the app then logs the state change, not the raw tap.
   */
  observeTap?(tap: { x: number; y: number; cycle: number }, info?: { changedState: boolean }): void;
  /** Strudel's signal(): a continuous pattern that samples `read` when queried. */
  signal?(read: () => number): unknown;
  /**
   * Show the committed evaluation's controls with their current values; the
   * surface calls `input` as the performer moves them (`final` on release).
   */
  renderControls?(controls: ControlSpec[], values: ReadonlyMap<string, ControlValue>, input: ControlInput): void;
  /** A control was set by the performer or a sensor (a live session logs it). */
  observeControl?(change: { name: string; kind: ControlKind; value: ControlValue; cycle: number; source?: ControlSource }): void;
  /**
   * Start or stop the device sensors the committed piece declared. The env
   * calls `feed` with each reading and `status` whenever a sensor's state
   * changes; permission is asked on the next user gesture, never before.
   */
  sensors?(
    want: Record<SensorKind, boolean>,
    feed: (sensor: SensorKind, value: ControlValue) => void,
    status: (sensor: SensorKind, state: SensorState) => void,
  ): void;
  /** Move a rendered control to a sensor's reading (no re-render). */
  showControlValue?(name: string, value: ControlValue): void;
  /** The strip was (re)drawn: a live session snapshots it. */
  observeSurface?(): void;
  /** Milliseconds, for throttling sensor moves into the log. */
  now?(): number;
  /** remember(): a listener write (inside a tap) or an AI merge changed a value. */
  observeRemembered?(change: RememberChange): void;
  /** remember(): some stored value changed; read stage.remembered() (throttle it). */
  observeRememberedState?(): void;
  /** The piece called openStage(): it would like Stage mode (the app decides). */
  requestStage?(): void;
}

/** tilt() reads device orientation; mic() the input loudness. */
export type SensorKind = "tilt" | "mic";
/**
 * live: readings arrive. waiting: a tap is needed to ask permission.
 * listening: asked/listening, nothing has arrived yet. denied: the user or
 * the host refused. unsupported: this browser has no such sensor API.
 * Anything but live means the control is played by hand on the strip.
 */
export interface SensorState {
  state: "live" | "waiting" | "listening" | "denied" | "unsupported" | "off";
  detail?: string;
}
export type ControlSource = "sensor" | "manual";

export type ControlKind = "fader" | "pad" | "xy";
/** A fader or pad is a number; an xy pad is [x, y], each 0..1 (y up). */
export type ControlValue = number | [number, number];
export type ControlInput = (name: string, value: ControlValue, final: boolean) => void;
export interface ControlSpec {
  kind: ControlKind;
  name: string;
  label: string;
  min: number;
  max: number;
  step: number;
  /** pad: stays on until pressed again (otherwise on only while held). */
  toggle: boolean;
  init: ControlValue;
  /** tilt()/mic(): the device sensor that feeds this control when it can. */
  sensor?: SensorKind;
  /** Who moves it right now: the sensor, or the performer's hand. */
  source?: ControlSource;
}

export interface FaderOptions {
  min?: number;
  max?: number;
  init?: number;
  step?: number;
  label?: string;
}
export interface PadOptions {
  toggle?: boolean;
  init?: boolean;
  label?: string;
}

/** A control as a pattern: `.gain(fader('rain'))` — and `.value` for draw loops. */
export type ControlHandle = { readonly value: number };

/** At most this many controls on the strip — it has to fit a phone. */
export const MAX_CONTROLS = 12;

export interface StageFrame {
  cycle: number;
  /** Seconds since the previous frame (0 on the first, capped at 0.25). */
  dt: number;
  /** requestAnimationFrame's clock, in seconds. */
  time: number;
  playing: boolean;
}

export interface StageEvent {
  /** When the event starts, in cycles. */
  cycle: number;
  /** How long it lasts, in cycles. */
  duration: number;
  note?: unknown;
  /** MIDI pitch from `freq` or `note` (c3 = 48, Strudel's rule); undefined for unpitched events. */
  midi?: number;
  s?: unknown;
  n?: unknown;
  gain?: unknown;
  pan?: unknown;
  /** The whole hap value, for anything else (`color`, custom controls). */
  value: unknown;
}

export interface StageTap {
  x: number;
  y: number;
  /** The audible cycle when the tap landed. */
  cycle: number;
  /**
   * The earliest `1/subdivision` slot the scheduler has NOT committed yet, in
   * cycles — where a note for this tap can still sound. next(16) * 16 is a
   * 16th-step index. Default subdivision 16.
   */
  next(subdivision?: number): number;
}

export interface SayOptions {
  /** One of TTS_VOICES (src/shared/tts.ts). Default "luna". */
  voice?: string;
}

export interface SingOptions extends SayOptions {
  /**
   * 'auto' (default): once the line is measured, move the whole melody by
   * −1, 0 or +1 octave, whichever brings its median closest to the voice's
   * speaking pitch, never taking the lowest note under 80 Hz when a higher
   * shift avoids it (src/shared/sing.ts autoOctave) — the shape is kept.
   * A number (−2…2): exactly that many octaves; 0 = the notes as written.
   */
  octave?: number | "auto";
  // `hold` (loop a word's voiced middle to fill a long note) is not built:
  // superdough has no per-event loop points for a slice, so it would take
  // re-rendering the word into its own buffer. Long notes end early instead.
}

/** A sung line's clip, decoded: what sing() measures pitch on. */
export interface SungClip {
  words: SungWord[];
  /** Mono samples of the decoded clip. */
  channel: Float32Array;
  sampleRate: number;
  /** Seconds — the buffer's, which is what begin/end are fractions of. */
  duration: number;
}

type Registration =
  | { kind: "frame"; fn: (frame: StageFrame) => void; failed: boolean }
  | {
      kind: "event";
      fn: (event: StageEvent) => void;
      pattern: { queryArc: (a: number, b: number) => unknown[] };
      last: number | null;
      failed: boolean;
    }
  | { kind: "tap"; fn: (tap: StageTap) => void; failed: boolean };

/** Frames longer than this (a background tab, a stall) don't add up to a jump. */
const MAX_DT = 0.25;

/**
 * Safety margin past the scheduler's horizon, in seconds: a tap's note goes at
 * least this far beyond what the scheduler has committed, so a query that is
 * just about to run still sees it.
 */
const TAP_MARGIN_SECONDS = 0.03;

/**
 * How far past the audible playhead an unknown scheduler may already have
 * committed events: latency 0.1 s + the clock worker's lookahead 0.15 s
 * (interval + overlap, @strudel/core clockworker.js) + one 0.05 s query chunk,
 * rounded up. An over-estimate only delays a tapped note a little; an
 * under-estimate loses it.
 */
const UNKNOWN_HORIZON_SECONDS = 0.35;

/** Number(x) when it's a finite number (a Fraction's valueOf), else undefined. */
function finite(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value === "object") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** A hap → the event object onEvent hands its callback. */
export function stageEvent(hap: any, begin: number): StageEvent {
  const raw = hap?.value;
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : undefined;
  const note = obj ? obj.note : raw;
  let midi: number | undefined;
  const freq = finite(obj?.freq);
  if (freq !== undefined && freq > 0) midi = 12 * Math.log2(freq / 440) + 69;
  else if (typeof note === "string") midi = noteNameToMidi(note.trim()) ?? finite(Number(note));
  else midi = finite(note);
  return {
    cycle: begin,
    duration:
      finite(hap?.duration) ??
      (finite(hap?.whole?.end) !== undefined ? finite(hap?.whole?.end)! - begin : 0),
    note,
    midi,
    s: obj?.s,
    n: obj?.n,
    gain: obj?.gain,
    pan: obj?.pan,
    value: raw,
  };
}

export interface Stage {
  /** The globals a pattern sees. */
  globals: {
    cycle: () => number;
    onFrame: (fn: (frame: StageFrame) => void) => () => void;
    onEvent: (pattern: unknown, fn: (event: StageEvent) => void) => () => void;
    onTap: (fn: (tap: StageTap) => void) => () => void;
    say: (text: unknown, options?: SayOptions) => unknown;
    sing: (line: unknown, notes: unknown, options?: SingOptions) => unknown;
    fader: (name: unknown, options?: FaderOptions) => ControlHandle;
    pad: (name: unknown, options?: PadOptions) => ControlHandle;
    xy: (name: unknown, options?: { label?: string }) => { x: ControlHandle; y: ControlHandle; readonly value: [number, number] };
    tilt: (name?: unknown, options?: { label?: string }) => { x: ControlHandle; y: ControlHandle; readonly value: [number, number] };
    mic: (name?: unknown, options?: { label?: string }) => ControlHandle;
    /** Named state that survives re-runs; the listener changes it, the AI reads it (src/shared/remember-store.ts). */
    remember: (name: unknown, init: unknown, options?: RememberOptions) => RememberHandle;
    /** Ask for Stage mode (drawn controls are tappable only there). Once per evaluation; the app decides. */
    openStage: () => void;
  };
  /** Each sensor's state, measured in this frame (for the model's report). */
  sensorStates(): Record<SensorKind, SensorState>;
  /** Current control values (diagnostics, a live session's snapshot). */
  controls(): Array<{ spec: ControlSpec; value: ControlValue }>;
  /**
   * An evaluation is starting: collect its registrations separately. Returns
   * a token for commit/rollback, so a stale evaluation (one that outlived a
   * queue timeout) can neither adopt nor clear a newer one's registrations.
   */
  begin(): number;
  /**
   * It succeeded: its registrations replace the previous evaluation's. Its
   * remember() state applies now, or — `deferState` — when activateState(token)
   * is called (a quantized swap: at its bar, while the old pattern plays on).
   */
  commit(token?: number, options?: { deferState?: boolean }): void;
  /** Apply a deferred evaluation's remember() state (no-op once superseded). */
  activateState(token: number, atCycle?: number): void;
  /**
   * The running evaluation's pattern is about to be installed (the scheduler
   * may query it at once — a stopped player starting): apply its remember()
   * state now, before that first query. Its commit then doesn't apply it again.
   */
  activateStateNow(token: number): void;
  /** It failed (or was superseded): drop its registrations and staged state, keep the old ones. */
  rollback(token?: number): void;
  /** remember() values as stored now (a live session's snapshot). */
  remembered(): RememberedEntry[];
  /** What each sing() of the committed evaluation became: octave, voice, words at the speed limit. */
  sung(): SungReport[];
  /** Teardown: end everything, for good — later registrations are ignored. */
  stop(): void;
  /** How many registrations are live (tests, diagnostics). */
  size(): number;
}

export function createStage(env: StageEnv): Stage {
  let active = new Set<Registration>();
  let pending: Set<Registration> | null = null;
  let frameId: number | null = null;
  let lastMs: number | null = null;
  let tapOff: (() => void) | null = null;
  let lastCycle = 0;
  // After teardown nothing may register again: an evaluation still in flight
  // when the widget was torn down would otherwise land its onFrame in `active`
  // (pending is gone) and start a loop nobody can stop.
  let disposed = false;
  let generation = 0;
  // Controls: specs belong to an evaluation (like registrations); VALUES
  // outlive it, so re-running a piece mid-performance keeps the faders where
  // the performer left them.
  let controlSpecs = new Map<string, ControlSpec>();
  let pendingControls: Map<string, ControlSpec> | null = null;
  const controlValues = new Map<string, ControlValue>();
  const sensorStates: Record<SensorKind, SensorState> = { tilt: { state: "off" }, mic: { state: "off" } };
  /** Last time (ms) and value a sensor move was logged, per control. */
  const sensorLogged = new Map<string, { at: number; value: ControlValue }>();
  const SENSOR_LOG_MS = 500;
  // remember(): writes made while a tap callback runs synchronously are the
  // listener's (an async continuation is not — it is the piece's).
  let tapDepth = 0;
  let tapChangedState = false;
  // openStage(): asked by the running evaluation / already sent for the committed one.
  let stageAskedPending = false;
  let stageAskedActive = false;

  const cycle = (): number => {
    const c = env.audibleCycle();
    if (c !== null && Number.isFinite(c)) lastCycle = Math.max(0, c);
    return lastCycle;
  };

  const call = (reg: Registration, api: string, arg: unknown): void => {
    const fail = (error: unknown) => {
      if (!reg.failed) {
        reg.failed = true;
        env.reportError(api, error);
      }
    };
    try {
      const result = (reg.fn as (a: unknown) => unknown)(arg) as { then?: unknown } | undefined;
      // An async callback throws by rejecting — report that the same way.
      if (result && typeof result.then === "function") Promise.resolve(result).catch(fail);
    } catch (error) {
      fail(error);
    }
  };

  const needsFrames = () => [...active].some((r) => r.kind !== "tap");

  const fireEvents = (reg: Extract<Registration, { kind: "event" }>, now: number): void => {
    const from = reg.last;
    reg.last = now;
    // First frame, stopped (no movement), or a jump (a seek, a stall, a loop
    // restart): don't replay a backlog of events all at once.
    if (from === null || now <= from || now - from > 1) return;
    let haps: unknown[];
    try {
      haps = reg.pattern.queryArc(from, now);
    } catch (error) {
      if (!reg.failed) {
        reg.failed = true;
        env.reportError("onEvent", error);
      }
      return;
    }
    for (const hap of haps as any[]) {
      if (typeof hap?.hasOnset === "function" && !hap.hasOnset()) continue;
      const begin = finite(hap?.whole?.begin) ?? finite(hap?.part?.begin);
      if (begin === undefined || begin < from || begin >= now) continue;
      let event: StageEvent;
      try {
        event = stageEvent(hap, begin);
      } catch {
        continue; // an exotic hap value must not take the frame loop down
      }
      call(reg, "onEvent", event);
    }
  };

  const tick = (ms: number): void => {
    frameId = null;
    const dt = lastMs === null ? 0 : Math.min(MAX_DT, Math.max(0, (ms - lastMs) / 1000));
    lastMs = ms;
    const now = cycle();
    const playing = env.isPlaying();
    for (const reg of [...active]) {
      if (!active.has(reg)) continue; // cancelled by an earlier callback this frame
      if (reg.kind === "frame") call(reg, "onFrame", { cycle: now, dt, time: ms / 1000, playing });
      else if (reg.kind === "event") fireEvents(reg, now);
    }
    if (needsFrames() && frameId === null) frameId = env.requestFrame(tick);
  };

  const next = (subdivision = 16): number => {
    const n = Number.isFinite(subdivision) && subdivision > 0 ? subdivision : 16;
    const heard = cycle();
    const horizon = env.scheduledUntil?.();
    const cps = env.cps?.() ?? 0.5;
    // Unknown horizon (NeoCyclist keeps none): what you hear trails scheduling
    // time by `latency` (0.1 s), and the clock worker queries interval +
    // overlap (0.15 s) past that, in chunks — so assume UNKNOWN_HORIZON_SECONDS.
    const from = (horizon !== null && horizon !== undefined && Number.isFinite(horizon)
      ? Math.max(horizon, heard)
      : heard + UNKNOWN_HORIZON_SECONDS * cps) + TAP_MARGIN_SECONDS * cps;
    return Math.ceil(from * n - 1e-9) / n;
  };

  const deliverTap = (x: number, y: number): void => {
    const tap = { x, y, cycle: cycle(), next };
    tapChangedState = false;
    for (const reg of [...active]) {
      if (reg.kind !== "tap") continue;
      tapDepth++;
      try {
        call(reg, "onTap", tap);
      } finally {
        tapDepth--;
      }
    }
    // After the callbacks: the observer learns whether the tap changed state.
    try {
      env.observeTap?.({ x, y, cycle: tap.cycle }, { changedState: tapChangedState });
    } catch { /* an observer never stops the piece's own tap */ }
  };

  const sync = (): void => {
    if (needsFrames()) {
      if (frameId === null) {
        lastMs = null;
        frameId = env.requestFrame(tick);
      }
    } else if (frameId !== null) {
      env.cancelFrame(frameId);
      frameId = null;
    }
    const wantsTaps = [...active].some((r) => r.kind === "tap");
    if (wantsTaps && !tapOff) tapOff = env.listenTaps(deliverTap);
    else if (!wantsTaps && tapOff) {
      tapOff();
      tapOff = null;
    }
  };

  const add = (reg: Registration): (() => void) => {
    if (disposed) return () => undefined;
    (pending ?? active).add(reg);
    sync();
    return () => {
      active.delete(reg);
      pending?.delete(reg);
      sync();
    };
  };

  const controlName = (api: string, name: unknown): string => {
    // fader("rain") with DOUBLE quotes arrives as a one-value mini-notation
    // pattern (the transpiler's rule) — take its value rather than refuse it.
    if (name && typeof name === "object" && typeof (name as any).__pure === "string") name = (name as any).__pure;
    else if (name && typeof name === "object" && typeof (name as any).queryArc === "function") {
      try {
        const v = (name as any).queryArc(0, 1)[0]?.value;
        if (typeof v === "string") name = v;
      } catch { /* not a name */ }
    }
    if (typeof name !== "string" || !name.trim()) throw new TypeError(`${api} needs a name, e.g. ${api.replace("(name)", "('rain')")}`);
    return name.trim().slice(0, 32);
  };

  const remembering = createRememberStore({
    now: () => env.now?.() ?? Date.now(),
    cycle: () => {
      const c = env.audibleCycle();
      return c !== null && Number.isFinite(c) ? Math.max(0, c) : null;
    },
    listenerWriting: () => tapDepth > 0,
    listenerWrote: () => {
      tapChangedState = true;
    },
    observe: (change) => env.observeRemembered?.(change),
    changed: () => env.observeRememberedState?.(),
    reportError: (api, error) => env.reportError(api, error),
  });

  const declare = (spec: ControlSpec): void => {
    if (pendingControls && remembering.declaresNow(spec.name)) {
      throw new TypeError(`'${spec.name}' is already a remember() name in this piece — give the ${spec.kind} its own name`);
    }
    const known = controlValues.get(spec.name);
    const fits =
      known !== undefined &&
      (spec.kind === "xy" ? Array.isArray(known) : typeof known === "number" && known >= spec.min && known <= spec.max);
    if (!fits) controlValues.set(spec.name, spec.init);
    if (!pendingControls) return; // called from a draw loop: just read it
    if (!pendingControls.has(spec.name) && pendingControls.size >= MAX_CONTROLS) {
      throw new RangeError(`At most ${MAX_CONTROLS} controls fit on the strip`);
    }
    pendingControls.set(spec.name, spec);
  };

  const readNumber = (name: string, index?: 0 | 1): number => {
    const v = controlValues.get(name);
    if (Array.isArray(v)) return v[index ?? 0];
    return typeof v === "number" ? v : 0;
  };

  const handle = (read: () => number): ControlHandle => {
    const pattern = (env.signal?.(read) ?? {}) as object;
    Object.defineProperty(pattern, "value", { get: read, configurable: true, enumerable: false });
    return pattern as ControlHandle;
  };

  const setControl: ControlInput = (name, value, final) => {
    const spec = controlSpecs.get(name);
    if (!spec || disposed) return;
    const clean: ControlValue = Array.isArray(value)
      ? [Math.min(1, Math.max(0, value[0])), Math.min(1, Math.max(0, value[1]))]
      : Math.min(spec.max, Math.max(spec.min, Number(value) || 0));
    // A control the sensor is playing doesn't take the hand too.
    if (spec.sensor && sensorStates[spec.sensor].state === "live") return;
    controlValues.set(name, clean);
    if (final) {
      try {
        env.observeControl?.({ name, kind: spec.kind, value: clean, cycle: cycle(), ...(spec.sensor ? { source: "manual" as const } : {}) });
      } catch { /* an observer never stops the control */ }
    }
  };

  const sourceOf = (spec: ControlSpec): ControlSpec =>
    spec.sensor ? { ...spec, source: sensorStates[spec.sensor].state === "live" ? "sensor" : "manual" } : spec;

  const renderControls = (): void => {
    try {
      env.renderControls?.([...controlSpecs.values()].map(sourceOf), controlValues, setControl);
      env.observeSurface?.();
    } catch (error) {
      env.reportError("controls", error);
    }
  };

  const feedSensor = (sensor: SensorKind, value: ControlValue): void => {
    if (disposed || sensorStates[sensor].state !== "live") return;
    const now = env.now?.() ?? Date.now();
    for (const spec of controlSpecs.values()) {
      if (spec.sensor !== sensor) continue;
      const clean: ControlValue = Array.isArray(value)
        ? [Math.min(1, Math.max(0, value[0])), Math.min(1, Math.max(0, value[1]))]
        : Math.min(1, Math.max(0, Number(value) || 0));
      controlValues.set(spec.name, clean);
      try {
        env.showControlValue?.(spec.name, clean);
      } catch { /* the strip is cosmetic */ }
      // A sensor moves continuously: log at most twice a second, and only a
      // real change, so the session log holds the gesture, not the noise.
      const last = sensorLogged.get(spec.name);
      const moved = !last || distance(last.value, clean) > 0.03;
      if (moved && (!last || now - last.at >= SENSOR_LOG_MS)) {
        sensorLogged.set(spec.name, { at: now, value: clean });
        try {
          env.observeControl?.({ name: spec.name, kind: spec.kind, value: clean, cycle: cycle(), source: "sensor" });
        } catch { /* an observer never stops the sensor */ }
      }
    }
  };

  const setSensorState = (sensor: SensorKind, state: SensorState): void => {
    const before = sensorStates[sensor];
    sensorStates[sensor] = state;
    // live ↔ not-live changes who plays the control: redraw the strip.
    if ((before.state === "live") !== (state.state === "live") && !disposed) renderControls();
  };

  const syncSensors = (): void => {
    const want = { tilt: false, mic: false };
    if (!disposed) for (const spec of controlSpecs.values()) if (spec.sensor) want[spec.sensor] = true;
    for (const k of ["tilt", "mic"] as const) if (!want[k]) sensorStates[k] = { state: "off" };
    try {
      env.sensors?.(want, feedSensor, setSensorState);
    } catch (error) {
      env.reportError("sensors", error);
    }
  };

  // sing(): one load + analysis per line, kept across evaluations (re-running a
  // piece must not fetch and measure again). A failure is forgotten, so the
  // next evaluation retries it, as say() does.
  type SungLine = { promise: Promise<{ words: AnalysedWord[]; duration: number }>; result?: { words: AnalysedWord[]; duration: number } };
  const sungLines = new Map<string, SungLine>();
  const loadSungLine = (request: TtsRequest): SungLine => {
    const id = `${request.voice}\u0000${request.text}`;
    const known = sungLines.get(id);
    if (known) return known;
    const entry: SungLine = {
      promise: env.loadSung!(request).then((clip) => {
        try {
          const result = { words: analyseWords(clip.channel, clip.sampleRate, clip.words), duration: clip.duration };
          entry.result = result;
          return result;
        } catch (error) {
          env.reportError("sing", error);
          throw error;
        }
      }),
    };
    entry.promise.catch(() => sungLines.delete(id));
    sungLines.set(id, entry);
    return entry;
  };

  // What each sing() call of the committed evaluation became (the model's report).
  let activeSung: SungReport[] = [];
  let pendingSung: SungReport[] | null = null;

  const requireFunction = (api: string, fn: unknown): void => {
    if (typeof fn !== "function") throw new TypeError(`${api} needs a function, got ${typeof fn}`);
  };

  const globals: Stage["globals"] = {
    cycle,
    onFrame(fn) {
      requireFunction("onFrame(fn)", fn);
      return add({ kind: "frame", fn, failed: false });
    },
    onEvent(pattern, fn) {
      requireFunction("onEvent(pattern, fn)", fn);
      const pat = (pattern as any)?.queryArc ? pattern : env.toPattern?.(pattern);
      if (!pat || typeof (pat as any).queryArc !== "function") {
        throw new TypeError("onEvent(pattern, fn) needs a pattern — e.g. onEvent(note(\"c e g\"), fn)");
      }
      return add({ kind: "event", fn, pattern: pat as any, last: null, failed: false });
    },
    onTap(fn) {
      requireFunction("onTap(fn)", fn);
      return add({ kind: "tap", fn, failed: false });
    },
    say(text, options) {
      const request = normalizeTts(text, options?.voice);
      if ("error" in request) throw new TypeError(request.error);
      if (!env.registerSample || !env.sound || !env.ttsOrigin) {
        throw new Error("say() is not available on this page");
      }
      const name = ttsSampleName(request);
      const url = ttsUrl(env.ttsOrigin, request);
      env.registerSample(name, url);
      env.prefetch?.(url);
      return env.sound(name);
    },
    sing(line, notes, options = {}) {
      const request = normalizeTts(line, options?.voice);
      if ("error" in request) throw new TypeError(request.error.replace(/^say\(\)/, "sing()"));
      const { loadSung, lazyPattern, timecat, sound } = env;
      if (!loadSung || !lazyPattern || !timecat || !sound || !env.ttsOrigin) {
        throw new Error("sing() is not available on this page");
      }
      const auto = options.octave === undefined || options.octave === "auto";
      const fixed = auto ? 0 : finite(options.octave);
      if (fixed === undefined || !Number.isInteger(fixed) || Math.abs(fixed) > 2) {
        throw new RangeError("sing(): octave is 'auto' or a whole number from -2 to 2");
      }
      const source = noteSource(notes, (hap) => stageEvent(hap, Number(hap?.whole?.begin ?? 0)).midi, env.toPattern);
      const name = ttsSampleName(request);
      const sung = loadSungLine(request);
      let phrase: unknown = null;
      const report: SungReport = { line: request.text, voice: request.voice, ready: false };
      (pendingSung ?? activeSung).push(report);
      const build = (words: AnalysedWord[], duration: number) => {
        const layout = layoutWords(words.length, source);
        const spokenHz = words.map((w) => w.hz);
        const voice = spokenMedianHz(spokenHz);
        const octave = auto ? autoOctave(layout.placed.map((p) => p.midi), voice) : fixed;
        const { speeds, clamped } = wordSpeeds(
          spokenHz,
          layout.placed.map((p) => p.midi + 12 * octave),
        );
        Object.assign(report, { ready: true, octave, auto, spokenHz: voice, words: layout.placed.length, clamped });
        phrase = buildPhrase({ sound, timecat, silence: lazyPattern(() => null) } as any, name, layout, (p) => ({
          begin: words[p.index].start / duration,
          end: words[p.index].end / duration,
          speed: speeds[p.index],
        }));
      };
      if (sung.result) build(sung.result.words, sung.result.duration);
      else
        sung.promise.then(
          (r) => {
            try {
              build(r.words, r.duration);
            } catch (error) {
              env.reportError("sing", error);
            }
          },
          () => undefined, // reported where it failed
        );
      return lazyPattern(() => phrase);
    },
    fader(name, options = {}) {
      const id = controlName("fader(name)", name);
      const min = finite(options.min) ?? 0;
      const max = finite(options.max) ?? 1;
      if (!(max > min)) throw new RangeError(`fader('${id}'): max must be greater than min`);
      const init = Math.min(max, Math.max(min, finite(options.init) ?? min));
      declare({
        kind: "fader",
        name: id,
        label: typeof options.label === "string" ? options.label.slice(0, 24) : id,
        min,
        max,
        step: finite(options.step) ?? (max - min) / 100,
        toggle: false,
        init,
      });
      return handle(() => readNumber(id));
    },
    pad(name, options = {}) {
      const id = controlName("pad(name)", name);
      declare({
        kind: "pad",
        name: id,
        label: typeof options.label === "string" ? options.label.slice(0, 24) : id,
        min: 0,
        max: 1,
        step: 1,
        toggle: options.toggle === true,
        init: options.init ? 1 : 0,
      });
      return handle(() => readNumber(id));
    },
    xy(name, options = {}) {
      const id = controlName("xy(name)", name);
      declare({
        kind: "xy",
        name: id,
        label: typeof options.label === "string" ? options.label.slice(0, 24) : id,
        min: 0,
        max: 1,
        step: 0,
        toggle: false,
        init: [0.5, 0.5],
      });
      const x = handle(() => readNumber(id, 0));
      const y = handle(() => readNumber(id, 1));
      return {
        x,
        y,
        get value(): [number, number] {
          return [readNumber(id, 0), readNumber(id, 1)];
        },
      };
    },
    tilt(name = "tilt", options = {}) {
      const id = controlName("tilt(name)", name);
      declare({
        kind: "xy",
        name: id,
        label: typeof options.label === "string" ? options.label.slice(0, 24) : id,
        min: 0,
        max: 1,
        step: 0,
        toggle: false,
        init: [0.5, 0.5],
        sensor: "tilt",
      });
      const x = handle(() => readNumber(id, 0));
      const y = handle(() => readNumber(id, 1));
      return {
        x,
        y,
        get value(): [number, number] {
          return [readNumber(id, 0), readNumber(id, 1)];
        },
      };
    },
    mic(name = "mic", options = {}) {
      const id = controlName("mic(name)", name);
      declare({
        kind: "fader",
        name: id,
        label: typeof options.label === "string" ? options.label.slice(0, 24) : id,
        min: 0,
        max: 1,
        step: 0.01,
        toggle: false,
        init: 0,
        sensor: "mic",
      });
      return handle(() => readNumber(id));
    },
    remember(name, init, options) {
      const id = controlName("remember(name)", name);
      if (pendingControls?.has(id)) {
        throw new TypeError(`remember('${id}'): '${id}' is already a control in this piece — give the state its own name`);
      }
      return remembering.declare(id, init, options);
    },
    openStage() {
      if (disposed) return;
      if (pending) {
        stageAskedPending = true;
        return;
      }
      if (stageAskedActive) return;
      stageAskedActive = true;
      try {
        env.requestStage?.();
      } catch (error) {
        env.reportError("openStage", error);
      }
    },
  };

  return {
    globals,
    begin() {
      pending = new Set();
      pendingControls = new Map();
      pendingSung = [];
      stageAskedPending = false;
      remembering.begin(generation + 1);
      return ++generation;
    },
    commit(token, options) {
      if (!pending || (token !== undefined && token !== generation)) return;
      active = pending;
      pending = null;
      if (pendingControls) controlSpecs = pendingControls;
      pendingControls = null;
      if (pendingSung) activeSung = pendingSung;
      pendingSung = null;
      remembering.commit(generation, options?.deferState === true);
      stageAskedActive = stageAskedPending;
      stageAskedPending = false;
      syncSensors();
      renderControls();
      // The previous piece's sentence does not belong to this one.
      env.cancelSpeech?.();
      sync();
      if (stageAskedActive) {
        try {
          env.requestStage?.();
        } catch (error) {
          env.reportError("openStage", error);
        }
      }
    },
    activateState(token, atCycle) {
      remembering.activate(token, atCycle);
    },
    activateStateNow(token) {
      if (token !== generation || !pending) return;
      remembering.activateEarly(token);
    },
    rollback(token) {
      if (token !== undefined && token !== generation) return;
      pending = null;
      pendingControls = null;
      pendingSung = null;
      stageAskedPending = false;
      remembering.rollback(generation);
      sync();
    },
    stop() {
      disposed = true;
      active = new Set();
      pending = null;
      pendingControls = null;
      controlSpecs = new Map();
      activeSung = [];
      pendingSung = null;
      remembering.stop();
      syncSensors();
      renderControls();
      env.cancelSpeech?.();
      sync();
    },
    remembered: () => remembering.entries(),
    sung: () => activeSung.map((r) => ({ ...r })),
    size: () => active.size,
    controls: () =>
      [...controlSpecs.values()].map((spec) => ({ spec: sourceOf(spec), value: controlValues.get(spec.name) ?? spec.init })),
    sensorStates: () => ({ tilt: { ...sensorStates.tilt }, mic: { ...sensorStates.mic } }),
  };
}

function distance(a: ControlValue, b: ControlValue): number {
  if (Array.isArray(a) && Array.isArray(b)) return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b);
  return Infinity;
}

// -----------------------------------------------------------------------------
// Raw browser speech — not an API of ours, but kept safe for pieces that use it
// -----------------------------------------------------------------------------

/**
 * A piece may still call speechSynthesis directly (it works in some desktop
 * browsers). Two defaults make that safe: unlock() speaks one silent space
 * inside a user gesture (WebKit only lets a frame speak after a speak() made in
 * one), and cancel() stops a sentence when the music stops.
 */
export function guardBrowserSpeech(
  synth: { speak(u: any): void; cancel(): void; speaking?: boolean; pending?: boolean } | null | undefined,
  Utterance: (new (text: string) => any) | null | undefined,
): { unlock(): void; cancel(): void } {
  let unlocked = false;
  return {
    unlock() {
      if (unlocked || !synth || typeof Utterance !== "function") return;
      unlocked = true;
      try {
        const u = new Utterance(" ");
        u.volume = 0;
        synth.speak(u);
      } catch {
        /* best effort */
      }
    },
    cancel() {
      if (!synth || (!synth.speaking && !synth.pending)) return;
      try {
        synth.cancel();
      } catch {
        /* nothing to cancel */
      }
    },
  };
}

// -----------------------------------------------------------------------------
// Browser wiring — shared by the widget and the share page
// -----------------------------------------------------------------------------

/** A touch that travels further than this is a scroll, not a tap (as in audio-unlock.ts). */
const TAP_SLOP_PX = 10;

/** Taps on these are the UI's, not the piece's. Blank editor space still counts. */
export const TAP_EXCLUDE =
  "button, input, select, textarea, a, label, summary, .cm-line, .cm-gutters, .cm-panels, .cm-tooltip, [role=button], .ms-controls";

export interface BrowserStageOptions {
  /** The running StrudelMirror's scheduler (Cyclist or NeoCyclist), if any. */
  getScheduler(): any;
  isPlaying(): boolean;
  /** Where taps count: the widget's stage section. */
  tapArea: HTMLElement;
  reportError(api: string, error: unknown): void;
  /** Where say() clips are rendered. */
  ttsOrigin: string;
  /** A say() clip could not be loaded — once per clip, with the server's reason. */
  reportSpeech?(url: string, reason: string): void;
  observeTap?(tap: { x: number; y: number; cycle: number }, info?: { changedState: boolean }): void;
  observeControl?(change: { name: string; kind: ControlKind; value: ControlValue; cycle: number; source?: ControlSource }): void;
  observeRemembered?(change: RememberChange): void;
  observeRememberedState?(): void;
  requestStage?(): void;
  /** Where the control strip goes (default: tapArea). */
  controlsHost?: HTMLElement;
  /** The strip was redrawn (a live session snapshots it). */
  observeSurface?(): void;
  /** A sensor's state changed — measured here, for the model's report. */
  observeSensor?(sensor: SensorKind, state: SensorState): void;
}

/** The browser env plus what only a page needs: waiting for say() clips. */
export interface BrowserStage {
  env: StageEnv;
  speech: ReturnType<typeof guardBrowserSpeech>;
  /**
   * Resolves when every say() clip and sing() line requested so far has loaded or failed, or
   * after `timeoutMs`. A page evaluates a voiced piece WITHOUT starting, waits
   * on this, then starts — superdough drops a sample that isn't decoded by its
   * start time, so a line in bar 0 was lost on first play.
   */
  speechReady(timeoutMs: number): Promise<void>;
}

/**
 * The StageEnv for a real page. `window` is only touched when this is called,
 * so importing the module stays side-effect free.
 */
export function createBrowserStageEnv(options: BrowserStageOptions): BrowserStage {
  const w = globalThis as any;
  const speech = guardBrowserSpeech(w.speechSynthesis, w.SpeechSynthesisUtterance);
  // superdough 1.3.0's loadBuffer never checks res.ok and caches a failed load
  // for the session, so a clip is registered with it only once OUR fetch has
  // succeeded — a 429 or 502 can't poison it, and a later evaluation retries.
  type Clip = { state: "loading" | "ok" | "failed"; done: Promise<void>; names: Set<string> };
  const clips = new Map<string, Clip>();
  /** sing() lines still loading (words, clip, decode) — speechReady waits on them too. */
  const sungLoads = new Set<Promise<unknown>>();
  const register = (name: string, url: string) => {
    if (typeof w.samples !== "function") throw new Error("say(): samples() is not loaded yet");
    void w.samples({ [name]: [url] });
  };
  const loadClip = (url: string): Clip => {
    const existing = clips.get(url);
    if (existing && existing.state !== "failed") return existing;
    const clip: Clip = { state: "loading", done: Promise.resolve(), names: existing?.names ?? new Set() };
    clip.done = (async () => {
      try {
        const res = await w.fetch(url, { mode: "cors" });
        if (!res.ok) {
          const why = String(await res.text().catch(() => "")).slice(0, 160);
          throw new Error(`HTTP ${res.status}${why ? ` — ${why}` : ""}`);
        }
        // Into the HTTP cache (served immutable): superdough's fetch is local.
        await res.arrayBuffer();
        clip.state = "ok";
        for (const name of clip.names) register(name, url);
        // Decode ahead too, where superdough exposes its loader.
        const ac = typeof w.getAudioContext === "function" ? w.getAudioContext() : null;
        if (typeof w.loadBuffer === "function" && ac) await w.loadBuffer(url, ac).catch(() => undefined);
      } catch (err) {
        clip.state = "failed";
        options.reportSpeech?.(url, (err as Error)?.message ?? String(err));
      }
    })();
    clips.set(url, clip);
    return clip;
  };
  const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const sensors = createBrowserSensors(w);
  const env: StageEnv = {
    audibleCycle() {
      const scheduler = options.getScheduler();
      if (!scheduler || !options.isPlaying() || typeof scheduler.now !== "function") return null;
      const now = num(scheduler.now());
      if (now === null) return null;
      // now() is SCHEDULING time: events trigger `latency` seconds after it.
      const latency = num(scheduler.latency) ?? 0.1;
      const cps = num(scheduler.cps) ?? 0.5;
      return now - latency * cps;
    },
    isPlaying: options.isPlaying,
    scheduledUntil() {
      const scheduler = options.getScheduler();
      if (!scheduler || !options.isPlaying()) return null;
      // Cyclist keeps the end of its last query; NeoCyclist does not expose one.
      return num(scheduler.lastEnd);
    },
    cps: () => num(options.getScheduler()?.cps),
    requestFrame: (cb) => w.requestAnimationFrame(cb),
    cancelFrame: (id) => w.cancelAnimationFrame(id),
    listenTaps(deliver) {
      // A mouse or pen press is a tap at once. A TOUCH is a tap only when it
      // ends where it began — otherwise it was the finger scrolling the
      // conversation past the widget (the same rule the audio unlock uses,
      // src/audio-unlock.ts, since 0.5.9). Delivered with the press position.
      const area = options.tapArea;
      const touches = new Map<number, { x: number; y: number; moved: boolean }>();
      const position = (event: PointerEvent): [number, number] | null => {
        const rect = area.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        const x = (event.clientX - rect.left) / rect.width;
        const y = (event.clientY - rect.top) / rect.height;
        return x < 0 || x > 1 || y < 0 || y > 1 ? null : [x, y];
      };
      const down = (event: PointerEvent) => {
        if (event.isPrimary === false) return;
        const target = event.target as Element | null;
        if (target?.closest?.(TAP_EXCLUDE)) return;
        const at = position(event);
        if (!at) return;
        if (event.pointerType === "touch") {
          touches.set(event.pointerId, { x: event.clientX, y: event.clientY, moved: false });
          (touches.get(event.pointerId) as any).at = at;
        } else {
          deliver(at[0], at[1]);
        }
      };
      const move = (event: PointerEvent) => {
        const t = touches.get(event.pointerId);
        if (t && Math.hypot(event.clientX - t.x, event.clientY - t.y) > TAP_SLOP_PX) t.moved = true;
      };
      const up = (event: PointerEvent) => {
        const t = touches.get(event.pointerId) as ({ moved: boolean; at: [number, number] } | undefined);
        touches.delete(event.pointerId);
        if (t && !t.moved) deliver(t.at[0], t.at[1]);
      };
      const cancel = (event: PointerEvent) => void touches.delete(event.pointerId);
      area.addEventListener("pointerdown", down);
      area.addEventListener("pointermove", move);
      area.addEventListener("pointerup", up);
      area.addEventListener("pointercancel", cancel);
      return () => {
        area.removeEventListener("pointerdown", down);
        area.removeEventListener("pointermove", move);
        area.removeEventListener("pointerup", up);
        area.removeEventListener("pointercancel", cancel);
      };
    },
    toPattern: (value) => (typeof w.reify === "function" ? w.reify(value) : undefined),
    reportError: options.reportError,
    observeTap: options.observeTap,
    observeControl: options.observeControl,
    observeRemembered: options.observeRemembered,
    observeRememberedState: options.observeRememberedState,
    requestStage: options.requestStage,
    signal: (read) => (typeof w.signal === "function" ? w.signal(() => read()) : undefined),
    renderControls: (specs, values, input) =>
      renderControlStrip(options.controlsHost ?? options.tapArea, specs, values, input),
    showControlValue: (name, value) => {
      const host = options.controlsHost ?? options.tapArea;
      (host.querySelector(":scope > .ms-controls") as any)?.__msShow?.get(name)?.(value);
    },
    observeSurface: options.observeSurface,
    now: () => Date.now(),
    sensors: (want, feed, status) =>
      sensors.sync(want, feed, (sensor, state) => {
        status(sensor, state);
        options.observeSensor?.(sensor, state);
      }),
    ttsOrigin: options.ttsOrigin,
    registerSample(name, url) {
      // Registered when (and only if) the clip loads — see loadClip.
      const clip = loadClip(url);
      clip.names.add(name);
      if (clip.state === "ok") register(name, url);
    },
    sound(name) {
      if (typeof w.s !== "function") throw new Error("say(): s() is not loaded yet");
      return w.s(name);
    },
    prefetch(url) {
      loadClip(url);
    },
    cancelSpeech: () => speech.cancel(),
    loadSung(request) {
      const url = ttsUrl(options.ttsOrigin, request);
      const done = (async (): Promise<SungClip> => {
        // The words first: on a miss that request renders the clip too, so
        // the clip fetch below is a cache hit.
        let words: SungWord[];
        try {
          const res = await w.fetch(ttsWordsUrl(options.ttsOrigin, request), { mode: "cors" });
          if (!res.ok) {
            const why = String(await res.text().catch(() => "")).slice(0, 160);
            throw new Error(`HTTP ${res.status}${why ? ` — ${why}` : ""}`);
          }
          const body = await res.json();
          words = Array.isArray(body?.words) ? body.words : [];
          if (!words.length) throw new Error("no words came back for this line");
        } catch (err) {
          options.reportSpeech?.(url, (err as Error)?.message ?? String(err));
          throw err;
        }
        const clip = loadClip(url);
        clip.names.add(ttsSampleName(request));
        await clip.done;
        if (clip.state !== "ok") throw new Error("the clip did not load"); // reported by loadClip
        register(ttsSampleName(request), url);
        let buffer: AudioBuffer;
        try {
          // A cache hit: the clip was just fetched (served immutable).
          const res = await w.fetch(url, { mode: "cors" });
          const ac = typeof w.getAudioContext === "function" ? w.getAudioContext() : new w.OfflineAudioContext(1, 1, 48000);
          buffer = await ac.decodeAudioData(await res.arrayBuffer());
        } catch (err) {
          options.reportSpeech?.(url, `sing() could not decode the line: ${(err as Error)?.message ?? String(err)}`);
          throw err;
        }
        let channel: Float32Array = buffer.getChannelData(0);
        if (buffer.numberOfChannels > 1) {
          channel = new Float32Array(channel);
          for (let c = 1; c < buffer.numberOfChannels; c++) {
            const other = buffer.getChannelData(c);
            for (let i = 0; i < channel.length; i++) channel[i] += other[i];
          }
          for (let i = 0; i < channel.length; i++) channel[i] /= buffer.numberOfChannels;
        }
        return { words, channel, sampleRate: buffer.sampleRate, duration: buffer.duration };
      })();
      sungLoads.add(done);
      const forget = () => void sungLoads.delete(done);
      done.then(forget, forget);
      return done;
    },
    lazyPattern(get) {
      if (typeof w.Pattern !== "function") throw new Error("sing(): Strudel is not loaded yet");
      return new w.Pattern((state: unknown) => {
        const inner = get() as { query?: (state: unknown) => unknown[] } | null;
        return inner && typeof inner.query === "function" ? inner.query(state) : [];
      });
    },
    timecat(...pairs) {
      const cat = w.stepcat ?? w.timecat ?? w.timeCat;
      if (typeof cat !== "function") throw new Error("sing(): Strudel is not loaded yet");
      return cat(...pairs);
    },
  };
  const speechReady = async (timeoutMs: number) => {
    const loading: Array<Promise<unknown>> = [
      ...[...clips.values()].filter((c) => c.state === "loading").map((c) => c.done),
      ...sungLoads,
    ];
    if (!loading.length) return;
    let timer: unknown;
    await Promise.race([
      Promise.allSettled(loading),
      new Promise((resolve) => {
        timer = w.setTimeout(resolve, timeoutMs);
      }),
    ]);
    w.clearTimeout(timer);
  };
  return { env, speech, speechReady };
}

// -----------------------------------------------------------------------------
// The control strip — fader(), pad(), xy() drawn for the performer
//
// Native elements on purpose: a range input is multi-touch, keyboard and
// screen-reader ready for free, and survives the host's sandbox. The strip
// sits at the bottom of the stage, above the code, and is excluded from taps.
// Rebuilt only when an evaluation commits — values live in the stage, so a
// rebuilt fader comes back where the performer left it.
// -----------------------------------------------------------------------------

const CONTROL_STYLE = `
.ms-controls{position:absolute;left:0;right:0;bottom:0;z-index:20;display:flex;flex-wrap:wrap;gap:8px;align-items:center;
 padding:8px 10px calc(8px + env(safe-area-inset-bottom,0px));background:color-mix(in srgb,var(--background,#111) 72%,transparent);
 backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);font:12px/1.2 system-ui,sans-serif;color:var(--foreground,#eee);touch-action:none}
.ms-controls.ms-fixed{position:fixed}
.ms-fader{display:flex;align-items:center;gap:6px;flex:1 1 140px;min-width:120px}
.ms-fader span{min-width:3em;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ms-fader input{flex:1;min-width:0;height:32px;accent-color:var(--caret,#7aa2f7)}
.ms-pad{min-width:56px;min-height:44px;padding:0 12px;border-radius:10px;border:1px solid currentColor;background:transparent;
 color:inherit;font:600 12px system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;touch-action:none;user-select:none;-webkit-user-select:none}
.ms-pad[aria-pressed=true]{background:var(--caret,#7aa2f7);color:var(--background,#111);border-color:transparent}
.ms-xy{position:relative;width:96px;height:96px;border-radius:10px;border:1px solid currentColor;touch-action:none;flex:none}
.ms-xy i{position:absolute;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;background:var(--caret,#7aa2f7);pointer-events:none}
.ms-xy span{position:absolute;left:6px;top:4px;opacity:.75;pointer-events:none}
.ms-src{font-style:normal;font-size:10px;opacity:.7;margin-left:4px;letter-spacing:.03em}
.ms-src[data-live]{opacity:1;color:var(--caret,#7aa2f7)}
.ms-xy .ms-src{position:absolute;right:6px;bottom:4px;left:auto;top:auto}
.ms-live{pointer-events:none}
`;

function renderControlStrip(
  host: HTMLElement,
  specs: ControlSpec[],
  values: ReadonlyMap<string, ControlValue>,
  input: ControlInput,
): void {
  const doc = host.ownerDocument;
  if (!doc.getElementById("ms-controls-style")) {
    const style = doc.createElement("style");
    style.id = "ms-controls-style";
    style.textContent = CONTROL_STYLE;
    doc.head.appendChild(style);
  }
  let strip = host.querySelector<HTMLElement>(":scope > .ms-controls");
  if (!specs.length) {
    strip?.remove();
    return;
  }
  if (!strip) {
    strip = doc.createElement("div");
    strip.className = "ms-controls";
    strip.setAttribute("role", "group");
    strip.setAttribute("aria-label", "Controls");
    if (host === doc.body || host === doc.documentElement) strip.classList.add("ms-fixed");
    host.appendChild(strip);
  }
  strip.replaceChildren();
  // Sensor-fed controls move without a redraw: name → show(value).
  const show = new Map<string, (value: ControlValue) => void>();
  (strip as any).__msShow = show;
  const sourceTag = (spec: ControlSpec): HTMLElement | null => {
    if (!spec.sensor) return null;
    const tag = doc.createElement("em");
    tag.className = "ms-src";
    const live = spec.source === "sensor";
    if (live) tag.dataset.live = "";
    tag.textContent = live ? `● ${spec.sensor === "tilt" ? "tilt" : "mic"}` : "by hand";
    tag.title = live
      ? `Played by the device's ${spec.sensor === "tilt" ? "motion sensor" : "microphone"}`
      : `The ${spec.sensor === "tilt" ? "motion sensor" : "microphone"} isn't available here (yet) — tap to allow it, or play it by hand`;
    return tag;
  };
  for (const spec of specs) {
    const value = values.get(spec.name) ?? spec.init;
    if (spec.kind === "fader") {
      const label = doc.createElement("label");
      label.className = "ms-fader";
      const name = doc.createElement("span");
      name.textContent = spec.label;
      const range = doc.createElement("input");
      range.type = "range";
      range.min = String(spec.min);
      range.max = String(spec.max);
      range.step = String(spec.step || "any");
      range.value = String(value);
      range.setAttribute("aria-label", spec.label);
      range.addEventListener("input", () => input(spec.name, Number(range.value), false));
      range.addEventListener("change", () => input(spec.name, Number(range.value), true));
      const tag = sourceTag(spec);
      if (tag) name.appendChild(tag);
      if (spec.source === "sensor") {
        range.disabled = true;
        show.set(spec.name, (v) => {
          if (typeof v === "number") range.value = String(v);
        });
      }
      label.append(name, range);
      strip.appendChild(label);
    } else if (spec.kind === "pad") {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "ms-pad";
      button.textContent = spec.label;
      const show = (on: boolean) => button.setAttribute("aria-pressed", String(on));
      show(value === 1);
      if (spec.toggle) {
        button.addEventListener("click", () => {
          const on = button.getAttribute("aria-pressed") !== "true";
          show(on);
          input(spec.name, on ? 1 : 0, true);
        });
      } else {
        const press = (on: boolean) => {
          if ((button.getAttribute("aria-pressed") === "true") === on) return;
          show(on);
          input(spec.name, on ? 1 : 0, true);
        };
        button.addEventListener("pointerdown", (e) => {
          button.setPointerCapture?.(e.pointerId);
          press(true);
        });
        for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
          button.addEventListener(type, () => press(false));
        }
        button.addEventListener("keydown", (e) => {
          if ((e.key === " " || e.key === "Enter") && !e.repeat) press(true);
        });
        button.addEventListener("keyup", (e) => {
          if (e.key === " " || e.key === "Enter") press(false);
        });
      }
      strip.appendChild(button);
    } else {
      const pad = doc.createElement("div");
      pad.className = "ms-xy";
      pad.setAttribute("role", "slider");
      pad.setAttribute("aria-label", `${spec.label} (x and y)`);
      pad.tabIndex = 0;
      const dot = doc.createElement("i");
      const name = doc.createElement("span");
      name.textContent = spec.label;
      pad.append(name, dot);
      const place = ([x, y]: [number, number]) => {
        dot.style.left = `${x * 100}%`;
        dot.style.top = `${(1 - y) * 100}%`;
        pad.setAttribute("aria-valuetext", `x ${x.toFixed(2)}, y ${y.toFixed(2)}`);
      };
      place(Array.isArray(value) ? value : [0.5, 0.5]);
      const tag = sourceTag(spec);
      if (tag) pad.appendChild(tag);
      if (spec.source === "sensor") {
        pad.classList.add("ms-live");
        show.set(spec.name, (v) => {
          if (Array.isArray(v)) place(v);
        });
      }
      let dragging = false;
      const at = (e: PointerEvent): [number, number] => {
        const r = pad.getBoundingClientRect();
        const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        const y = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
        return [x, y];
      };
      pad.addEventListener("pointerdown", (e) => {
        dragging = true;
        pad.setPointerCapture?.(e.pointerId);
        const v = at(e);
        place(v);
        input(spec.name, v, false);
      });
      pad.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const v = at(e);
        place(v);
        input(spec.name, v, false);
      });
      const end = (e: PointerEvent) => {
        if (!dragging) return;
        dragging = false;
        const v = at(e);
        place(v);
        input(spec.name, v, true);
      };
      pad.addEventListener("pointerup", end);
      pad.addEventListener("pointercancel", end);
      strip.appendChild(pad);
    }
  }
}

// -----------------------------------------------------------------------------
// Device sensors — tilt() and mic()
//
// Field test 2026-10-02: inside the claude.ai widget both are blocked by the
// host's frame (no permission policy for them); on a share page the mic works
// and tilt needs iOS's DeviceOrientationEvent.requestPermission() called
// INSIDE a gesture. So nothing is asked up front: a piece that declares tilt()
// or mic() gets a control on the strip that the performer plays by hand, and
// the first tap asks for the sensor. If readings arrive, the sensor takes the
// control over; if not, the hand keeps it. The state is reported either way.
// -----------------------------------------------------------------------------

type SensorFeed = (sensor: SensorKind, value: ControlValue) => void;
type SensorStatus = (sensor: SensorKind, state: SensorState) => void;

/** Smoothing for readings (0..1 of the gap closed per reading). */
const SENSOR_SMOOTHING = 0.25;
/** Degrees of tilt from level to the edge of the range. */
const TILT_RANGE_DEG = 35;
/** RMS → 0..1: speech near a phone mic sits around 0.05–0.2 RMS. */
const MIC_GAIN = 5;

export function createBrowserSensors(w: any) {
  let want: Record<SensorKind, boolean> = { tilt: false, mic: false };
  let feed: SensorFeed = () => undefined;
  let report: SensorStatus = () => undefined;
  const state: Record<SensorKind, SensorState> = { tilt: { state: "off" }, mic: { state: "off" } };
  const set = (sensor: SensorKind, next: SensorState) => {
    if (state[sensor].state === next.state && state[sensor].detail === next.detail) return;
    state[sensor] = next;
    report(sensor, next);
  };

  // ── tilt ──
  let orientationOn = false;
  let tilt: [number, number] | null = null;
  let baseBeta: number | null = null;
  const onOrientation = (e: any) => {
    const beta = Number(e?.beta);
    const gamma = Number(e?.gamma);
    // Desktop browsers fire one event of nulls: that is "no sensor", not a reading.
    if (!Number.isFinite(beta) || !Number.isFinite(gamma) || (e.beta === null && e.gamma === null)) return;
    if (baseBeta === null) baseBeta = beta; // "level" is however the phone was held at first
    const x = Math.min(1, Math.max(0, 0.5 + gamma / (2 * TILT_RANGE_DEG)));
    const y = Math.min(1, Math.max(0, 0.5 + (baseBeta - beta) / (2 * TILT_RANGE_DEG)));
    tilt = tilt ? [tilt[0] + (x - tilt[0]) * SENSOR_SMOOTHING, tilt[1] + (y - tilt[1]) * SENSOR_SMOOTHING] : [x, y];
    if (state.tilt.state !== "live") set("tilt", { state: "live" });
    feed("tilt", tilt);
  };
  const listenOrientation = (on: boolean) => {
    if (on === orientationOn) return;
    orientationOn = on;
    if (on) w.addEventListener?.("deviceorientation", onOrientation);
    else {
      w.removeEventListener?.("deviceorientation", onOrientation);
      tilt = null;
      baseBeta = null;
    }
  };
  const tiltNeedsPermission = () => typeof w.DeviceOrientationEvent?.requestPermission === "function";
  let tiltAsked = false;

  // ── mic ──
  let micStream: any = null;
  let micTimer: unknown = null;
  let micNodes: any[] = [];
  let micAsked = false;
  let micLevel = 0;
  // Each request gets a generation; a grant that arrives for an older one
  // (the piece dropped mic() and asked again while the prompt was up) is
  // stopped, not adopted — two overlapping grants leaked a live stream
  // (Codex + Kimi review).
  let micGen = 0;
  const stopMic = () => {
    micGen++;
    if (micTimer !== null) w.clearInterval?.(micTimer);
    micTimer = null;
    for (const n of micNodes) {
      try {
        n.disconnect();
      } catch { /* already gone */ }
    }
    micNodes = [];
    micStream?.getTracks?.().forEach((t: any) => t.stop());
    micStream = null;
    micAsked = false;
    micLevel = 0;
  };
  const startMic = () => {
    const gen = ++micGen;
    micAsked = true;
    set("mic", { state: "listening" });
    Promise.resolve()
      .then(() =>
        w.navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        }),
      )
      .then((stream: any) => {
        if (gen !== micGen || !want.mic) {
          stream.getTracks().forEach((t: any) => t.stop());
          return;
        }
        micStream = stream;
        try {
        const ctx =
          (typeof w.getAudioContext === "function" ? w.getAudioContext() : null) ??
          new (w.AudioContext ?? w.webkitAudioContext)();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        // Analysed only: never connected to the speakers, never recorded.
        source.connect(analyser);
        micNodes = [source, analyser];
        const buf = new Float32Array(analyser.fftSize);
        micTimer = w.setInterval(() => {
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
          const target = Math.min(1, Math.sqrt(sum / buf.length) * MIC_GAIN);
          micLevel += (target - micLevel) * SENSOR_SMOOTHING;
          feed("mic", micLevel);
        }, 50);
        } catch (err) {
          // Granted, but the analysis graph could not be built: release the
          // microphone rather than leave it open behind a "denied" (Codex review).
          stream.getTracks().forEach((t: any) => t.stop());
          micStream = null;
          throw err;
        }
        set("mic", { state: "live" });
      })
      .catch((err: any) => {
        // Not asked again in this frame: a host that blocks the mic blocks it
        // on every tap, and a person who said no meant it.
        set("mic", { state: "denied", detail: String(err?.name ?? err?.message ?? err) });
      });
  };

  // ── permission on a gesture ──
  // Capture phase, synchronous: iOS honours requestPermission() only inside
  // the gesture's own task.
  let gestureOn = false;
  const onGesture = () => {
    if (want.tilt && tiltNeedsPermission() && !tiltAsked) {
      tiltAsked = true;
      set("tilt", { state: "listening" });
      try {
        Promise.resolve(w.DeviceOrientationEvent.requestPermission()).then(
          (answer: string) => {
            if (answer === "granted") listenOrientation(want.tilt);
            else set("tilt", { state: "denied", detail: answer });
          },
          (err: any) => set("tilt", { state: "denied", detail: String(err?.name ?? err) }),
        );
      } catch (err: any) {
        set("tilt", { state: "denied", detail: String(err?.name ?? err) });
      }
    }
    if (want.mic && !micAsked && !micStream && w.navigator?.mediaDevices?.getUserMedia) startMic();
  };
  const listenGestures = (on: boolean) => {
    if (on === gestureOn) return;
    gestureOn = on;
    for (const type of ["pointerup", "keydown", "touchend"]) {
      if (on) w.addEventListener?.(type, onGesture, true);
      else w.removeEventListener?.(type, onGesture, true);
    }
  };

  return {
    sync(next: Record<SensorKind, boolean>, nextFeed: SensorFeed, nextReport: SensorStatus) {
      want = { ...next };
      feed = nextFeed;
      report = nextReport;
      // tilt
      if (!want.tilt) {
        listenOrientation(false);
        tiltAsked = false;
        set("tilt", { state: "off" });
      } else if (!w.DeviceOrientationEvent) {
        set("tilt", { state: "unsupported" });
      } else if (tiltNeedsPermission() && !tiltAsked) {
        set("tilt", { state: "waiting" });
      } else if (state.tilt.state !== "live" && state.tilt.state !== "denied") {
        listenOrientation(true);
        set("tilt", { state: "listening" });
      }
      // mic
      if (!want.mic) {
        stopMic();
        set("mic", { state: "off" });
      } else if (!w.navigator?.mediaDevices?.getUserMedia) {
        set("mic", { state: "unsupported" });
      } else if (!micStream && !micAsked && state.mic.state !== "denied") {
        set("mic", { state: "waiting" });
      }
      listenGestures(want.tilt || want.mic);
    },
    states: () => ({ tilt: { ...state.tilt }, mic: { ...state.mic } }),
  };
}
