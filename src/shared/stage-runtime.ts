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
import { normalizeTts, ttsSampleName, ttsUrl } from "./tts.js";

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
  /** Turn a non-pattern (a single-quoted mini-notation string) into one. */
  toPattern?(value: unknown): unknown;
  /** Cycles per second, for converting the tap margin. */
  cps?(): number | null;
  /** A registered callback threw. Called once per registration, not per frame. */
  reportError(api: string, error: unknown): void;
  /** Sees every tap delivered to the piece (a live session logs them). */
  observeTap?(tap: { x: number; y: number; cycle: number }): void;
  /** Strudel's signal(): a continuous pattern that samples `read` when queried. */
  signal?(read: () => number): unknown;
  /**
   * Show the committed evaluation's controls with their current values; the
   * surface calls `input` as the performer moves them (`final` on release).
   */
  renderControls?(controls: ControlSpec[], values: ReadonlyMap<string, ControlValue>, input: ControlInput): void;
  /** A control was set by the performer (a live session logs it). */
  observeControl?(change: { name: string; kind: ControlKind; value: ControlValue; cycle: number }): void;
}

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
    fader: (name: unknown, options?: FaderOptions) => ControlHandle;
    pad: (name: unknown, options?: PadOptions) => ControlHandle;
    xy: (name: unknown, options?: { label?: string }) => { x: ControlHandle; y: ControlHandle; readonly value: [number, number] };
  };
  /** Current control values (diagnostics, a live session's snapshot). */
  controls(): Array<{ spec: ControlSpec; value: ControlValue }>;
  /**
   * An evaluation is starting: collect its registrations separately. Returns
   * a token for commit/rollback, so a stale evaluation (one that outlived a
   * queue timeout) can neither adopt nor clear a newer one's registrations.
   */
  begin(): number;
  /** It succeeded: its registrations replace the previous evaluation's. */
  commit(token?: number): void;
  /** It failed (or was superseded): drop its registrations, keep the old ones. */
  rollback(token?: number): void;
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
    try {
      env.observeTap?.({ x, y, cycle: tap.cycle });
    } catch { /* an observer never stops the piece's own tap */ }
    for (const reg of [...active]) if (reg.kind === "tap") call(reg, "onTap", tap);
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

  const declare = (spec: ControlSpec): void => {
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
    controlValues.set(name, clean);
    if (final) {
      try {
        env.observeControl?.({ name, kind: spec.kind, value: clean, cycle: cycle() });
      } catch { /* an observer never stops the control */ }
    }
  };

  const renderControls = (): void => {
    try {
      env.renderControls?.([...controlSpecs.values()], controlValues, setControl);
    } catch (error) {
      env.reportError("controls", error);
    }
  };

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
  };

  return {
    globals,
    begin() {
      pending = new Set();
      pendingControls = new Map();
      return ++generation;
    },
    commit(token) {
      if (!pending || (token !== undefined && token !== generation)) return;
      active = pending;
      pending = null;
      if (pendingControls) controlSpecs = pendingControls;
      pendingControls = null;
      renderControls();
      // The previous piece's sentence does not belong to this one.
      env.cancelSpeech?.();
      sync();
    },
    rollback(token) {
      if (token !== undefined && token !== generation) return;
      pending = null;
      pendingControls = null;
      sync();
    },
    stop() {
      disposed = true;
      active = new Set();
      pending = null;
      pendingControls = null;
      controlSpecs = new Map();
      renderControls();
      env.cancelSpeech?.();
      sync();
    },
    size: () => active.size,
    controls: () =>
      [...controlSpecs.values()].map((spec) => ({ spec, value: controlValues.get(spec.name) ?? spec.init })),
  };
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
  observeTap?(tap: { x: number; y: number; cycle: number }): void;
  observeControl?(change: { name: string; kind: ControlKind; value: ControlValue; cycle: number }): void;
  /** Where the control strip goes (default: tapArea). */
  controlsHost?: HTMLElement;
}

/** The browser env plus what only a page needs: waiting for say() clips. */
export interface BrowserStage {
  env: StageEnv;
  speech: ReturnType<typeof guardBrowserSpeech>;
  /**
   * Resolves when every say() clip requested so far has loaded or failed, or
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
    signal: (read) => (typeof w.signal === "function" ? w.signal(() => read()) : undefined),
    renderControls: (specs, values, input) =>
      renderControlStrip(options.controlsHost ?? options.tapArea, specs, values, input),
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
  };
  const speechReady = async (timeoutMs: number) => {
    const loading = [...clips.values()].filter((c) => c.state === "loading").map((c) => c.done);
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
