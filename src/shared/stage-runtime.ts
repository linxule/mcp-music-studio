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
}

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
    duration: finite(hap?.duration) ?? finite(hap?.whole?.end) ?? 0,
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
  };
  /** An evaluation is starting: collect its registrations separately. */
  begin(): void;
  /** It succeeded: its registrations replace the previous evaluation's. */
  commit(): void;
  /** It failed (or was superseded): drop its registrations, keep the old ones. */
  rollback(): void;
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

  const cycle = (): number => {
    const c = env.audibleCycle();
    if (c !== null && Number.isFinite(c)) lastCycle = Math.max(0, c);
    return lastCycle;
  };

  const call = (reg: Registration, api: string, arg: unknown): void => {
    try {
      (reg.fn as (a: unknown) => void)(arg);
    } catch (error) {
      if (!reg.failed) {
        reg.failed = true;
        env.reportError(api, error);
      }
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
  };

  return {
    globals,
    begin() {
      pending = new Set();
    },
    commit() {
      if (!pending) return;
      active = pending;
      pending = null;
      // The previous piece's sentence does not belong to this one.
      env.cancelSpeech?.();
      sync();
    },
    rollback() {
      pending = null;
      sync();
    },
    stop() {
      disposed = true;
      active = new Set();
      pending = null;
      env.cancelSpeech?.();
      sync();
    },
    size: () => active.size,
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

/** Taps on these are the UI's, not the piece's. Blank editor space still counts. */
export const TAP_EXCLUDE =
  "button, input, select, textarea, a, label, summary, .cm-line, .cm-gutters, .cm-panels, .cm-tooltip, [role=button]";

export interface BrowserStageOptions {
  /** The running StrudelMirror's scheduler (Cyclist or NeoCyclist), if any. */
  getScheduler(): any;
  isPlaying(): boolean;
  /** Where taps count: the widget's stage section. */
  tapArea: HTMLElement;
  reportError(api: string, error: unknown): void;
  /** Where say() clips are rendered. */
  ttsOrigin: string;
}

/**
 * The StageEnv for a real page. `window` is only touched when this is called,
 * so importing the module stays side-effect free.
 */
export function createBrowserStageEnv(options: BrowserStageOptions): {
  env: StageEnv;
  speech: ReturnType<typeof guardBrowserSpeech>;
} {
  const w = globalThis as any;
  const speech = guardBrowserSpeech(w.speechSynthesis, w.SpeechSynthesisUtterance);
  const prefetched = new Set<string>();
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
      const area = options.tapArea;
      const handler = (event: PointerEvent) => {
        if (event.isPrimary === false) return;
        const target = event.target as Element | null;
        if (target?.closest?.(TAP_EXCLUDE)) return;
        const rect = area.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const x = (event.clientX - rect.left) / rect.width;
        const y = (event.clientY - rect.top) / rect.height;
        if (x < 0 || x > 1 || y < 0 || y > 1) return;
        deliver(x, y);
      };
      area.addEventListener("pointerdown", handler);
      return () => area.removeEventListener("pointerdown", handler);
    },
    toPattern: (value) => (typeof w.reify === "function" ? w.reify(value) : undefined),
    reportError: options.reportError,
    ttsOrigin: options.ttsOrigin,
    registerSample(name, url) {
      // Strudel's samples() registers an object map synchronously (its first
      // await comes after), so the name resolves on the very next trigger.
      if (typeof w.samples !== "function") throw new Error("say(): samples() is not loaded yet");
      void w.samples({ [name]: [url] });
    },
    sound(name) {
      if (typeof w.s !== "function") throw new Error("say(): s() is not loaded yet");
      return w.s(name);
    },
    prefetch(url) {
      if (prefetched.has(url) || typeof w.fetch !== "function") return;
      prefetched.add(url);
      // Warms the HTTP cache (the clip is served immutable), so superdough's own
      // fetch on the first trigger is local. Failures surface there, as a
      // missing sound — not here.
      void w.fetch(url, { mode: "cors" }).catch(() => prefetched.delete(url));
    },
    cancelSpeech: () => speech.cancel(),
  };
  return { env, speech };
}
