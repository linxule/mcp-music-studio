/**
 * @file Sheet Music App — renders ABC notation with abcjs, multi-instrument audio,
 *       style presets, note highlighting, and playback controls.
 */
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import ABCJS from "abcjs";
import type { NoteTimingEvent, CursorControl, SynthOptions } from "abcjs";
import "abcjs/abcjs-audio.css";
import "./global.css";
import "./mcp-app.css";
import {
  DEFAULT_INSTRUMENT,
  DEFAULT_SOUNDFONT,
  INSTRUMENTS,
  SOUNDFONTS,
  STYLE_PRESETS,
  buildSynthOptions,
  isStyleName,
  prepareToolInput,
  type SoundFontName,
} from "./music-logic";
import {
  deriveEffectiveAbc,
  findLeadingProgram,
  instrumentForProgram,
} from "./abc-program";
import {
  forgetFailedSounds,
  resetSoundsCache,
  soundsCacheLooksLive,
} from "./abcjs-sound-cache";
import { transposeAbcDetailed } from "./abc-transpose";
import {
  cleanAbcWarnings,
  editContextText,
  hasFatalAbcWarning,
  staleControlAction,
} from "./abc-edit";
import { resumeAudioContext } from "./audio-unlock";
import { audioBufferToWavBase64 } from "./wav-encoder";
import { bytesToBase64, sanitizeFileStem } from "./bytes-to-base64";
import {
  SHEET_INLINE_CAP,
  applyFrameSize,
  applySafeAreaInsets,
  resolveFrameSize,
  screenAvailHeight,
} from "./frame-size";
import { USER_SCROLL_GRACE_MS, followScrollTarget } from "./sheet-follow";
import { OVERHANG_TEXT_SELECTOR, paddingRightToFit } from "./score-fit";
import {
  TransportQueue,
  carryWarp,
  keepLoopLitThroughWarp,
  noteGestureStart,
  pauseTransport,
  queueWarp,
  readTransport,
  reprime,
  restoreLoop,
  trackTransport,
  type TransportEvent,
  type TransportState,
} from "./synth-transport";
import {
  alignTimerWithSwing,
  type FlatEvent,
  type NoteMapNote,
  type TimingEventLike,
} from "./swing-timing";
import { VERSION } from "./version";

// =============================================================================
// State
// =============================================================================

interface AppState {
  visualObj: ABCJS.TuneObject[] | null;
  synthControl: ABCJS.SynthObjectController | null;
  currentInstrument: string;
  /**
   * The user has picked from the Instrument menu since the last tool call, so
   * that choice replaces the score's own first-voice `%%MIDI program` (#25).
   */
  instrumentOverride: boolean;
  currentStyle: string;
  currentSoundFont: SoundFontName;
  currentAbc: string | null;
  /** Explicit `title` argument from the tool call; outranks the ABC's T:. */
  toolTitle: string | null;
  /** Synth options carried in from the tool call (swing, drumIntro, …). */
  toolSynthOpts: Record<string, unknown>;
  highlightedEls: HTMLElement[];
}

const state: AppState = {
  visualObj: null,
  synthControl: null,
  currentInstrument: DEFAULT_INSTRUMENT,
  instrumentOverride: false,
  currentStyle: "",
  currentSoundFont: DEFAULT_SOUNDFONT,
  currentAbc: null,
  toolTitle: null,
  toolSynthOpts: {},
  highlightedEls: [],
};

// =============================================================================
// Render generations (why every async step re-checks a counter)
// =============================================================================
//
// Three things can start work that finishes much later: the 150 ms partial
// -render debounce, `renderAbc()` (parse → renderAbc → setTune → play, all
// awaited), and the editor's debounced re-render. Nothing used to stop an
// older one from landing on top of a newer one, which produced two real bugs:
//
//  * a partial score, still queued when the COMPLETE tool input arrived,
//    replaced the finished score and reset the status to "Composing…";
//  * after `ontoolcancelled` / `onteardown`, an in-flight render could still
//    finish, rebuild the transport and (via autoplay) start audio in a widget
//    the host had already discarded.
//
// `renderGeneration` is bumped by every event that invalidates outstanding
// work — new tool input, cancel, teardown. Anything asynchronous captures it
// up front and bails the moment it no longer matches, so the LAST intent wins
// and a discarded widget stays discarded. `disposed` is the terminal case:
// once the host tears us down, nothing may resume.
let renderGeneration = 0;
let disposed = false;

/** Invalidate every outstanding render/load/play continuation. */
function newGeneration(): number {
  return ++renderGeneration;
}

/** Has this continuation been superseded (or the widget torn down)? */
const isStale = (generation: number): boolean =>
  disposed || generation !== renderGeneration;

/**
 * Fully shut down one SynthController.
 *
 * `pause()` is not enough for a controller we are abandoning: it leaves the
 * TimingCallbacks timer and the primed midiBuffer alive, so a late beat
 * callback can still fire `cursorControl.onEvent` and paint `.note-playing`
 * onto elements of a score that no longer exists. `destroy()` (abcjs
 * synth-controller.js) resets and stops the timer, stops the buffer, and
 * resets the transport.
 */
function destroySynthControl(control: ABCJS.SynthObjectController): void {
  try {
    control.pause();
  } catch {
    // Never loaded — nothing to pause.
  }
  try {
    (control as unknown as { destroy?: () => void }).destroy?.();
  } catch {
    // destroy() is best-effort; abcjs guards most of it but not all.
  }
}

/**
 * Generation that last took ownership of `state.synthControl`.
 *
 * The controller outlives the render that built it — an edit REUSES it rather
 * than rebuilding the transport — so "is this still the current controller?"
 * is not enough to decide whether a superseded continuation may destroy it.
 * See `staleControlAction()` in abc-edit.ts.
 */
let synthControlOwner = 0;

/** Retire the widget's current controller, if any. */
function retireSynthControl(): void {
  if (state.synthControl) destroySynthControl(state.synthControl);
  state.synthControl = null;
  synthControlOwner = 0;
  clearHighlights();
}

/** Take ownership of the live controller for `generation`. */
function ownSynthControl(
  control: ABCJS.SynthObjectController,
  generation: number,
): void {
  state.synthControl = control;
  synthControlOwner = generation;
}

/**
 * Clean up after a continuation that has been superseded — WITHOUT touching a
 * controller a newer generation has taken over and is still playing.
 */
function releaseStaleControl(
  control: ABCJS.SynthObjectController,
  generation: number,
): void {
  const action = staleControlAction({
    isCurrent: state.synthControl === control,
    owner: synthControlOwner,
    generation,
  });
  if (action === "retire") {
    // Ours, and our generation is gone. Only a teardown ends the widget,
    // though: after a cancel the score and abcjs's ▶ stay on screen, wired to
    // this controller, and retiring it left a dead transport (measured in
    // WebKit: a tap released the parked autoplay, which retired it; ▶ then did
    // nothing and the clock sat at 0:00). Stop what it started, keep it.
    if (disposed) retireSynthControl();
    else silence(control);
  } else if (action === "destroy") {
    destroySynthControl(control);
  } else if (ownerCancelled(control)) {
    // A newer generation took the controller over (an edit) and was itself
    // cancelled while it waited its turn: nobody live wants this music, which
    // the autoplay started anyway (Codex review).
    silence(control);
  }
}

/**
 * After a cancel nobody live owns the controller: the cancel keeps it (the
 * score and ▶ stay usable) but wants it quiet. A ▶ press takes it over again
 * (see the audio-controls click listener).
 */
function ownerCancelled(control: ABCJS.SynthObjectController): boolean {
  return !disposed && state.synthControl === control && isStale(synthControlOwner);
}

/** Stop what a superseded continuation started, keeping the controller. */
function silence(control: ABCJS.SynthObjectController): void {
  pauseTransport(control);
  clearHighlights();
}

/**
 * Whether any audio has actually been primed in this widget.
 *
 * Drives the sound-bank cache guard: before the first prime an empty sample
 * cache is meaningless, after it an empty one is proof we lost the singleton.
 */
let hasPrimedAudio = false;

/**
 * Every synth option the widget currently applies — the single place that
 * decides what `setTune()` and `getMidiFile()` both see, so the exported MIDI
 * matches what is playing. The assembly itself lives in `music-logic` as the
 * pure `buildSynthOptions()`, which is what `tests/synth-options.test.ts`
 * exercises (this wrapper needs a DOM, that function doesn't).
 */
function currentSynthOptions(): Record<string, unknown> {
  const options = buildSynthOptions({
    instrument: state.currentInstrument,
    soundFont: state.currentSoundFont,
    toolSynthOptions: state.toolSynthOpts,
  });
  // abcjs offsets its note timer by a count-in ONLY when the cursor control
  // says so (synth-controller.js hands `cursorControl.extraMeasuresAtBeginning`
  // to TimingCallbacks; `drumIntro` itself never reaches the timer). Without
  // this, a `drumIntro: 2` tune lit — and scrolled to — its first notes during
  // the count-in, stayed two bars ahead of the audio, and ended the transport
  // two bars before the sound did. Every setTune() reads this first.
  cursorControl.extraMeasuresAtBeginning =
    typeof options.drumIntro === "number" ? options.drumIntro : 0;
  // Swing moves only the audio. Collect abcjs's swung note map so onReady can
  // move the highlight timer to match (#34, followSwing below).
  if (typeof options.swing === "number") {
    options.sequenceCallback = captureSwungNoteMap;
    options.callbackContext = { swung: null } satisfies SwingCapture;
  }
  return options;
}

/**
 * Where `sequenceCallback` leaves abcjs's note map AFTER `addSwing()`. Each
 * setTune() gets a fresh one. A warp change re-primes with the same options,
 * and each prime overwrites it before `go()` builds the timer and calls
 * `onReady`.
 */
interface SwingCapture {
  swung: NoteMapNote[][] | null;
}

function captureSwungNoteMap(tracks: NoteMapNote[][], context: SwingCapture): NoteMapNote[][] {
  context.swung = tracks;
  return tracks;
}

/**
 * Move the note highlight onto abcjs's swung timeline (#34; the matching is in
 * src/swing-timing.ts). `go()` calls `onReady` after every prime: the first ▶,
 * `setTune(…, true)`, and a warp change. Each time the TimingCallbacks is
 * freshly built on the straight grid, so the shift never compounds.
 */
function followSwing(controller: unknown): void {
  const raw = controller as {
    timer?: { noteTimings?: TimingEventLike[] } | null;
    midiBuffer?: {
      flattened?: { tracks?: FlatEvent[][] };
      callbackContext?: SwingCapture;
      millisecondsPerMeasure?: number;
      meterSize?: number;
    } | null;
  } | null;
  const buffer = raw?.midiBuffer;
  const capture = buffer?.callbackContext;
  const timings = raw?.timer?.noteTimings;
  const flattened = buffer?.flattened?.tracks;
  if (!buffer || !capture?.swung || !timings || !flattened) return;
  const swungTracks = capture.swung;
  capture.swung = null; // consumed: one prime, one shift
  alignTimerWithSwing({
    timings,
    flattenedTracks: flattened,
    swungTracks,
    millisecondsPerMeasure: buffer.millisecondsPerMeasure ?? 0,
    meterSize: buffer.meterSize ?? 0,
  });
}

/**
 * The ABC abcjs actually renders and plays: `state.currentAbc` (never
 * rewritten) with the style preset and, after a pick from the Instrument
 * menu, the first voice's program override. Every render path goes through
 * here: the first render, edits, Style changes, the streaming preview, and
 * the instrument re-engrave.
 */
function effectiveAbc(raw: string): string {
  return deriveEffectiveAbc(raw, {
    style: state.currentStyle,
    programOverride: state.instrumentOverride
      ? (INSTRUMENTS[state.currentInstrument] ?? null)
      : null,
  });
}

// =============================================================================
// DOM References
// =============================================================================

const statusEl = document.getElementById("status")!;
const pieceTitleEl = document.getElementById("piece-title")!;
const sheetMusicEl = document.getElementById("sheet-music")!;
/** The score's scroll container — the only thing the note-follow scrolls. */
const sheetSectionEl = document.querySelector(".sheet-section") as HTMLElement;
const audioControlsEl = document.getElementById("audio-controls")!;
const instrumentSelectorEl = document.getElementById("instrument-selector")!;
const styleSelectorEl = document.getElementById("style-selector")!;
const soundFontSelectorEl = document.getElementById("soundfont-selector")!;
const toolbarEl = document.getElementById("toolbar")!;
const editorPaneEl = document.getElementById("editor-pane")!;
const editorEl = document.getElementById("abc-editor") as HTMLTextAreaElement;
const editorMessageEl = document.getElementById("editor-message")!;

// =============================================================================
// Audio Session
// =============================================================================

if ("audioSession" in navigator) {
  (navigator.audioSession as { type: string }).type = "playback";
}

// =============================================================================
// Cursor Control (note highlighting during playback)
// =============================================================================

/**
 * Drop every note highlight. Also the mandatory first step of any re-render:
 * the highlighted nodes belong to the OLD SVG, and holding references to
 * detached elements would leak and mis-clear later.
 */
function clearHighlights(): void {
  state.highlightedEls.forEach((el) => el.classList.remove("note-playing"));
  state.highlightedEls = [];
}

/**
 * `extraMeasuresAtBeginning` is read by abcjs at runtime (synth-controller.js)
 * but missing from its published CursorControl type.
 */
const cursorControl: CursorControl & { extraMeasuresAtBeginning?: number } = {
  onEvent(ev: NoteTimingEvent) {
    // A timer still primed for the score an edit just replaced (its re-prime
    // is queued behind a load): its notes are no longer on the page.
    const first = ev.elements?.[0]?.[0] as Element | undefined;
    if (first && !first.isConnected) return;
    clearHighlights();

    for (const group of ev.elements ?? []) {
      for (const el of group) {
        el.classList.add("note-playing");
        state.highlightedEls.push(el);
      }
    }

    followPlayback(ev);
  },

  onFinished() {
    clearHighlights();
    resetFollow();
  },

  // abcjs passes the controller (synth-controller.js `go()`), although its
  // published type declares no parameter.
  onReady(controller?: unknown) {
    followSwing(controller);
  },
};

// =============================================================================
// Score follow — keeps the playing system in view
// =============================================================================
//
// The policy (which system, when to move, where to) is `followScrollTarget()`
// in src/sheet-follow.ts, which also records what the old
// `scrollIntoView({ block: "nearest" })` on the first notehead got wrong. This
// half measures, and keeps out of the reader's way: any hand scroll of the
// score suspends the follow for USER_SCROLL_GRACE_MS.

const reducedMotionQuery =
  typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;

/** Line (system) index of the last event, so a new line can be told apart. */
let followLine: number | null = null;
let lastUserScrollAt = Number.NEGATIVE_INFINITY;

const SCROLL_KEYS = new Set([
  "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ",
]);

function noteUserScroll(): void {
  lastUserScrollAt = performance.now();
}

sheetSectionEl.addEventListener("wheel", noteUserScroll, { passive: true });
sheetSectionEl.addEventListener("touchmove", noteUserScroll, { passive: true });
sheetSectionEl.addEventListener("keydown", (event) => {
  if (SCROLL_KEYS.has(event.key)) noteUserScroll();
});
sheetSectionEl.addEventListener("pointerdown", (event) => {
  // A press on the scroller itself rather than the score inside it is the
  // scrollbar being dragged.
  if (event.target === sheetSectionEl) noteUserScroll();
});

function userIsScrolling(): boolean {
  return performance.now() - lastUserScrollAt < USER_SCROLL_GRACE_MS;
}

function resetFollow(): void {
  followLine = null;
}

/**
 * The playing system's extent, in the scroller's content coordinates.
 *
 * abcjs puts the system's `top` and `height` on every timing event — first
 * staff to last, so both hands of a piano part — in SVG user units. With
 * `responsive: "resize"` the SVG's viewBox is `0 0 w h` scaled to the
 * container's width, so one factor converts them.
 */
function playingSystemBox(ev: NoteTimingEvent): { top: number; bottom: number } | null {
  const view = sheetSectionEl.getBoundingClientRect();
  const origin = view.top + sheetSectionEl.clientTop - sheetSectionEl.scrollTop;
  const svg = sheetMusicEl.querySelector("svg");
  const viewBoxWidth = svg?.viewBox?.baseVal?.width;
  if (svg && viewBoxWidth && typeof ev.top === "number" && typeof ev.height === "number") {
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / viewBoxWidth;
    const top = rect.top - origin + ev.top * scale;
    return { top, bottom: top + ev.height * scale };
  }
  // No system geometry on the event: fall back to what is lit up.
  if (state.highlightedEls.length === 0) return null;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const el of state.highlightedEls) {
    const rect = el.getBoundingClientRect();
    top = Math.min(top, rect.top);
    bottom = Math.max(bottom, rect.bottom);
  }
  return { top: top - origin, bottom: bottom - origin };
}

function followPlayback(ev: NoteTimingEvent): void {
  const box = playingSystemBox(ev);
  if (!box) return;
  const line = typeof ev.line === "number" ? ev.line : Math.round(box.top);
  const lineChanged = line !== followLine;
  followLine = line;
  if (userIsScrolling()) return;
  const target = followScrollTarget({
    systemTop: box.top,
    systemBottom: box.bottom,
    scrollTop: sheetSectionEl.scrollTop,
    viewHeight: sheetSectionEl.clientHeight,
    scrollHeight: sheetSectionEl.scrollHeight,
    lineChanged,
  });
  if (target === null) return;
  sheetSectionEl.scrollTo({
    top: target,
    behavior: reducedMotionQuery?.matches ? "auto" : "smooth",
  });
}

const instrumentSelect = document.createElement("select");
instrumentSelect.id = "instrument-select";
instrumentSelect.className = "control-select";

for (const name of Object.keys(INSTRUMENTS)) {
  const option = document.createElement("option");
  option.value = name;
  option.textContent = name;
  if (name === state.currentInstrument) option.selected = true;
  instrumentSelect.appendChild(option);
}

/** Stands in for a score program with no GM name (e.g. 128); never pickable. */
const SCORE_PROGRAM_VALUE = "__score__";
const scoreProgramOption = document.createElement("option");
scoreProgramOption.value = SCORE_PROGRAM_VALUE;
scoreProgramOption.disabled = true;
scoreProgramOption.hidden = true;
instrumentSelect.prepend(scoreProgramOption);

/**
 * Show what the first voice will actually play (#25).
 *
 * The menu reaches abcjs only as the `program` synth option, which is the
 * STARTING instrument, so a score that sets its own first-voice
 * `%%MIDI program` outranks it. Until the user picks, the menu shows the
 * score's instrument and says so. After a pick, `effectiveAbc()` writes the
 * pick over that directive and the menu shows the pick.
 */
function syncInstrumentSelect(): void {
  const leading = state.currentAbc ? findLeadingProgram(state.currentAbc) : null;
  scoreProgramOption.hidden = true;
  let title = "";
  if (!leading || state.instrumentOverride) {
    instrumentSelect.value = state.currentInstrument;
    if (leading) {
      title = `Your choice replaces the score's ${leading.directive} for the first voice.`;
    }
  } else {
    const name = instrumentForProgram(leading.program);
    if (name) {
      instrumentSelect.value = name;
    } else {
      scoreProgramOption.textContent = `Program ${leading.program} (from the score)`;
      scoreProgramOption.hidden = false;
      instrumentSelect.value = SCORE_PROGRAM_VALUE;
    }
    title = `The score chooses this instrument (${leading.directive}). Pick another to override it for the first voice.`;
  }
  instrumentSelect.title = title;
  instrumentLabel.title = title;
}

instrumentSelect.addEventListener("change", () => {
  if (!Object.hasOwn(INSTRUMENTS, instrumentSelect.value)) return;
  state.currentInstrument = instrumentSelect.value;
  state.instrumentOverride = true;
  syncInstrumentSelect();
  if (state.visualObj && state.synthControl) {
    // When the score names its own program, the pick can only reach the
    // audio through the notation, so re-engrave the effective ABC first.
    // Otherwise the `program` synth option is enough, and nothing re-renders.
    const generation = renderGeneration;
    const scoreSetsProgram =
      state.currentAbc !== null && findLeadingProgram(state.currentAbc) !== null;
    applySettings(
      scoreSetsProgram
        ? () => {
            if (!isStale(generation)) reengraveForInstrument();
          }
        : undefined,
    );
  }
});

/**
 * Re-engrave the current score from its effective ABC, so the next
 * `setTune()` carries the overridden program.
 *
 * `setTune()` takes ONE tune object for both the audio and the highlight timer,
 * and the timer needs the engraved SVG, so a parse-only tune won't do. A
 * `%%MIDI` line draws nothing, so the notation looks the same and the scroll
 * position is kept. It runs synchronously just before `setTune()` pauses the
 * transport (both in one applySettings link), so no beat callback can land
 * on the replaced SVG.
 */
function reengraveForInstrument(): void {
  if (!state.currentAbc || !state.visualObj) return;
  const scrollTop = sheetSectionEl.scrollTop;
  clearHighlights();
  resetFollow();
  const visualObj = engraveScore(effectiveAbc(state.currentAbc));
  if (!visualObj || (visualObj as unknown as unknown[]).length === 0) return;
  state.visualObj = visualObj;
  sheetSectionEl.scrollTop = scrollTop;
}

/**
 * Re-prime the live synth with the current instrument / bank / synth options.
 *
 * `userAction` MUST be true. Walked through abcjs's own
 * `src/synth/synth-controller.js`:
 *
 *  * `setTune(visualObj, userAction, audioParams)` pauses, rewinds, resets the
 *    transport, sets `isStarted = false` — and then calls `go()` only when
 *    `userAction` is truthy. With `false` it returns
 *    `{status: "no-audio-context"}` and touches nothing else.
 *  * `isLoaded` is set in `go()` and **never cleared** — not by `setTune()`,
 *    not by `destroy()`. So after one play, `setTune(..., false, ...)` leaves
 *    `isLoaded === true`, `runWhenReady()` skips `go()`, and the next ▶ plays
 *    the PREVIOUS instrument's already-primed buffer while the UI claims the
 *    new one.
 *  * `go()` does **not** start playback. It resumes the AudioContext, calls
 *    `midiBuffer.init()` + `.prime()`, builds the TimingCallbacks and sets
 *    `isLoaded`. Only `_play()` flips `isStarted` and calls
 *    `midiBuffer.start()`. So passing `true` re-primes without ever making a
 *    paused widget suddenly play — which is exactly what we want here, and why
 *    this doesn't need to be gated on `isStarted`.
 *
 * The audio context resume inside `go()` is why `true` is honest rather than a
 * fib: every caller of this function is a real user gesture (a selector change
 * or ⌘↵ in the editor).
 */
/**
 * Serialises everything that re-primes the live controller: settings changes,
 * edits and the % field. `setTune()` pauses, rewinds and re-primes, so two of
 * them overlapping (a user flicking through the instrument selector, where
 * every change fires one) interleave a rewind with another prime and can
 * leave the primed buffer disagreeing with the selector. Each step first waits
 * out whatever the controller is already loading (#33): `setTune(…, true)`
 * starts a load at once, and one landing on top of the autoplay's put two
 * init + prime runs on the same buffer.
 */
const transportQueue = new TransportQueue(() => state.synthControl, () => !disposed);

function applySettings(prepare?: () => void): Promise<void> {
  wakeAudio();
  // Each step re-reads the CURRENT selector values, so a burst collapses to
  // "prime whatever was chosen last". `prepare` runs right before the re-prime
  // reads `state.visualObj` (the instrument re-engrave, #25).
  return transportQueue.run(() => {
    prepare?.();
    return applySettingsNow();
  });
}

/** abcjs's AudioContext, created on first call; null without Web Audio. */
function audioContext(): AudioContext | null {
  try {
    return ABCJS.synth.activeAudioContext() ?? null;
  } catch {
    return null;
  }
}

/** A gesture's resume() is never waited on longer than this. */
const AUDIO_RESUME_TIMEOUT_MS = 1500;
/**
 * How long an autoplay's context gets to reach "running" before the status
 * says it is blocked. A blocked resume() never settles (src/audio-unlock.ts).
 */
const AUDIO_SETTLE_MS = 300;

/**
 * Resume the AudioContext from a user gesture. A load started while autoplay
 * was blocked is parked on `AudioContext.resume()`, which stays pending until
 * a resume made during a user gesture. Settings changes wait for that load, so
 * their gesture has to be the one that releases it.
 */
function wakeAudio(): void {
  // Teardown is terminal: a gesture must not release a load parked on a
  // retired controller (Kimi review).
  if (disposed) return;
  void resumeAudioContext(audioContext(), AUDIO_RESUME_TIMEOUT_MS);
}

// Any gesture in the widget releases a parked autoplay, not only ▶. Capture
// phase, so no control's own handler can swallow it; on touch only
// pointerup/touchend carry user activation.
for (const type of ["pointerdown", "keydown", "pointerup", "touchend"]) {
  document.addEventListener(type, wakeAudio, { capture: true, passive: true });
}
// So a ▶ whose own press released the parked autoplay doesn't toggle it off.
for (const type of ["pointerdown", "keydown"]) {
  document.addEventListener(type, () => noteGestureStart(), { capture: true, passive: true });
}

// The listener's ▶ is the newest intent: it takes the controller over, so a
// continuation a cancel superseded no longer stops the music it asked for.
// Capture phase: before abcjs's own click handler calls play().
audioControlsEl.addEventListener(
  "click",
  (event) => {
    const target = event.target as Element | null;
    if (!target?.closest(".abcjs-midi-start") || disposed || !state.synthControl) return;
    if (isStale(synthControlOwner)) ownSynthControl(state.synthControl, renderGeneration);
  },
  { capture: true },
);

async function applySettingsNow(): Promise<void> {
  const control = state.synthControl;
  const tune = state.visualObj?.[0];
  if (!control || !tune) return;
  // An instrument or sound change made mid-tune used to STOP the music:
  // setTune() pauses and rewinds, and nothing started it again. Like an edit
  // (applyEditorAbc), it now carries on from the top — and keeps Loop.
  //
  // A cancel keeps this controller but bumps the generation, and an edit
  // takes it over under a new one. Neither may have the music restarted
  // behind its back, so this re-checks the generation after every await,
  // not just "is it still the widget's controller?".
  const generation = renderGeneration;
  const owner = synthControlOwner;
  try {
    await reprime(control, {
      prime: async () => {
        await control.setTune(tune, true, currentSynthOptions() as SynthOptions);
        hasPrimedAudio = true;
      },
      stillWanted: () => state.synthControl === control && !isStale(generation),
      onSuperseded: () => {
        // A cancel landed while play() was starting: stop what we started.
        // An edit that took the controller over decides for itself.
        if (state.synthControl === control && synthControlOwner === owner) {
          pauseTransport(control);
        }
      },
    });
  } catch (error) {
    console.error("Failed to apply settings:", error);
  }
}

// Build instrument selector
const instrumentLabel = document.createElement("label");
instrumentLabel.className = "control-label";
instrumentLabel.htmlFor = "instrument-select";
instrumentLabel.textContent = "Instrument";
instrumentSelectorEl.appendChild(instrumentLabel);
instrumentSelectorEl.appendChild(instrumentSelect);

// =============================================================================
// Style Selector
// =============================================================================

const styleSelect = document.createElement("select");
styleSelect.id = "style-select";
styleSelect.className = "control-select";

// "No preset accompaniment", not "melody only": abcjs still synthesises bass
// and chords from any chord symbols ("C", "Am7") in the ABC, because the
// default gchord stays in force and we deliberately do NOT set `chordsOff`.
// Measured on a two-bar tune with chord symbols and no style: 32 note events,
// only 16 of which are the melody. Setting `chordsOff: true` was the other
// option and was rejected — the chord symbols are the composer's, the style
// preset is the widget's, and this selector only chooses among the widget's.
// Someone who wants a bare melody removes the chord symbols.
const noneOption = document.createElement("option");
noneOption.value = "";
noneOption.textContent = "No preset accompaniment";
noneOption.title =
  "Turns off the style preset. Chord symbols in the ABC still play.";
styleSelect.appendChild(noneOption);

for (const name of Object.keys(STYLE_PRESETS)) {
  const option = document.createElement("option");
  option.value = name;
  option.textContent = name.charAt(0).toUpperCase() + name.slice(1);
  styleSelect.appendChild(option);
}

styleSelect.addEventListener("change", () => {
  state.currentStyle = styleSelect.value;
  if (!state.currentAbc) return;
  // The preset rewrites the ABC, so a Style change re-renders and builds a new
  // controller (tempo 100%, Loop off). Carry the old one's tempo and Loop
  // across, and play only if it was playing, or still loading its autoplay
  // (#26). After a cancel it reads as stopped (pauseTransport) and its
  // autoplay as stale, so a Style change never restarts cancelled music.
  const control = state.synthControl;
  const carry = control ? readTransport(control) : null;
  const autoplay = Boolean(carry?.wasPlaying) || autoplayLoading(control);
  void renderAbc(state.currentAbc, undefined, { autoplay, carry });
});

const styleLabel = document.createElement("label");
styleLabel.className = "control-label";
styleLabel.htmlFor = "style-select";
styleLabel.textContent = "Style";
styleSelectorEl.appendChild(styleLabel);
styleSelectorEl.appendChild(styleSelect);

// =============================================================================
// Sound Font Selector
// =============================================================================
//
// Switches the sample bank abcjs streams from. Only re-primes the synth — no
// re-render, since the notation is unchanged.
//
// The catch, and why `resetSoundsCache()` is here: abcjs caches decoded samples
// in a module singleton keyed `soundsCache[instrument][note]`, with the bank
// URL absent from the key (src/synth/load-note.js). Re-priming alone therefore
// replays the FIRST bank's samples forever — the previous comment here claimed
// "every sample is refetched", which was measurably false (see
// src/abcjs-sound-cache.ts and tests/soundfont-cache.test.ts: two banks, one
// request). Emptying the cache first is what makes that comment true.

const soundFontSelect = document.createElement("select");
soundFontSelect.id = "soundfont-select";
soundFontSelect.className = "control-select";

for (const [name, font] of Object.entries(SOUNDFONTS)) {
  const option = document.createElement("option");
  option.value = name;
  option.textContent = font.label;
  if (name === state.currentSoundFont) option.selected = true;
  soundFontSelect.appendChild(option);
}

/**
 * Disable the Sound selector and say why.
 *
 * Only reached if the deep import into abcjs's sample cache ever stops landing
 * on the live object — the one failure mode that would otherwise turn this
 * control back into a silent lie. Better a disabled control with an
 * explanation than an enabled one that does nothing.
 */
function retireSoundFontSelector(): void {
  soundFontSelect.disabled = true;
  soundFontSelect.title =
    "Re-run the tool to change the sound bank — this widget has already loaded samples.";
  soundFontLabel.title = soundFontSelect.title;
}

const LOADING_SOUNDS = "Loading sounds…";

soundFontSelect.addEventListener("change", () => {
  const previous = state.currentSoundFont;
  state.currentSoundFont = soundFontSelect.value as SoundFontName;
  if (!state.visualObj || !state.synthControl) return;

  // Nothing primed yet => nothing stale to drop, and an empty cache proves
  // nothing about our reference. Once audio HAS been primed, an empty cache
  // means we are not holding abcjs's real singleton and cannot honour the
  // switch — say so instead of pretending.
  if (!soundsCacheLooksLive(hasPrimedAudio)) {
    state.currentSoundFont = previous;
    soundFontSelect.value = previous;
    retireSoundFontSelector();
    setStatus(
      "Sound bank can't be changed in this session — re-run the tool.",
      true,
    );
    return;
  }

  // Drop every cached sample so init()/prime() refetch from the new bank, but
  // only once the wait is over: a load still in flight (an autoplay parked on
  // blocked audio, released by this very gesture) refilled the cache from the
  // OLD bank, and the re-prime then played those samples under the new name.
  setStatus(LOADING_SOUNDS);
  applySettings(resetSoundsCache)
    .then(() => {
      // The re-prime plays on if the tune was playing. Say which, unless
      // something newer has taken the status line.
      const control = state.synthControl;
      if (!control || statusEl.textContent !== LOADING_SOUNDS) return;
      const playing = readTransport(control).wasPlaying;
      setStatus(withTransposeNote(playing ? "Playing..." : "Click ▶ to play"));
    })
    .catch((err) =>
      setStatus(`Sound change failed: ${(err as Error).message}`, true),
    );
});

const soundFontLabel = document.createElement("label");
soundFontLabel.className = "control-label";
soundFontLabel.htmlFor = "soundfont-select";
soundFontLabel.textContent = "Sound";
soundFontSelectorEl.appendChild(soundFontLabel);
soundFontSelectorEl.appendChild(soundFontSelect);

// =============================================================================
// ABC Source Editor
// =============================================================================
//
// The asymmetry this closes: the Strudel widget hands you a live REPL, while
// the ABC widget used to be read-only — changing one note meant a chat
// round-trip. The pane below edits `state.currentAbc`, which is the RAW user
// notation (style presets are layered on at render time by `effectiveAbc()`
// and never written back), so what you see in the box is what the model wrote,
// modulo the tool's `transpose` — which rewrites the notation itself and so is
// genuinely part of the score you are editing.
//
// Behaviour decisions, all deliberate:
//  * Debounced 300 ms on `input`; ⌘/Ctrl+Enter forces a render and plays.
//  * Validation happens BEFORE any DOM mutation, so a half-typed bar never
//    tears down the last good score. Fatal = the server's own rule
//    (`Expected` / `Unknown` / `Error`); anything else renders with a note.
//  * The textarea is never rewritten by a render, so text is never lost.
//  * On a successful edit the tune restarts cleanly at bar 1 — `setTune()`
//    pauses, resets progress and rewinds, and abcjs offers no way to carry a
//    playhead across a re-timed tune. If it was playing, it keeps playing
//    (from the top); if it was paused, it stays paused.
//  * `setTune(..., userAction: true, ...)` on purpose: abcjs never clears its
//    `isLoaded` flag, so with `false` a later ▶ would replay the PREVIOUS
//    tune's audio buffer. `true` re-primes the buffer for the edited tune.

const EDIT_DEBOUNCE_MS = 300;

let editTimer: ReturnType<typeof setTimeout> | null = null;
/** Last text actually pushed through a render — cheap no-op guard. */
let lastEditRendered = "";
/** Last text reported to the model, so one render reports at most once. */
let lastEditReported = "";
/** Whether the host accepts `ui/update-model-context` (set after connect). */
let contextUpdateSupported = false;

const editBtn = document.createElement("button");
editBtn.className = "toolbar-btn toolbar-btn-text";
editBtn.textContent = "Edit";
editBtn.title = "Edit the ABC notation";
editBtn.setAttribute("aria-label", "Edit the ABC notation");
editBtn.setAttribute("aria-pressed", "false");
editBtn.setAttribute("aria-expanded", "false");
editBtn.setAttribute("aria-controls", "editor-pane");
toolbarEl.appendChild(editBtn);

/** Keep the textarea in step with externally supplied ABC (tool input). */
function syncEditor(abc: string): void {
  // Assigning an identical value still collapses the selection in most
  // browsers, so only write when it actually differs.
  if (editorEl.value !== abc) editorEl.value = abc;
}

function setEditorMessage(text: string | null, kind: "error" | "warn"): void {
  if (!text) {
    editorMessageEl.hidden = true;
    editorMessageEl.textContent = "";
    return;
  }
  editorMessageEl.textContent = text;
  editorMessageEl.classList.toggle("warn", kind === "warn");
  editorMessageEl.hidden = false;
}

function setEditorOpen(open: boolean): void {
  editorPaneEl.hidden = !open;
  editBtn.setAttribute("aria-pressed", String(open));
  editBtn.setAttribute("aria-expanded", String(open));
  if (open) {
    // The textarea already tracks tool input; only fill a genuinely empty box.
    if (editorEl.value.length === 0 && state.currentAbc) {
      editorEl.value = state.currentAbc;
    }
    editorEl.focus();
  }
}

editBtn.addEventListener("click", () => {
  setEditorOpen(Boolean(editorPaneEl.hidden));
});

function cancelEditRender(): void {
  if (editTimer) {
    clearTimeout(editTimer);
    editTimer = null;
  }
}

function scheduleEditRender(): void {
  cancelEditRender();
  const generation = renderGeneration;
  editTimer = setTimeout(() => {
    editTimer = null;
    // New tool input or a teardown while the user paused mid-keystroke: the
    // text they typed belongs to a score that is no longer on screen.
    if (isStale(generation)) return;
    void applyEditorAbc(false);
  }, EDIT_DEBOUNCE_MS);
}

/**
 * Set when a `transpose` argument could only be applied to the AUDIO — a
 * keyless tune, or a notation rewrite that failed verification. Shown in the
 * status line and reported to the model, so neither the user nor the agent is
 * told the printed score moved when it did not.
 */
let transposeNote: string | null = null;

function withTransposeNote(text: string): string {
  // A separator, since the status rarely ends in punctuation ("Paused",
  // "Click ▶ to play") and ran straight into "Transposed the AUDIO…".
  return transposeNote ? `${text} · ${transposeNote}` : text;
}

/** Tell the model the printed score was NOT transposed, only the playback. */
function reportTransposeToModel(warning: string | null): void {
  if (!warning || !contextUpdateSupported) return;
  void app
    .updateModelContext({
      content: [{ type: "text", text: `Sheet-music widget: ${warning}` }],
    })
    .catch(() => {
      /* context updates are best-effort */
    });
}

/** Tell the model the score on screen is no longer the one it wrote. */
function reportEditToModel(abc: string, soundsLoaded = true): void {
  if (!contextUpdateSupported || abc === lastEditReported) return;
  lastEditReported = abc;
  void app
    .updateModelContext({
      content: [{ type: "text", text: editContextText(abc, soundsLoaded) }],
    })
    .catch(() => {
      /* context updates are best-effort */
    });
}

/**
 * Render whatever is in the textarea, reusing the live `synthControl` so the
 * transport doesn't flicker and the note-follow cursor keeps working.
 *
 * @param forcePlay - ⌘/Ctrl+Enter: render even if unchanged, then play.
 */
async function applyEditorAbc(forcePlay: boolean): Promise<void> {
  const abc = editorEl.value;

  if (abc.trim().length === 0) {
    setEditorMessage("Nothing to render — the editor is empty.", "error");
    return;
  }
  if (!forcePlay && abc === lastEditRendered) return;

  const effective = effectiveAbc(abc);

  // Validate first: nothing on screen is touched until we know it parses.
  let messages: string[] = [];
  try {
    messages = cleanAbcWarnings(ABCJS.parseOnly(effective)[0]?.warnings);
  } catch (err) {
    messages = [(err as Error).message];
  }
  if (hasFatalAbcWarning(messages)) {
    setEditorMessage(messages.join("\n"), "error");
    setStatus("ABC has errors — showing the last good score", true);
    return;
  }

  // No live synth yet (nothing rendered, or the first render failed):
  // fall back to the full build-from-scratch path.
  if (!state.synthControl) {
    lastEditRendered = abc;
    setEditorMessage(messages.length > 0 ? messages.join("\n") : null, "warn");
    // The tool call's first playable render, so it autoplays as that would have.
    await renderAbc(abc, undefined, { autoplay: true });
    reportEditToModel(abc);
    return;
  }

  // The user's edit is the newest intent, so it supersedes any partial render
  // still queued from a stream. Everything after an await re-checks this.
  const generation = newGeneration();
  const synthControl = state.synthControl;
  // The edit is now the controller's owner: a still-running continuation from
  // the render that CREATED it must not destroy the transport we are about to
  // re-prime and keep playing.
  ownSynthControl(synthControl, generation);
  cancelPartialRender();

  // The score is drawn now; only the audio waits its turn. setTune(…, true)
  // starts a load at once, so the re-prime queues behind any load or change
  // in flight, like a settings change. Queueing the engrave too (Kimi review)
  // left the OLD score up for the whole load, up to 15 s.
  let visualObj: ABCJS.TuneObject[];
  try {
    visualObj = engraveEdit(abc, effective, messages);
  } catch (error) {
    console.error("Edit render error:", error);
    setEditorMessage(`Edit not applied: ${(error as Error).message}`, "error");
    setStatus(`Edit not applied: ${(error as Error).message}`, true);
    return;
  }
  const edit = { abc, visualObj, forcePlay, generation, synthControl };
  // Skipped only when a newer edit or render has the controller. After a
  // cancel it still re-primes, without playing: the new score is on screen,
  // and the next ▶ must not play the old tune under it.
  await transportQueue.run(() =>
    !disposed && state.synthControl === synthControl && synthControlOwner === generation
      ? primeEdit(edit)
      : undefined,
  );
}

/** Draw an edit and make it the widget's score. Throws if it won't engrave. */
function engraveEdit(abc: string, effective: string, messages: string[]): ABCJS.TuneObject[] {
  clearHighlights();
  const visualObj = engraveScore(effective);
  // abcjs types the return as a 1-tuple, but unparseable input really does
  // come back empty at runtime — hence the widened length check.
  if (!visualObj || (visualObj as unknown as unknown[]).length === 0) {
    throw new Error("Failed to parse music notation");
  }
  // The edit is now the source of truth for the title, both download stems
  // and send-to-chat.
  resetFollow();
  state.visualObj = visualObj;
  state.currentAbc = abc;
  lastEditRendered = abc;
  renderTitle();
  syncInstrumentSelect();
  setEditorMessage(messages.length > 0 ? messages.join("\n") : null, "warn");
  return visualObj;
}

/** The audio half of {@link applyEditorAbc}, run by `transportQueue`. */
async function primeEdit(edit: {
  abc: string;
  visualObj: ABCJS.TuneObject[];
  forcePlay: boolean;
  generation: number;
  synthControl: ABCJS.SynthObjectController;
}): Promise<void> {
  const { abc, visualObj, forcePlay, generation, synthControl } = edit;
  // Read after the wait: an autoplay that was still loading is playing now.
  const transport = readTransport(synthControl);
  const { wasPlaying } = transport;

  try {
    // The edit is on screen whatever happens to the sounds: a failed load is
    // reported by onTransportEvent (▶ retries), not as "Edit not applied".
    const primed = await synthControl
      .setTune(visualObj[0], true, currentSynthOptions() as SynthOptions)
      .then(
        () => true,
        () => false,
      );
    if (primed) hasPrimedAudio = true;

    // New tool input, a cancel or a teardown landed while setTune was priming.
    // The controller we just re-primed may already have been retired; don't
    // wire it back up, and don't let it start playing.
    if (isStale(generation)) {
      releaseStaleControl(synthControl, generation);
      return;
    }

    downloadBtn.disabled = !downloadSupported;
    midiBtn.disabled = !downloadSupported;
    sendBtn.disabled = !messageSupported;
    restoreLoop(synthControl, transport);

    if (primed && (wasPlaying || forcePlay)) {
      await (synthControl.play() as unknown as Promise<unknown> | undefined);
      if (isStale(generation)) {
        releaseStaleControl(synthControl, generation);
        return;
      }
      setStatus("Playing...");
    } else if (primed) {
      setStatus("Edit applied — click ▶ to play");
    }
    reportEditToModel(abc, primed);
  } catch (error) {
    if (isStale(generation)) return;
    console.error("Edit render error:", error);
    setEditorMessage(`Edit not applied: ${(error as Error).message}`, "error");
    setStatus(`Edit not applied: ${(error as Error).message}`, true);
  }
}

editorEl.addEventListener("input", scheduleEditRender);

editorEl.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    cancelEditRender();
    void applyEditorAbc(true);
  }
});

// =============================================================================
// Fullscreen Button
// =============================================================================

let appInstance: App | null = null;

const fullscreenBtn = document.createElement("button");
fullscreenBtn.className = "toolbar-btn";
fullscreenBtn.textContent = "⛶";
fullscreenBtn.title = "Toggle fullscreen";
fullscreenBtn.setAttribute("aria-label", "Toggle fullscreen");
fullscreenBtn.setAttribute("aria-pressed", "false");

// The call used to be fire-and-forget, asking only ever for "fullscreen": a
// host that declined (or doesn't implement the method — it answers -32601)
// produced an unhandled rejection and no feedback, and there was no way back to
// the inline layout. Mirrors toggleDisplayMode() in src/strudel-app.ts: await
// it, trust the mode the host GRANTED rather than the one we asked for, toggle
// both ways, and say so when the host says no.
fullscreenBtn.addEventListener("click", () => {
  void toggleDisplayMode();
});
toolbarEl.appendChild(fullscreenBtn);

/** The mode the host says we are in; drives the toggle and the button state. */
let displayMode: "inline" | "fullscreen" | "pip" = "inline";
let availableDisplayModes: readonly string[] | null = null;

/**
 * Size the widget to the host's container (src/frame-size.ts): inline, grow
 * with the score up to the host's max or most of the screen, and scroll the
 * sheet inside that; fullscreen or a fixed container, fill it. Our own
 * `displayMode` wins over the context's, since a host may grant a mode change
 * before (or without) sending the context update for it.
 */
function syncFrameSize(): void {
  const ctx = appInstance?.getHostContext();
  applyFrameSize(
    resolveFrameSize({ ...ctx, displayMode }, screenAvailHeight(), SHEET_INLINE_CAP),
  );
}
syncFrameSize();

function syncFullscreenButton(): void {
  const isFullscreen = displayMode === "fullscreen";
  fullscreenBtn.setAttribute("aria-pressed", String(isFullscreen));
  fullscreenBtn.title = isFullscreen ? "Leave fullscreen" : "Toggle fullscreen";
}

async function toggleDisplayMode(): Promise<void> {
  const app = appInstance;
  if (!app) return;
  const wanted = displayMode === "fullscreen" ? "inline" : "fullscreen";
  if (availableDisplayModes && !availableDisplayModes.includes(wanted)) {
    setStatus(`This host doesn't offer ${wanted} mode — using the inline layout`);
    return;
  }
  try {
    const result = await app.requestDisplayMode({ mode: wanted });
    if (result?.mode) displayMode = result.mode;
    syncFullscreenButton();
    syncFrameSize();
    // The score reflows on its own: renderAbc runs with responsive: "resize",
    // so abcjs's own window-resize handler re-lays the SVG to the new frame.
  } catch {
    setStatus("Fullscreen isn't available here — using the inline layout");
    syncFullscreenButton();
  }
}

// =============================================================================
// Download Button
// =============================================================================

const downloadBtn = document.createElement("button");
downloadBtn.className = "toolbar-btn";
downloadBtn.textContent = "↓";
downloadBtn.title = "Download audio (WAV)";
downloadBtn.setAttribute("aria-label", "Download audio as WAV");
downloadBtn.disabled = true;
toolbarEl.appendChild(downloadBtn);

// Whether the host supports host-mediated downloads (set after connect).
// On hosts without this capability (e.g. Claude mobile), the button stays
// hidden so users don't hit a -32601 "method not found" error.
// Default false: stay disabled until the capability is confirmed (avoids a
// race window where the button is clickable before connect() resolves).
let downloadSupported = false;
// Whether the host supports widget→chat messages (ui/message). Gates the Send button.
let messageSupported = false;

/** The tune's T: header, if it has one. */
function abcHeaderTitle(abc: string | null): string | null {
  const match = abc?.match(/^T:\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

/**
 * What the widget calls this piece: the tool's `title` argument if given,
 * else the ABC's T: header. Drives the header label and both download stems.
 */
function displayTitle(): string {
  return state.toolTitle ?? abcHeaderTitle(state.currentAbc) ?? "";
}

/** Filename stem for the WAV/MIDI exports. */
function downloadStem(): string {
  return sanitizeFileStem(displayTitle());
}

/** Paint the title into the header, hiding the slot when there is no title. */
function renderTitle(): void {
  const title = displayTitle();
  pieceTitleEl.textContent = title;
  pieceTitleEl.hidden = title.length === 0;
}

downloadBtn.addEventListener("click", async () => {
  if (!state.synthControl) return;
  // getAudioBuffer() lives on the internal CreateSynth (midiBuffer), not on SynthController
  const midiBuffer = (state.synthControl as any).midiBuffer;
  const audioBuffer: AudioBuffer | undefined = midiBuffer?.getAudioBuffer?.();
  if (!audioBuffer) {
    setStatus("Play first to generate audio", true);
    return;
  }
  downloadBtn.disabled = true;
  downloadBtn.textContent = "...";
  try {
    const wavBase64 = audioBufferToWavBase64(audioBuffer);
    const title = downloadStem();
    await app.downloadFile({
      contents: [
        {
          type: "resource",
          resource: {
            uri: `file:///${title}.wav`,
            mimeType: "audio/wav",
            blob: wavBase64,
          },
        },
      ],
    });
  } catch (err) {
    setStatus(`Download failed: ${(err as Error).message}`, true);
  } finally {
    downloadBtn.disabled = false;
    downloadBtn.textContent = "↓";
  }
});

// =============================================================================
// MIDI Download Button
// =============================================================================
//
// getMidiFile() renders a standard MIDI file straight from the parsed tune,
// so unlike the WAV export it needs no prior playback. It takes the same
// SynthOptions the player uses (MidiFileOptions extends SynthOptions), which
// is why style-preset tracks — drums, bass, chords — land as separate MIDI
// tracks at the right tempo. Sound-font options are stripped: they only
// affect sample playback and mean nothing in an SMF.
//
// ## It is the SCORE, not the performance — and it says so
//
// Two things the player does never reach the file, because abcjs applies them
// after the MIDI writer has had its turn:
//
//  * **Swing.** `addSwing()` lives in create-synth.js and runs during
//    `prime()`, on the already-flattened event list. `getMidiFile()` goes
//    through abc_midi_create.js instead, which never sees it. Measured: swing
//    0 and swing 66 on the same tune produce byte-identical 241-byte files,
//    and even `setUpAudio()`'s note start times are unchanged
//    (tests/midi-swing.test.ts).
//  * **Tempo warp.** The transport's warp slider scales
//    `millisecondsPerMeasure` inside SynthController; the tune's own Q: is
//    what the writer reads.
//
// Reimplementing either in the export would mean forking abcjs's timing model
// and keeping the fork honest forever. The export is labelled for what it is
// instead, in the tooltip and again in the status line after each download, so
// nobody discovers the difference by ear in another program.

const midiBtn = document.createElement("button");
midiBtn.className = "toolbar-btn toolbar-btn-text";
midiBtn.textContent = "MIDI";
midiBtn.title = "Score MIDI (no swing) — notes as written, without swing or the tempo slider";
midiBtn.setAttribute(
  "aria-label",
  "Download score MIDI — no swing or tempo warp",
);
midiBtn.disabled = true;
toolbarEl.appendChild(midiBtn);

function midiExportOptions(): ABCJS.MidiFileOptions {
  const {
    soundFontUrl: _soundFontUrl,
    soundFontVolumeMultiplier: _soundFontVolumeMultiplier,
    // The swing capture only matters to prime(); the writer never swings.
    sequenceCallback: _sequenceCallback,
    callbackContext: _callbackContext,
    ...musical
  } = currentSynthOptions();
  return {
    ...musical,
    midiOutputType: "binary",
  } as ABCJS.MidiFileOptions;
}

midiBtn.addEventListener("click", async () => {
  const tune = state.visualObj?.[0];
  if (!tune) {
    setStatus("Nothing to export yet", true);
    return;
  }
  midiBtn.disabled = true;
  midiBtn.textContent = "...";
  try {
    // midiOutputType "binary" returns a Uint8Array (abcjs get-midi-file.js).
    const midi = ABCJS.synth.getMidiFile(tune, midiExportOptions()) as
      | Uint8Array
      | undefined;
    if (!midi || midi.length === 0) {
      throw new Error("MIDI generation produced no data");
    }
    const title = downloadStem();
    await app.downloadFile({
      contents: [
        {
          type: "resource",
          resource: {
            uri: `file:///${title}.mid`,
            mimeType: "audio/midi",
            blob: bytesToBase64(midi),
          },
        },
      ],
    });
    setStatus("Score MIDI saved — notes as written, without swing or tempo warp.");
  } catch (err) {
    setStatus(`MIDI download failed: ${(err as Error).message}`, true);
  } finally {
    midiBtn.disabled = false;
    midiBtn.textContent = "MIDI";
  }
});

// =============================================================================
// Send to Chat Button (roundtrip edited ABC back to the conversation)
// =============================================================================

const sendBtn = document.createElement("button");
sendBtn.className = "toolbar-btn";
sendBtn.textContent = "↗";
sendBtn.title = "Send this ABC to chat";
sendBtn.setAttribute("aria-label", "Send this ABC notation to the chat");
sendBtn.disabled = true;
// Start hidden; revealed only after the host confirms ui/message support
// (matches the Strudel widget, avoids a flash on unsupported hosts).
sendBtn.hidden = true;
toolbarEl.appendChild(sendBtn);

sendBtn.addEventListener("click", async () => {
  if (!state.currentAbc) return;
  sendBtn.disabled = true;
  sendBtn.textContent = "...";
  try {
    await app.sendMessage({
      role: "user",
      content: [
        {
          type: "text",
          text: "Here's my ABC notation:\n```\n" + state.currentAbc + "\n```",
        },
      ],
    });
  } catch (err) {
    setStatus(`Send failed: ${(err as Error).message}`, true);
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = "↗";
  }
});

// =============================================================================
// ABC Rendering
// =============================================================================

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

// Toggle a lightweight loading skeleton/spinner in the sheet area.
// Used during streaming before the score is renderable.
function setLoading(text: string): void {
  setStatus(text);
  if (!state.visualObj) {
    // Build via DOM API (not innerHTML) so this never becomes an injection sink.
    const skeleton = document.createElement("div");
    skeleton.className = "loading-skeleton";
    skeleton.setAttribute("role", "status");
    skeleton.setAttribute("aria-live", "polite");
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    spinner.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = text;
    skeleton.append(spinner, label);
    sheetMusicEl.replaceChildren(skeleton);
  }
}

const SCORE_RENDER_OPTIONS = { responsive: "resize", add_classes: true } as const;

/**
 * Engrave `abc` (the effective notation, style already applied) into the
 * sheet. Every render of the score goes through here.
 *
 * abcjs reserves no room for text it hangs off a note, so a long annotation
 * in a line's last bar ran past the SVG and was clipped (#28). If any such
 * text overhangs, engrave once more with the right padding widened to fit it:
 * the same layout, scaled down a little, and only when it has to be.
 */
function engraveScore(abc: string): ABCJS.TuneObject[] {
  const tunes = ABCJS.renderAbc(sheetMusicEl, abc, SCORE_RENDER_OPTIONS);
  const paddingright = overhangPadding(tunes);
  return paddingright === null
    ? tunes
    : ABCJS.renderAbc(sheetMusicEl, abc, { ...SCORE_RENDER_OPTIONS, paddingright });
}

/** The right padding the engraved score needs, or null if it already fits. */
function overhangPadding(tunes: ABCJS.TuneObject[]): number | null {
  // The tune's own %%rightmargin outranks the option: nothing to gain.
  if (tunes[0]?.formatting?.rightmargin !== undefined) return null;
  const svg = sheetMusicEl.querySelector("svg");
  const width = svg?.viewBox?.baseVal?.width;
  if (!svg || !width) return null;
  const edges: number[] = [];
  for (const el of svg.querySelectorAll<SVGGraphicsElement>(OVERHANG_TEXT_SELECTOR)) {
    try {
      const box = el.getBBox(); // SVG user units, whatever the frame's width
      edges.push(box.x + box.width);
    } catch {
      // Not rendered (a hidden frame): nothing to measure.
    }
  }
  return paddingRightToFit(edges, width);
}

/** What a full render does about the transport it replaces (#26). */
interface RenderTransport {
  /** Start playing once primed: a tool call does, a Style change only if it was. */
  autoplay: boolean;
  /** Tempo and Loop to carry over from the controller being replaced. */
  carry?: TransportState | null;
}

const LOAD_FAILED_STATUS = "Couldn't load sounds — ▶ to retry";

/** What a controller's transport did (trackTransport, src/synth-transport.ts). */
function onTransportEvent(
  control: ABCJS.SynthObjectController,
  event: TransportEvent,
): void {
  // abcjs caches the failed samples' rejections: the retry must ask again.
  if (event.type === "load-failed") void forgetFailedSounds();
  if (disposed || state.synthControl !== control) return;
  switch (event.type) {
    case "load-failed":
      console.error("Couldn't load sounds:", event.error);
      // abcjs takes the ▶ spinner down only when a play succeeds.
      audioControlsEl.querySelector(".abcjs-midi-start")?.classList.remove("abcjs-loading");
      setStatus(withTransposeNote(LOAD_FAILED_STATUS), true);
      return;
    case "started":
      // Started by a continuation a cancel superseded (a parked autoplay a tap
      // released, a tempo change): it is stopped at once, and the canceller's
      // status stays up. The user's own ▶ takes ownership first, so it reads.
      if (ownerCancelled(control)) return;
      return showTransportStatus("Playing...");
    case "paused":
      return showTransportStatus("Paused");
    case "finished":
      return showTransportStatus("Finished — ▶ to play again");
  }
}

/**
 * Say what the transport is doing. An error stays up (an edit that did not
 * apply, a failed download), except a failed load, which a start answers.
 */
function showTransportStatus(text: string): void {
  const error = statusEl.classList.contains("error");
  if (error && !statusEl.textContent?.startsWith(LOAD_FAILED_STATUS)) return;
  setStatus(withTransposeNote(text));
}

/** The autoplay a render started that has not finished loading and starting. */
let pendingAutoplay: {
  control: ABCJS.SynthObjectController;
  generation: number;
} | null = null;

/** Is `control` still loading an autoplay that nothing has superseded? */
function autoplayLoading(control: ABCJS.SynthObjectController | null): boolean {
  return (
    control !== null &&
    pendingAutoplay?.control === control &&
    !isStale(pendingAutoplay.generation)
  );
}

async function renderAbc(
  abcNotation: string,
  extraSynthOpts: Record<string, unknown> | undefined,
  transport: RenderTransport,
): Promise<void> {
  // Supersede any partial render, any earlier renderAbc still awaiting, and
  // any queued play() continuation. Everything below re-checks this.
  const generation = newGeneration();
  cancelPartialRender();

  try {
    setStatus("Rendering...");

    // Remember tool-supplied synth options (swing, ...) so later re-renders
    // triggered by the toolbar don't silently drop them.
    if (extraSynthOpts) {
      state.toolSynthOpts = extraSynthOpts;
    }

    // Retire the previous controller outright rather than merely pausing it.
    // pause() leaves its TimingCallbacks timer and primed midiBuffer alive; a
    // late callback from the old one would then highlight notes in the new
    // SVG. destroy() stops the timer, stops the buffer and resets the
    // transport (abcjs synth-controller.js).
    retireSynthControl();

    // NOTE: the editor text is deliberately NOT synced here. renderAbc() runs
    // for every Style / instrument / sound-bank change too, and those re-render
    // `state.currentAbc` — so syncing here overwrote a draft the user was still
    // typing (or one the validator had just rejected, which is exactly when it
    // is least replaceable). The editor follows EXTERNAL replacement only:
    // `ontoolinput` (a new tool call, transposition included) and
    // `ontoolinputpartial` (streaming), both of which call syncEditor directly.
    state.currentAbc = abcNotation;
    renderTitle();
    syncInstrumentSelect();
    clearHighlights();
    resetFollow();
    sheetMusicEl.innerHTML = "";
    audioControlsEl.innerHTML = "";

    const abcWithStyle = effectiveAbc(abcNotation);

    state.visualObj = engraveScore(abcWithStyle);

    if (!state.visualObj || state.visualObj.length === 0) {
      throw new Error("Failed to parse music notation");
    }

    if (!ABCJS.synth.supportsAudio()) {
      throw new Error("Audio not supported in this browser");
    }

    const synthControl = new ABCJS.synth.SynthController();
    ownSynthControl(synthControl, generation);
    keepLoopLitThroughWarp(synthControl);
    // Before load(), which hands the Play button `self.play` by reference.
    trackTransport(synthControl, (event) => onTransportEvent(synthControl, event));
    queueWarp(synthControl, transportQueue, () => {
      const requested = renderGeneration;
      // A cancel landed while the change ran, and setWarp() played on anyway.
      return () => {
        if (isStale(requested) && ownerCancelled(synthControl)) silence(synthControl);
      };
    });
    synthControl.load(audioControlsEl, cursorControl, {
      displayLoop: true,
      displayPlay: true,
      displayProgress: true,
      displayWarp: true,
    });
    if (transport.carry) {
      carryWarp(synthControl, transport.carry.warp, state.visualObj[0]);
    }

    await synthControl.setTune(
      state.visualObj[0],
      false,
      currentSynthOptions() as SynthOptions,
    );

    // setTune awaited: a newer render (or a teardown) may have landed while we
    // were gone. Retire what we just built rather than wiring it up.
    if (isStale(generation)) {
      releaseStaleControl(synthControl, generation);
      return;
    }

    // Show toolbar once we have content
    toolbarEl.classList.add("visible");
    downloadBtn.disabled = !downloadSupported;
    // MIDI is generated from the parsed tune, so it needs no prior playback.
    midiBtn.disabled = !downloadSupported;
    sendBtn.disabled = !messageSupported;

    // setTune() switched Loop off; put the listener's back.
    if (transport.carry) restoreLoop(synthControl, transport.carry);
    if (!transport.autoplay) {
      setStatus(withTransposeNote("Click ▶ to play"));
      return;
    }

    // Autoplay — attempt to start playback immediately
    // (may be blocked by browser autoplay policy until user clicks).
    // play() returns a Promise, so a synchronous try/catch never fires —
    // attach to the promise to report the real outcome.
    //
    // play() goes through runWhenReady(), which primes first, so this is the
    // slowest continuation in the widget and the one most likely to land in a
    // discarded generation. Both branches re-check before touching the UI, and
    // the resolved branch stops audio it started into a stale generation.
    pendingAutoplay = { control: synthControl, generation };
    const autoplayDone = () => {
      if (pendingAutoplay?.control === synthControl) pendingAutoplay = null;
    };
    (synthControl.play() as Promise<void> | undefined)
      ?.finally(autoplayDone)
      .then(() => {
        hasPrimedAudio = true;
        if (isStale(generation)) {
          // NOT an unconditional destroy: an edit reuses this very controller
          // while bumping the generation, so destroying it here left the score
          // the user is now editing with `isLoaded: true, midiBuffer: null`
          // and threw on the next ▶.
          releaseStaleControl(synthControl, generation);
          return;
        }
        setStatus(withTransposeNote("Playing..."));
      })
      .catch((e) => {
        if (isStale(generation)) return;
        console.debug("Autoplay failed:", e);
        // A failed load has already said so (onTransportEvent).
        if (!statusEl.classList.contains("error")) {
          setStatus(withTransposeNote("Click ▶ to play"));
        }
      });
    // A blocked autoplay never rejects: go() waits on AudioContext.resume(),
    // which stays pending until a gesture resumes the context, and "Rendering..."
    // stayed up. A context that is merely starting gets a moment first.
    void resumeAudioContext(audioContext(), AUDIO_SETTLE_MS).then((running) => {
      if (!running && autoplayLoading(synthControl)) {
        setStatus(withTransposeNote("Click ▶ to play"));
      }
    });
  } catch (error) {
    if (isStale(generation)) return;
    console.error("Render error:", error);
    setStatus(`Error: ${(error as Error).message}`, true);
    audioControlsEl.innerHTML = "";
  }
}

// =============================================================================
// MCP Apps SDK Integration
// =============================================================================

// The spec has views declare the display modes they support; a host may
// refuse to switch a view into one it didn't list.
const app = new App(
  { name: "Music Studio", version: VERSION },
  { availableDisplayModes: ["inline", "fullscreen"] },
);
appInstance = app;

// Handle complete tool input
app.ontoolinput = (params) => {
  console.info("Received tool input:", params);

  // The complete input supersedes the stream that produced it. Without this,
  // a partial render still sitting in the 150 ms debounce fires AFTER the
  // final score is on screen — replacing it with a half-finished tune and
  // resetting the status to "Composing…". `renderAbc()` cancels it again for
  // its own sake; this call also covers the no-notation branch below.
  cancelPartialRender();

  const args = params.arguments ?? {};
  const preparedInput = prepareToolInput(args);
  // A new tool call replaces the previous one's transposition caveat, if any.
  transposeNote = null;

  state.currentInstrument = preparedInput.instrument;
  // A new tool call hands the instrument back to the score (#25).
  state.instrumentOverride = false;
  instrumentSelect.value = preparedInput.instrument;

  state.currentStyle = preparedInput.style;
  styleSelect.value = preparedInput.style;

  const argTitle = typeof args.title === "string" ? args.title.trim() : "";
  state.toolTitle = argTitle.length > 0 ? argTitle : null;

  if (preparedInput.abcNotation) {
    // Transpose the notation itself (score + key signature), not just the MIDI
    // stream, and do it once here so later style/instrument re-renders reuse
    // the already-transposed ABC rather than shifting it again. When abcjs
    // can't move the notation safely (a keyless tune, or a rewrite that failed
    // verification) the shift rides in as `%%MIDI transpose` and `warning` says
    // so, so nobody claims the printed score moved when it didn't.
    const transposed = transposeAbcDetailed(
      preparedInput.abcNotation,
      preparedInput.transpose,
    );
    const abc = transposed.abc;
    transposeNote = transposed.warning;
    reportTransposeToModel(transposed.warning);
    // A fresh tool call supersedes anything in the editor, and resets the
    // edit bookkeeping so the next user edit is reported to the model.
    cancelEditRender();
    syncEditor(abc);
    lastEditRendered = abc;
    lastEditReported = abc;
    setEditorMessage(null, "error");
    renderAbc(abc, preparedInput.synthOptions, { autoplay: true }).catch(console.error);
  } else {
    setStatus("No ABC notation provided", true);
  }
};

// Handle streaming/partial tool input — render as AI types
// Debounce streaming renders to avoid excessive re-renders and scroll thrashing
let partialRenderTimer: ReturnType<typeof setTimeout> | null = null;
let lastPartialAbc = "";

app.ontoolinputpartial = (params) => {
  const abcNotation = params.arguments?.abcNotation as string | undefined;
  if (!abcNotation) return;

  // Keep state current during streaming so UI controls work. The editor pane
  // follows along too, so opening it mid-compose shows the notation so far
  // rather than a stale tune.
  state.currentAbc = abcNotation;
  syncEditor(abcNotation);
  lastEditRendered = abcNotation;
  lastEditReported = abcNotation;

  // Name the piece as soon as either source of a title arrives, so the header
  // fills in while the score is still streaming rather than snapping in at the
  // end. Cheap: renderTitle only touches one text node.
  const partialTitle = params.arguments?.title;
  if (typeof partialTitle === "string" && partialTitle.trim().length > 0) {
    state.toolTitle = partialTitle.trim();
  }
  renderTitle();

  // Apply style from partial input if provided
  const style = params.arguments?.style as string | undefined;
  if (style && isStyleName(style) && state.currentStyle !== style) {
    state.currentStyle = style;
    styleSelect.value = style;
  }

  // Only attempt render if we have at least a key signature (minimum viable ABC)
  if (!abcNotation.match(/K:[^\n]+/)) {
    setLoading("Composing…");
    return;
  }

  // Skip if content hasn't changed
  if (abcNotation === lastPartialAbc) return;
  lastPartialAbc = abcNotation;

  // Debounce: wait for a pause in streaming before re-rendering.
  //
  // Two guards, because clearTimeout alone is not enough: a `renderAbc()`
  // started by the complete input can still be mid-await when this fires, and
  // the timer must not paint a half-tune over it. The captured generation is
  // the check that makes "the newest intent wins" true rather than hoped for.
  if (partialRenderTimer) clearTimeout(partialRenderTimer);
  const generation = renderGeneration;
  partialRenderTimer = setTimeout(() => {
    partialRenderTimer = null;
    if (isStale(generation)) return;
    try {
      const abcWithStyle = effectiveAbc(abcNotation);
      // Render in place — ABCJS replaces the target element's content
      engraveScore(abcWithStyle);
      // Keep the newest notation in view as it streams in — unless the
      // reader has scrolled back to look at something.
      if (!userIsScrolling()) {
        sheetSectionEl.scrollTop = sheetSectionEl.scrollHeight;
      }
      setStatus("Composing...");
    } catch {
      // Partial input may not parse — that's fine
    }
  }, 150);
};

app.onerror = console.error;

// Reset playback/highlight state when a compose is cancelled or torn down.
function stopPlayback(): void {
  try {
    if (state.synthControl) pauseTransport(state.synthControl);
  } catch {
    // synthControl may not be loaded yet — ignore
  }
  clearHighlights();
}

// Cancel any pending debounced partial render so a stale timer can't fire
// after a cancel/teardown and re-render old ABC or reset the status.
function cancelPartialRender(): void {
  if (partialRenderTimer) {
    clearTimeout(partialRenderTimer);
    partialRenderTimer = null;
  }
  lastPartialAbc = "";
}

// Tool cancelled — clear the stale "Composing…" status so the UI isn't stuck.
//
// `newGeneration()` matters as much as the two cancels: a `renderAbc()` that
// is already past its `setTune` await has no timer to clear, and would
// otherwise go on to autoplay a tune the user just cancelled.
app.ontoolcancelled = (params) => {
  newGeneration();
  stopPlayback();
  cancelPartialRender();
  const reason = params?.reason ? ` (${params.reason})` : "";
  setStatus(`Composition cancelled${reason}.`);
};

// Host is tearing down this instance — stop audio so a discarded widget
// leaves nothing playing. `disposed` is terminal: it fails every outstanding
// continuation, including ones whose generation is still current.
app.onteardown = () => {
  disposed = true;
  newGeneration();
  cancelPartialRender();
  // A pending edit render must not fire into a discarded widget.
  cancelEditRender();
  // Not just pause(): the timer and primed buffer have to go too, or a late
  // beat callback keeps running against a detached document.
  retireSynthControl();
  return {};
};

function handleHostContextChanged(ctx: McpUiHostContext) {
  // Follow the host-driven theme (which may differ from the OS preference).
  if (ctx.theme) {
    applyDocumentTheme(ctx.theme);
  }
  // The host is the authority on the display mode — it can put us in or out of
  // fullscreen without our asking — so follow it rather than tracking our own.
  if (ctx.displayMode) {
    displayMode = ctx.displayMode;
    syncFullscreenButton();
  }
  if (ctx.availableDisplayModes) {
    availableDisplayModes = ctx.availableDisplayModes;
  }
  // Apply host-provided CSS variable tokens, if any.
  if (ctx.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
  // The host's font faces, so `--font-sans` / `--font-mono` resolve.
  if (ctx.styles?.css?.fonts) {
    applyHostFonts(ctx.styles.css.fonts);
  }
  if (ctx.safeAreaInsets) {
    applySafeAreaInsets(ctx.safeAreaInsets);
  }
  if (ctx.displayMode || ctx.containerDimensions) syncFrameSize();
}

app.onhostcontextchanged = handleHostContextChanged;

app.connect().then(() => {
  // Gate the download button on host capability — Claude mobile lacks
  // downloadFile, so calling it returns -32601. Hide the button there.
  downloadSupported = Boolean(app.getHostCapabilities()?.downloadFile);
  if (!downloadSupported) {
    downloadBtn.hidden = true;
    downloadBtn.disabled = true;
    downloadBtn.title = "Audio download isn't supported by this host";
    // Same capability gates the MIDI export.
    midiBtn.hidden = true;
    midiBtn.disabled = true;
    midiBtn.title = "File download isn't supported by this host";
  }

  // Gate the Send-to-chat button on the host's message capability so it can't
  // throw -32601 on hosts that don't advertise ui/message. Reveal only when supported.
  // Runtime feedback to the model when the user edits the score in the widget.
  contextUpdateSupported = Boolean(
    app.getHostCapabilities()?.updateModelContext,
  );

  messageSupported = Boolean(app.getHostCapabilities()?.message);
  if (messageSupported) {
    sendBtn.hidden = false;
  } else {
    sendBtn.disabled = true;
    sendBtn.title = "Sending to chat isn't supported by this host";
  }

  const ctx = app.getHostContext();
  if (ctx) {
    handleHostContextChanged(ctx);
  }
});
