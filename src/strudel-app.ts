import {
  initLayers, fixLayout, syncVizCanvasSize, getHydraCanvas, adoptHydraCanvas,
  syncHydraCanvasSize, pruneDrawLayers, clearDrawLayers, applyVizVisibility,
  syncVizTheme, applyStageMode, syncStageAffordance, stageVisuals,
  observeVisualSize, disconnectVisualObservers, removeDrawLayers, getVisualLayers, stageFrame,
} from "./strudel-app/layers";
import {
  initAudioReactive, installAudioReactiveGlobals, startAnalyserLoop, teardownAudioAnalyser, hasAudioApi,
} from "./strudel-app/audio-reactive";
import {
  initReports, readEvalError, reportToModel, cancelStateReport, scheduleStateReport, reportEvaluation,
} from "./strudel-app/reports";
import {
  initMissingSounds, installConsoleWatch, removeConsoleWatch, resetMissingSounds, cancelMissingSoundReport,
} from "./strudel-app/missing-sounds";
import {
  initRecording, startRecording, stopRecording, handleDownload, teardownRecording, disconnectRecordingTap,
  canRecordVideo, noteSetlistChange, paintVideoFrameAfterHydraTick,
} from "./strudel-app/recording";
import * as widgetState from "./strudel-app/state";
import type { StatusType } from "./strudel-app/state";
import { liveStudioSchemas } from "./studio-live-schemas";
import { bindSourceLink } from "./source-link.js";
import { createStudioSession, installStudioBridge, type StudioSwapHooks } from "./studio-session";
import { registerStudioAppTools } from "./studio-app-tools";
import { installStudioReviewPanel } from "./studio-review-panel";
import { createPieceStagePolicy } from "./stage-request-policy";
import { installStrudelCompanion } from "./studio-strudel-companion";
// =============================================================================
// Strudel ext-apps client — uses @strudel/repl with layout fixes
//
// @strudel/repl's <strudel-editor> (StrudelMirror) renders:
//   1. A visualization canvas via getDrawContext("test-canvas"). We pre-create
//      that canvas in static HTML so it's REUSED as an in-flow backdrop instead
//      of a position:fixed body canvas (see strudel-app.html / .css).
//   2. The CodeMirror editor inside a wrapper <div> whose background is set
//      INLINE to var(--background) — an OPAQUE dark fill. That wrapper sits over
//      the backdrop canvas and hides it; .viz-on makes it transparent in CSS so
//      the animation shows behind the code (the v0.4.1→v0.4.2 occlusion fix).
// =============================================================================

import "./strudel-app.css";
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import { detectViz } from "./shared/viz-detect";
import { hapNumber } from "./shared/hap-number";
import { injectTempo } from "./shared/tempo";
import { createBrowserStageEnv, createStage } from "./shared/stage-runtime";
import { installSampleUrlFix } from "./shared/sample-url-fix";
import { sourceLineNote } from "./shared/line-map";
import { DEFAULT_SHARE_ORIGIN } from "./shared/share-url";
import { SessionClient, type ApplyOutcome, type SessionStatus } from "./session-client";
import { nextBoundary, SESSION_ID_RE, SESSION_SWAP_LEAD_S, type QueuedPattern } from "./shared/session";
import { isSpliced, settle, spliceAt, swapOutcome } from "./shared/splice";
import { applyVisualPreset } from "./shared/visual-presets";
import {
  STRUDEL_INLINE_CAP,
  applyFrameSize,
  applySafeAreaInsets,
  resolveFrameSize,
  screenAvailHeight,
} from "./frame-size";
import { sanitizeFileStem } from "./bytes-to-base64";
import {
  GestureAudioLatch,
  listenForAudioGestures,
  playTapAction,
  playbackState,
  resumeAudioContext,
  type PlaybackState,
} from "./audio-unlock";
import {
  AutoplayMemory,
  ViewIdChannel,
  browserStorage,
  claimAutoplay,
  toolCallKey,
  viewIdOf,
} from "./view-memory";
import { VERSION } from "./version";

const STRUDEL_CDN = "https://unpkg.com/@strudel/repl@1.3.0";

// The spec has views declare the display modes they support; a host may
// refuse to switch a view into one it didn't list.
const app = new App(
  { name: "Strudel Live Pattern", version: VERSION },
  { availableDisplayModes: ["inline", "fullscreen"], tools: { listChanged: true } },
);

const playBtn = document.getElementById("play-btn") as HTMLButtonElement;
const recordBtn = document.getElementById("record-btn") as HTMLButtonElement;
const videoBtn = document.getElementById("video-btn") as HTMLButtonElement;
const downloadBtn = document.getElementById("download-btn") as HTMLButtonElement;
const sendBtn = document.getElementById("send-btn") as HTMLButtonElement;
const passBtn = document.getElementById("pass-btn") as HTMLButtonElement;
const endBtn = document.getElementById("end-btn") as HTMLButtonElement;
const sessionBadge = document.getElementById("session-badge") as HTMLElement;
const fullscreenBtn = document.getElementById("fullscreen-btn") as HTMLButtonElement;
const vizBtn = document.getElementById("viz-btn") as HTMLButtonElement;
const stageBtn = document.getElementById("stage-btn") as HTMLButtonElement;
const titleEl = document.getElementById("pattern-title") as HTMLElement;
const replSection = document.querySelector(".repl-section") as HTMLElement;
const vizCanvas = document.getElementById("test-canvas") as HTMLCanvasElement;
const statusEl = document.getElementById("status")!;
const container = document.getElementById("strudel-container")!;

let companion: ReturnType<typeof installStrudelCompanion> | undefined;
/**
 * Play was pressed on the page (the Play button, or the editor's own
 * Ctrl/Cmd/Alt+Enter inside the editor) and that evaluation succeeded. Share
 * pages relay play/swap tools only after a press of Play: on a link anyone can
 * craft, nothing runs until Play is pressed there. The intent is armed only on
 * the paths that start an evaluation, and only the evaluation they start
 * consumes it (taken synchronously on entry; cleared after the event).
 */
let playPressIntent = false;
let playPressed = false;
let editorEl: HTMLElement | null = null;
let currentCode = "";

/**
 * Bumped by every renderPattern() and by teardown. Async work reads its own
 * generation back after each `await`: if it no longer matches, a newer tool
 * input (or the host discarding the widget) has taken over and the superseded
 * run must stop touching the DOM rather than racing the current one.
 */
let renderGeneration = 0;

/**
 * A viewer who asked for less motion gets no AUTO-revealed backdrop and no
 * Hydra preset — both are continuous, unprompted animation. The manual
 * "Visuals" toggle and hand-written shader code still work: the setting is
 * about what we start on our own, not about what the user asks for.
 */
const reducedMotionQuery =
  typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;

function prefersReducedMotion(): boolean {
  return reducedMotionQuery?.matches === true;
}

// Host capabilities (populated after connect)

let canSendMessage = false;

/** Code WE put in the editor (tool input, a session update); anything else the human ran is an edit. */
let lastProgrammaticCode = "";
let lastLoggedEdit = "";
/** Set by a session update just before it evaluates: the cycle its audio takes over. */
/**
 * The evaluation a quantized swap (swap-pattern or a session update) asked
 * for: the hook takes it SYNCHRONOUSLY on entry, so it belongs to exactly that
 * evaluate() call, and refuses to run it unless the buffer still holds the
 * swap's own code and no newer swap/edit/press superseded it — checked right
 * before the editor reads its buffer (Codex review: a queued swap evaluation
 * ran the NEXT swap's code under its own name).
 */
interface SwapEvaluation {
  code: string;
  /** sessionApplySeq when the swap took over. */
  seq: number;
  boundary: number | null;
  refused: boolean;
}
let swapEvaluation: SwapEvaluation | null = null;
let sessionApplySeq = 0;
// Last args from renderPattern, so a CDN retry can re-run the same pattern
let lastRenderArgs: Record<string, unknown> | null = null;

initRecording({
  app, recordBtn, videoBtn, downloadBtn, setStatus, showPlayingStatus,
  replAudioContext, ensureLimiter, currentLimiter, recordingFileStem,
  visualLayers: getVisualLayers, stageFrame,
  hydraTicking: () => hydraTickRaf !== null,
  currentCode: getLiveCode,
  audibleCycle: () => stageEnv.audibleCycle(),
  inSession: () => widgetState.session !== null,
});

initReports({
  app, getEditor, currentPlaybackState, isSchedulerStarted, audioIsBlockedNow,
  renderPlayButton, updatePlayState, setStatus, showPlayingStatus, sensorNotes,
});
initMissingSounds({ setStatus, reportToModel });

// Hint to the OS that this app produces audio playback
if ("audioSession" in navigator) {
  (navigator as any).audioSession.type = "playback";
}

function getEditor(): any {
  return (editorEl as any)?.editor ?? null;
}

/**
 * Read the LIVE editor buffer (the user may have edited the code in the REPL).
 * The Strudel REPL editor exposes the buffer in different ways across versions;
 * fall back to the tracked currentCode if no live getter is available.
 */
function getLiveCode(): string {
  const ed = getEditor();
  try {
    if (typeof ed?.getCode === "function") return ed.getCode();
    if (typeof ed?.code === "string") return ed.code;
    // CodeMirror 6 instance held by the StrudelMirror editor
    const cm = ed?.editor ?? ed?.view;
    const doc = cm?.state?.doc;
    if (doc && typeof doc.toString === "function") return doc.toString();
  } catch { /* fall through to tracked code */ }
  return currentCode;
}

/**
 * Load the Strudel REPL bundle.
 *
 * We deliberately do NOT call prebake() ourselves. <strudel-editor>'s
 * connectedCallback constructs StrudelMirror with the bundle's module-scoped
 * `prebake` and calls it once, parking the promise on `editor.prebaked`:
 *
 *   this.editor = new StrudelMirror({ ..., prebake, ... })
 *
 * That reference is module-internal, so overwriting `window.strudel.prebake`
 * cannot memoize it — and prebake() is not memoized upstream. Calling it here
 * as well therefore ran the whole soundfont/sample registration TWICE per
 * widget: verified in the dev harness, seven of the sample manifests
 * (Dirt-Samples.json, tidal-drum-machines.json, piano.json, vcsl.json,
 * mridangam.json, uzu strudel.json, drum-machine aliases) were each fetched
 * twice per tool call.
 *
 * So the editor owns the single prebake and we observe its promise for the
 * soundfont warning (watchPrebake below).
 *
 * SINGLE-FLIGHT: one shared promise, not a "loaded" boolean. The boolean was
 * only set in the script's onload, so two overlapping callers (a streaming boot
 * and a tool input, or two tool inputs in a row) each saw `false`, each appended
 * a <script src=…> for the 1.7MB bundle and each raced to define the same custom
 * element. Everyone now awaits the same promise; a rejection clears it so the
 * CDN-retry affordance can genuinely retry.
 */
let cdnLoad: Promise<void> | null = null;

async function loadStrudelCDN(): Promise<void> {
  if (cdnLoad) return cdnLoad;
  cdnLoad = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = STRUDEL_CDN;
    script.onload = () => {
      installConsoleWatch();
      // The eval-scope globals (initHydra, H, …) are only published once
      // <strudel-editor> builds its REPL — which is exactly why the accessors go
      // in NOW: their setters catch that publish. Waiting for the globals to
      // exist meant the first evaluation of a session ran unwrapped.
      installEvalScopeHooks();
      resolve();
    };
    script.onerror = () => {
      script.remove();
      reject(new Error("Failed to load Strudel REPL"));
    };
    document.head.appendChild(script);
  });
  cdnLoad.catch(() => {
    cdnLoad = null;
  });
  return cdnLoad;
}

/**
 * Watch the editor's single prebake() for failure, so silent audio is explained
 * rather than swallowed. Non-blocking: the REPL is usable while samples load.
 */
function watchPrebake(editor: any): void {
  const prebaked = editor?.prebaked;
  if (!prebaked || typeof prebaked.then !== "function") return;
  prebaked.then(
    () => { widgetState.setSoundfontWarning(false); companion?.refresh(); },
    () => { widgetState.setSoundfontWarning(true); },
  );
}

function setStatus(text: string, type: StatusType = "normal") {
  statusEl.textContent = text;
  statusEl.className = `status ${type}`;
}

function updatePlayState(playing: boolean) {
  // The session's heartbeat rides on its poll; re-poll so it hears this now.
  if (playing !== widgetState.isPlaying) widgetState.session?.nudge();
  // Audio may only now exist (a start after a blocked autoplay): limit it.
  if (playing) {
    try {
      ensureLimiter();
    } catch { /* declared further down this module */ }
  }
  if (!playing) {
    clearDrawLayers();
    // Stop means quiet: a sentence from say() does not outlive the music.
    // (try: stageSpeech is declared further down this module.)
    try {
      stageSpeech.cancel();
    } catch { /* not initialised yet */ }
  }
  widgetState.setIsPlaying(playing);
  widgetState.setAudioBlocked(playing && audioIsBlockedNow());
  audibleStatus = null;
  renderPlayButton();
  if (!widgetState.isRecording) {
    if (playing) showPlayingStatus("Playing...", "playing");
    else setStatus("Ready", "normal");
  }
}

/** "Playing" only when it can be heard: over blocked audio the tap is still Play. */
function renderPlayButton(): void {
  const audible = widgetState.isPlaying && !widgetState.audioBlocked;
  playBtn.classList.toggle("playing", audible);
  playBtn.textContent = audible ? "Playing" : "Play";
}

// =============================================================================
// Audio unlock (#30) — src/audio-unlock.ts has why the context starts suspended
// and why nothing upstream ever resumes it.
//
// Every gesture inside the widget resumes the context (capture phase, so it runs
// before any control's own handler and no handler can swallow it). After an
// evaluation, a running scheduler over a context that is still not running shows
// "Tap Play to start audio" instead of "Playing...", and the tap that follows
// resumes audio and keeps the pattern going instead of stopping it. The
// context's statechange puts the normal status back once sound can play.
//
// The gesture listeners stay installed rather than firing once: a gesture before
// the REPL has loaded has no context to resume, and on iOS the context can be
// suspended again later (an interruption), after which the next tap must work.
// =============================================================================

/** A gesture's resume() can never hold the Play button longer than this. */
const AUDIO_RESUME_TIMEOUT_MS = 1500;
/**
 * After an evaluation, how long a context that is merely still starting gets to
 * reach "running" before it counts as blocked. A blocked resume() never settles
 * (measured, WebKit and Chromium), so this is also how long "Tap Play" takes to
 * appear when autoplay was refused.
 */
const AUDIO_SETTLE_MS = 300;
const AUDIO_BLOCKED_STATUS = "Tap Play to start audio";

/** The status an evaluation wanted to show, held back while audio is blocked. */
let audibleStatus: { text: string; type: StatusType } | null = null;
const gestureLatch = new GestureAudioLatch();
let watchedAudioContext: AudioContext | null = null;

/**
 * The REPL's AudioContext, or null before the CDN has loaded.
 *
 * superdough's getAudioContext() CREATES the context on first call, so only
 * call this where creating one is fine (inside a gesture, which is the best
 * moment to create it) or where one already exists (the scheduler has started:
 * its clock reads currentTime).
 */
function replAudioContext(): AudioContext | null {
  try {
    return (window as any).getAudioContext?.() ?? null;
  } catch {
    return null;
  }
}

/** Scheduler running, context not: nothing can sound. Never creates a context. */
function audioIsBlockedNow(): boolean {
  return currentPlaybackState() === "audio-blocked";
}

function currentPlaybackState(): PlaybackState {
  const started = isSchedulerStarted();
  return playbackState(started, started ? replAudioContext()?.state : null);
}

function watchAudioContext(ctx: AudioContext | null): void {
  if (!ctx || ctx === watchedAudioContext) return;
  watchedAudioContext?.removeEventListener("statechange", syncAudioState);
  ctx.addEventListener("statechange", syncAudioState);
  watchedAudioContext = ctx;
}

/**
 * Resume the REPL's context if it isn't running; resolves to whether it is.
 * resume() itself runs synchronously, so call this INSIDE the gesture, before
 * any await.
 */
function ensureAudioRunning(timeoutMs = AUDIO_RESUME_TIMEOUT_MS): Promise<boolean> {
  const ctx = replAudioContext();
  watchAudioContext(ctx);
  return resumeAudioContext(ctx, timeoutMs);
}

/** A status that promises sound — held back behind "Tap Play" while it can't. */
function showPlayingStatus(text: string, type: StatusType): void {
  if (widgetState.audioBlocked) {
    audibleStatus = { text, type };
    setStatus(AUDIO_BLOCKED_STATUS, "normal");
  } else {
    setStatus(text, type);
  }
}

/**
 * Follow the context between evaluations: audio unlocked by a tap (restore the
 * held-back status), or suspended under a running pattern by the host or the OS.
 * One debounced model report per real transition, like the stop reports.
 */
function syncAudioState(): void {
  const blocked = widgetState.isPlaying && audioIsBlockedNow();
  if (blocked === widgetState.audioBlocked) return;
  widgetState.setAudioBlocked(blocked);
  renderPlayButton();
  if (blocked) {
    const text = statusEl.textContent ?? "";
    if (!widgetState.isRecording && !statusEl.classList.contains("error") && text !== AUDIO_BLOCKED_STATUS) {
      showPlayingStatus(text || "Playing...", "playing");
    }
  } else {
    if (statusEl.textContent === AUDIO_BLOCKED_STATUS) {
      const held = audibleStatus ?? { text: "Playing...", type: "playing" as const };
      setStatus(held.text, held.type);
    }
    audibleStatus = null;
  }
  scheduleStateReport();
}

// A key, a click or a TAP resumes audio; a touch that scrolled does not — on a
// phone the finger scrolling the conversation past the widget used to unmute
// an audio-blocked pattern (src/audio-unlock.ts). A touch press only records
// what the gesture began over; its activation arrives with the tap's end.
// =============================================================================
// The stage runtime — cycle(), onFrame, onEvent, onTap, say()
// (src/shared/stage-runtime.ts has why each exists). Registrations belong to
// the evaluation that made them: the evaluate hook begins/commits/rolls back.
// =============================================================================

// 22 VCSL sounds (kalimba, steinway, …) are silent in Chromium without this —
// see src/shared/sample-url-fix.ts. Installed before the REPL loads a sample.
installSampleUrlFix(window as any);

let stageErrorReported = false;
let speechFailureReported = false;
/** How long a voiced piece waits for its say() clips before starting anyway. */
const SAY_PRELOAD_TIMEOUT_MS = 4000;
const {
  env: stageEnv,
  speech: stageSpeech,
  speechReady: stageSpeechReady,
} = createBrowserStageEnv({
  getScheduler: () => getEditor()?.repl?.scheduler ?? null,
  isPlaying: () => isSchedulerStarted(),
  tapArea: replSection,
  observeTap(tap, info) {
    // A tap that changed remembered state is logged as that change (its label
    // says what it meant); logging the raw tap too would count it twice.
    if (info?.changedState) return;
    widgetState.session?.log({ t: "tap", ...tap });
  },
  observeRemembered(change) {
    widgetState.session?.remembered(change);
  },
  observeRememberedState() {
    // The session client throttles and keeps only the latest list.
    widgetState.session?.rememberedState(stage.remembered());
  },
  requestStage() {
    requestStageFromPiece();
  },
  observeControl(change) {
    widgetState.session?.log({ t: "control", ...change });
  },
  observeSurface() {
    logControlSurface();
  },
  observeSensor(sensor, state) {
    reportSensor(sensor, state);
  },
  reportError(api, error) {
    const msg = (error as Error)?.message ?? String(error);
    console.error(`[stage] ${api} callback threw:`, error);
    if (stageErrorReported) return;
    stageErrorReported = true;
    reportToModel(
      `Strudel widget: a ${api} callback threw "${msg}". The callback keeps being called; ` +
        "the error is reported once per callback. Fix it and re-run.",
    );
  },
  ttsOrigin: DEFAULT_SHARE_ORIGIN,
  reportSpeech(url, reason) {
    const text = new URL(url).searchParams.get("text") ?? "";
    console.warn(`[stage] say("${text}") could not load: ${reason}`);
    if (speechFailureReported) return;
    speechFailureReported = true;
    reportToModel(
      `Strudel widget: a say() line could not be rendered ("${text.slice(0, 60)}": ${reason}). ` +
        "That line stays silent; the rest plays. Re-running the piece retries it.",
    );
  },
});
const stage = createStage(stageEnv);

/** Put the stage globals on the eval scope. Not Strudel names, so nothing overwrites them. */
function publishStageGlobals(): void {
  Object.assign(window as any, stage.globals);
}
publishStageGlobals();

const stopGestureUnlock = listenForAudioGestures(document, {
  press(kind) {
    gestureLatch.begin(widgetState.isPlaying && audioIsBlockedNow());
    if (kind !== "touch") {
      void ensureAudioRunning();
      // Speech needs a speak() inside the gesture itself on WebKit.
      stageSpeech.unlock();
    }
  },
  activate() {
    gestureLatch.extend(widgetState.isPlaying && audioIsBlockedNow());
    void ensureAudioRunning();
    stageSpeech.unlock();
  },
});

// =============================================================================
// Tempo  (`bpm` tool parameter)
//
// Injection is shared with the browser fallback (src/shared/tempo.ts): one
// documented policy, no regex that corrupts nested parens. Three of its four
// branches put the tempo INTO the source (replaced / inserted /
// inserted-ambiguous). The fourth, "unchanged-ambiguous", deliberately returns
// the code byte for byte — the pattern binds or aliases `setcps` itself, so a
// prepended call would land in a temporal dead zone (ReferenceError) or call
// the pattern's own function.
//
// For that branch the requested tempo can only reach the pattern through
// Strudel's runtime API, so we apply it after each evaluation settles via
// `editor.repl.setCps(cps)` (a method on @strudel/core's repl) and say so, in
// the status line and to the model — a tempo silently not applied is worse than
// one applied late.
// =============================================================================

/** cps to force after each evaluation, or null when the source carries it. */
let runtimeCps: number | null = null;

function applyRuntimeTempo(): boolean {
  if (runtimeCps === null) return false;
  const cps = runtimeCps;
  try {
    const repl = getEditor()?.repl;
    if (typeof repl?.setCps === "function") {
      repl.setCps(cps);
      return true;
    }
    // Older/newer REPL shapes: the eval-scope global does the same thing.
    const setcps = (window as any).setcps;
    if (typeof setcps === "function") {
      setcps(cps);
      return true;
    }
  } catch { /* the pattern still plays, just at its own tempo */ }
  return false;
}

function waitForEditor(timeout = 8000): Promise<any> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const ed = getEditor();
      if (ed?.setCode) {
        resolve(ed);
      } else if (Date.now() - start > timeout) {
        reject(new Error("Strudel editor did not initialize"));
      } else {
        setTimeout(check, 150);
      }
    };
    check();
  });
}

initAudioReactive({ replSection, isHydraLive });

initLayers({
  replSection, vizCanvas, vizBtn, stageBtn,
  hasAudioApi, installAudioReactiveGlobals, startAnalyserLoop,
  setHydraActive, prefersReducedMotion,
});

// -----------------------------------------------------------------------------
// Eval-scope patches
//
// @strudel/repl puts its exports on globalThis (verified: `initHydra` is a
// plain writable, configurable data property, and a pattern's free identifiers
// resolve to it), so replacing them here is picked up by evaluated patterns.
// Three things need patching, all confirmed against the 1.3.0 bundle:
//
//   1. initHydra() gives us no other handle on the HydraRenderer — the module
//      keeps it in a closure and `globalThis.hydra` is undefined — so wrapping
//      is the only way to reach hush()/regl for teardown. It also lets us pin
//      hydra-synth (upstream defaults to an UNVERSIONED unpkg URL), take over
//      the render loop (autoLoop, see HYDRA_OWNED_LOOP), re-assert the
//      resolution once the engine is actually up, and re-apply the feedStrudel
//      display rule that upstream only runs on a FRESH init.
//   2. H(p) is `() => reify(p).queryArc(t, t)[0].value` — a zero-width query,
//      so a pattern with a rest under the playhead yields NO hap and it throws
//      "Cannot read properties of undefined". Hydra calls it every frame, so one
//      rest kills the shader while the audio keeps going (measured: `H("1 ~")`
//      throws, `H("<3 4 5>")` never does).
//   3. hydra-synth's makeGlobal overwrites Strudel's `time`, `speed`, `shape`
//      and `hush` globals. clearHydra() restores only speed and shape.
// -----------------------------------------------------------------------------

/** Pinned so a hydra-synth release can't silently change under the widget. */
const HYDRA_SYNTH_CDN = "https://unpkg.com/hydra-synth@1.4.0";

/**
 * hydra-synth 1.4.0's constructor ends with
 *
 *     if (autoLoop) loop(this.tick.bind(this)).start()
 *
 * and throws the `raf-loop` handle away — it is stored on nothing, so there is
 * no `hydra.loop` / `hydra.synth.loop` to stop. Destroying regl therefore leaves
 * an external requestAnimationFrame loop calling tick() forever against a dead
 * context (verified against src/hydra-synth.js at hydra-synth@1.4.0; the repo
 * publishes no tags, and main's package.json reads 1.4.0).
 *
 * So we opt out of that loop and drive tick() ourselves — one rAF we own and
 * can cancel on teardown.
 */
const HYDRA_OWNED_LOOP = { autoLoop: false } as const;

let hydraTickRaf: number | null = null;
let hydraTickLast = 0;

function startHydraTickLoop(): void {
  if (hydraTickRaf !== null) return;
  hydraTickLast = performance.now();
  const frame = (now: number) => {
    const instance = hydraInstance;
    if (!instance) {
      hydraTickRaf = null;
      return;
    }
    const dt = now - hydraTickLast;
    hydraTickLast = now;
    try {
      // dt in ms, exactly what raf-loop hands upstream's own tick.
      instance.tick(dt);
    } catch {
      // hydra-synth already swallows shader errors inside tick(); this catches
      // the teardown race where regl is destroyed mid-frame.
    }
    // Same task as the render: the WebGL buffer still holds this frame.
    paintVideoFrameAfterHydraTick();
    hydraTickRaf = requestAnimationFrame(frame);
  };
  hydraTickRaf = requestAnimationFrame(frame);
}

function stopHydraTickLoop(): void {
  if (hydraTickRaf !== null) {
    cancelAnimationFrame(hydraTickRaf);
    hydraTickRaf = null;
  }
}

/**
 * Re-apply the `feedStrudel` display rule after initHydra() returns.
 *
 * With feedStrudel, upstream textures the 2D draw canvas into s0 and hides it
 * (`getDrawContext().canvas.style.display = 'none'`) so the piano roll shows
 * only through the shader. But that line lives INSIDE the
 * `if (!document.getElementById('hydra-canvas'))` block: a repeat evaluation
 * with unchanged options reuses the instance and never runs it, while
 * setHydraActive() has just cleared the inline display — so the raw piano roll
 * reappeared on top of its own processed output. Apply the rule from here,
 * where the effective options are known, on both the fresh and reused paths.
 */
function applyHydraFeedMode(feedStrudel: boolean): void {
  if (feedStrudel) {
    vizCanvas.style.display = "none";
  } else {
    vizCanvas.style.removeProperty("display");
  }
}

/** Strudel globals that hydra-synth's makeGlobal clobbers. */
const CLOBBERED_GLOBALS = ["time", "speed", "shape", "hush"] as const;

let evalScopeHooked = false;
let hydraInstance: any = null;

/**
 * Hydra is live exactly when its canvas exists — @strudel/hydra uses the same
 * fact as its own "already initialised" flag.
 *
 * `hydraInstance` is captured by the initHydra() wrapper; the canvas check
 * covers the window between adoption and the wrapper resolving.
 */
function isHydraLive(): boolean {
  if (hydraInstance || widgetState.hydraActive) return true;
  return document.getElementById("hydra-canvas") !== null;
}

/**
 * Bumped every time the Hydra layer is struck — a pattern that no longer uses
 * it, or the host tearing the widget down.
 *
 * The initHydra() wrapper reads its own value back after `await original(...)`.
 * That await imports hydra-synth from a CDN, so a teardown lands inside it
 * routinely; the renderer that resolves afterwards belongs to a lifetime that
 * has already ended, and adopting it restarted rendering on a widget the host
 * had let go of. Same discipline as renderGeneration, for a different resource.
 */
let hydraGeneration = 0;
let strudelGlobals: Record<string, unknown> | null = null;
// Set the first time a pattern initialises Hydra: after that, the clobbered
// globals hold Hydra's values and are no longer worth snapshotting.
let hydraEverInitialised = false;

/**
 * Remember Strudel's own values for the globals hydra-synth's makeGlobal takes
 * over. The REPL publishes its eval scope in stages, so these are not all
 * present at the same moment — fill each key in as it appears, and stop once
 * Hydra has run and the values on globalThis are no longer Strudel's.
 */
function snapshotStrudelGlobals(): void {
  if (hydraEverInitialised) return;
  const w = window as any;
  strudelGlobals ??= {};
  for (const key of CLOBBERED_GLOBALS) {
    if (strudelGlobals[key] === undefined && w[key] !== undefined) {
      strudelGlobals[key] = w[key];
    }
  }
}

/**
 * Replace a global with a wrapped version that SURVIVES republishing.
 *
 * A plain `globalThis.x = wrapper` does not hold: the REPL publishes its eval
 * scope with `Object.assign(globalThis, module)` across several async chunks,
 * so a wrapper installed mid-publish is silently overwritten by a later chunk
 * (measured — the wrapper went in, and by the time a pattern ran the original
 * was back). An accessor turns every republish into a call to our setter, which
 * re-wraps the incoming original instead of losing to it.
 */
const WRAPPED_MARK = "__musicStudioWrapped";

function isWrapped(value: unknown): boolean {
  return typeof value === "function" && (value as any)[WRAPPED_MARK] === true;
}

function defineWrappedGlobal(key: string, wrap: (original: any) => any): void {
  const w = window as any;
  const apply = (value: any) => {
    if (typeof value !== "function" || isWrapped(value)) return value;
    const wrapped = wrap(value);
    try {
      Object.defineProperty(wrapped, WRAPPED_MARK, { value: true, configurable: true });
    } catch { /* exotic function — the re-check below just re-wraps it */ }
    return wrapped;
  };
  // Reading through any accessor already installed, so re-asserting is a no-op
  // rather than a double-wrap.
  let exposed = apply(w[key]);
  Object.defineProperty(w, key, {
    configurable: true,
    enumerable: true,
    get: () => exposed,
    set: (value) => {
      exposed = apply(value);
    },
  });
}

/**
 * Install the accessors, EAGERLY and repeatedly.
 *
 * This used to bail out unless `window.initHydra` was already a function — and
 * on a cold widget it isn't. The REPL publishes its eval scope asynchronously
 * after <strudel-editor> is constructed, so both call sites (prepareEditor and
 * the top of the evaluate hook) ran too early on the FIRST evaluation and the
 * hooks only landed from the second one onward. Measured consequence: the first
 * `await initHydra()` of a session ran unwrapped, so the HydraRenderer was
 * constructed with hydra-synth's default `autoLoop: true` and left an
 * unstoppable raf-loop behind, and the first pattern's `H()` could still throw
 * on a rest.
 *
 * The accessor was always meant to handle "not published yet" — its setter
 * wraps whatever arrives. So define it whether or not the global exists, from
 * the moment the bundle loads, and re-assert if a later publish used
 * defineProperty (which replaces an accessor instead of calling its setter).
 */
function installEvalScopeHooks(): void {
  const w = window as any;
  if (evalScopeHooked && isWrapped(w.initHydra) && isWrapped(w.H)) return;
  evalScopeHooked = true;

  snapshotStrudelGlobals();
  publishStageGlobals();

  defineWrappedGlobal("initHydra", (original) => async (options: Record<string, unknown> = {}) => {
    // `src` and `autoLoop` first so an explicit caller value still wins. Both
    // are destructured out by initHydra / the HydraRenderer constructor.
    hydraEverInitialised = true;
    const merged: Record<string, unknown> = {
      src: HYDRA_SYNTH_CDN,
      ...HYDRA_OWNED_LOOP,
      ...options,
    };
    // Read back after the await (see hydraGeneration) — hydra-synth is fetched
    // from a CDN, so this await is long enough for a teardown to land inside it.
    const generation = hydraGeneration;
    const previous = hydraInstance;
    const instance = await original(merged);

    if (generation !== hydraGeneration) {
      // The Hydra layer was struck while this init was in flight: the host tore
      // the widget down, or the next pattern doesn't use Hydra. The renderer
      // that just arrived belongs to nobody. Dispose it and touch NOTHING else —
      // retaining it, starting the owned tick loop, or re-applying the
      // feedStrudel canvas hide would all resurrect a layer that is meant to be
      // gone (the audit's "instanceRetained, ticks:1, pendingRafs:1").
      disposeHydraInstance(instance);
      // With feedStrudel, upstream hides #test-canvas from INSIDE the call we
      // just awaited — a hide belonging to a lifetime that has already ended.
      // Undo it unless a newer init has since taken ownership of the layer,
      // or the next `.pianoroll()` pattern draws into a hidden canvas.
      if (!hydraInstance) applyHydraFeedMode(false);
      return instance;
    }

    // Upstream returns a DIFFERENT renderer when the options changed. It removes
    // the old canvas but never destroys the old regl context, so switching e.g.
    // feedStrudel on leaked a live WebGL context. clearHydra() is NOT the tool
    // here — it would remove the canvas the NEW renderer just created.
    if (instance && previous && previous !== instance) disposeHydraInstance(previous);

    if (instance) hydraInstance = instance;
    // The MutationObserver has normally adopted and sized the canvas already
    // (it fires during getDrawContext, before initHydra's `await import`, which
    // is what lets the size land before the HydraRenderer constructor reads it).
    // Re-assert here now that the engine exists and setResolution is available.
    const canvas = getHydraCanvas();
    if (canvas) {
      adoptHydraCanvas(canvas);
      syncHydraCanvasSize(replSection.clientWidth, replSection.clientHeight);
    }
    // Both of these must run on the REUSED path too: upstream skips its whole
    // init block when the options are unchanged, so neither the feedStrudel
    // hide nor (had we left autoLoop on) a render loop would be re-established.
    applyHydraFeedMode(merged.feedStrudel === true);
    if (instance) startHydraTickLoop();
    return instance;
  });

  defineWrappedGlobal("H", (original) => (pattern: unknown) => {
    const sample = original(pattern);
    return () => {
      try {
        // Numbers pass through; a note becomes its MIDI number (c3 = 48) and
        // a frequency its MIDI pitch, so pitch can drive a shader
        // (src/shared/hap-number.ts). Until 0.5.12 those were flattened to 0.
        return hapNumber(sample());
      } catch {
        // Rest under the playhead — the zero-width query returns no hap and the
        // upstream H throws. Hydra calls this every frame, so one rest would
        // otherwise kill the shader while the audio kept going.
        return 0;
      }
    };
  });
}

/**
 * Put Strudel's own globals back after hydra-synth's makeGlobal took them.
 *
 * `speed` and `shape` are the ones that matter (they are Strudel controls a
 * pattern can call) and they stick — upstream clearHydra() re-asserts them too.
 * `time` does NOT stick: the REPL re-injects Hydra's sandbox props on every
 * later evaluation, so the bare `time` global stays Hydra's clock (NaN once the
 * renderer is destroyed). Nothing in Strudel's pattern API reads it — patterns
 * use getTime() — and a fresh initHydra() re-establishes it, so we restore what
 * we can and leave it there rather than fighting the sandbox with an accessor.
 *
 * Each key is isolated so one stubborn global cannot abort the rest of teardown.
 */
function restoreStrudelGlobals(): void {
  if (!strudelGlobals) return;
  const w = window as any;
  for (const [key, value] of Object.entries(strudelGlobals)) {
    if (value === undefined) continue;
    try {
      w[key] = value;
      if (w[key] === value) continue;
    } catch { /* accessor with no setter — redefine below */ }
    try {
      Object.defineProperty(w, key, {
        value,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    } catch { /* non-configurable: leave it, Strudel's API still works */ }
  }
}

/**
 * Release ONE HydraRenderer, whoever owns it.
 *
 * clearHydra() only hushes the renderer and drops its canvas; the regl context
 * (and everything the GPU is holding for it) survives, so destroy it explicitly.
 * Deliberately does not touch `hydraInstance` — this is also how a superseded
 * renderer is disposed while a newer one is being installed.
 */
function disposeHydraInstance(instance: any): void {
  if (!instance) return;
  try {
    instance.hush?.();
  } catch { /* already torn down */ }
  try {
    instance.regl?.destroy?.();
  } catch { /* regl may already be gone */ }
}

/**
 * Release the current HydraRenderer and give up ownership.
 * The next initHydra() builds a fresh one, having found no #hydra-canvas.
 */
function stopHydraInstance(): void {
  // Ours to cancel — upstream's autoLoop is off (see HYDRA_OWNED_LOOP). Stop it
  // BEFORE regl goes away so no frame renders into a destroyed context.
  stopHydraTickLoop();
  const instance = hydraInstance;
  hydraInstance = null;
  disposeHydraInstance(instance);
}

/** Stage or strike the Hydra layer for the pattern about to run. */
function setHydraActive(active: boolean): void {
  widgetState.setHydraActive(active);
  replSection.classList.toggle("hydra-on", active);
  // A previous `initHydra({ feedStrudel: true })` sets an INLINE display:none on
  // #test-canvas to hide the piano roll it is texturing. Nothing upstream ever
  // undoes that, so a later .pianoroll() pattern would draw into a hidden
  // canvas. Clear it on every staging; the initHydra wrapper re-applies it via
  // applyHydraFeedMode() if still asked — on the reused path as well as the
  // fresh one, which is the part upstream gets wrong.
  vizCanvas.style.removeProperty("display");
  if (active) return;

  // Striking the layer ends the current Hydra lifetime: an initHydra() still
  // awaiting its CDN import must NOT install what it eventually resolves to.
  hydraGeneration++;

  // Pattern no longer uses Hydra: stop its render loop so a stale shader doesn't
  // keep the GPU busy under the code. Leave NO #hydra-canvas behind — its
  // presence is what would make the next initHydra() a no-op.
  stopHydraTickLoop();
  try {
    (window as any).clearHydra?.();
  } catch { /* hydra never initialised — nothing to clear */ }
  stopHydraInstance();
  restoreStrudelGlobals();
  getHydraCanvas()?.remove();
}

// =============================================================================
// Editor theme + the theme-derived visuals scrim  (`theme` tool parameter)
//
// @strudel/codemirror's activateTheme() (reached via StrudelMirror's
// updateSettings({ theme })) does two things: it reconfigures the CodeMirror
// theme extension, and it writes the theme's palette onto :root as
// `--background`, `--foreground`, … with !important. That second effect is what
// makes a theme-aware scrim possible without shipping our own copy of 39
// palettes — we read the variable back out of the cascade.
//
// Verified in the dev harness against the live @strudel/repl@1.3.0 bundle:
// `--background` goes #222 (strudelTheme) → #fff (githubLight).
// =============================================================================

/** The theme currently applied, so a re-render doesn't reconfigure needlessly. */
let currentTheme: string | null = null;
/** Theme requested by the most recent tool input, applied once an editor exists. */
let pendingTheme: string | undefined;

/** The REPL's own default, applied when a pattern asks for no theme. */
const DEFAULT_EDITOR_THEME = "strudelTheme";

/**
 * Apply one editor setting WITHOUT saving it.
 *
 * StrudelMirror.updateSettings() also writes the whole settings object to the
 * REPL's "codemirror-settings" localStorage entry, which every later
 * <strudel-editor> on the same origin starts from — so one
 * `theme: "githubLight"` call used to recolour later widgets that asked for no
 * theme. changeSetting() reconfigures the same extension (and, for "theme",
 * runs the same activateTheme()) and stores nothing.
 */
function changeEditorSetting(editor: any, key: string, value: unknown): void {
  if (typeof editor?.changeSetting === "function") {
    editor.changeSetting(key, value);
  } else if (typeof editor?.updateSettings === "function") {
    // Older REPL shape. updateSettings() reads fontSize/fontFamily off the
    // object it is given, so merge over the element's current settings. This
    // path DOES persist (it is the only setter those REPLs have); the pinned
    // @strudel/repl@1.3.0 has changeSetting() and never reaches it.
    const base = (editorEl as any)?.settings ?? {};
    editor.updateSettings({ ...base, [key]: value });
  }
}

function applyEditorTheme(editor: any, theme: string | undefined): void {
  // Always apply one — the default when none was asked for — so a widget never
  // inherits a theme some earlier widget left in storage.
  const wanted = theme || DEFAULT_EDITOR_THEME;
  if (wanted !== currentTheme) {
    try {
      changeEditorSetting(editor, "theme", wanted);
      currentTheme = wanted;
    } catch {
      // An unknown name is non-fatal upstream (activateTheme warns and falls
      // back to strudelTheme); the scrim below still follows whatever landed.
    }
  }
  syncVizTheme();
}

// -----------------------------------------------------------------------------
// Line wrapping and narrow stages (phones)
//
// The REPL's defaults are for a desktop page: 18px monospace, no line wrapping.
// In a chat widget every line longer than the frame ran off the right edge,
// reachable only by panning inside the editor, so the editor ALWAYS wraps, as
// strudel.cc does on a phone. A compact stage also gets a smaller font. Nothing
// is saved, and a wider stage (rotation, fullscreen) puts the element's own
// font size back.
//
// Compact is decided by the frame's width, but not only: 0.5.8 wrapped below
// NARROW_STAGE_PX in the dev harness at 380px, yet not in Claude iOS, so the
// phone host's frame is evidently not always as narrow as the screen. A host
// that says it is mobile, or a coarse pointer on a phone-sized screen, counts.
// -----------------------------------------------------------------------------

const NARROW_STAGE_PX = 520;
const NARROW_FONT_SIZE = 14;
/** The mode last applied to the current editor; null until it has had one. */
let editorCompact: boolean | null = null;

function isCompactStage(width: number): boolean {
  if (width < NARROW_STAGE_PX) return true;
  try {
    if (app.getHostContext()?.platform === "mobile") return true;
    return (
      window.matchMedia("(pointer: coarse)").matches &&
      Math.min(screen.width, screen.height) < NARROW_STAGE_PX
    );
  } catch {
    return false;
  }
}

function syncEditorToWidth(): void {
  const editor = getEditor();
  const width = replSection.clientWidth;
  if (!editor || width === 0) return;
  const compact = isCompactStage(width);
  if (compact === editorCompact) return;
  const first = editorCompact === null;
  editorCompact = compact;
  const own = (editorEl as any)?.settings ?? {};
  try {
    if (first) changeEditorSetting(editor, "isLineWrappingEnabled", true);
    // A fresh editor already has its own font size; only a change needs one.
    if (compact || !first) {
      changeEditorSetting(editor, "fontSize", compact ? NARROW_FONT_SIZE : (own.fontSize ?? 18));
    }
  } catch { /* cosmetic — the editor still works at its own settings */ }
}

// =============================================================================
// Pattern title  (`title` tool parameter)
// =============================================================================

let patternTitle = "";

function setPatternTitle(title: unknown): void {
  patternTitle = typeof title === "string" ? title.trim() : "";
  titleEl.textContent = patternTitle;
  titleEl.title = patternTitle;
  titleEl.hidden = patternTitle.length === 0;
}

/** Filename stem for the WAV export: the pattern's title, or a neutral default. */
function recordingFileStem(): string {
  return sanitizeFileStem(patternTitle, "strudel-recording");
}

// =============================================================================
// Evaluation — staging, and honest reporting of async eval failures
//
// StrudelMirror.evaluate() in @strudel/repl@1.3.0 is
//
//     async evaluate(shouldPlay = true) { this.flash(); await this.repl.evaluate(this.code, shouldPlay); }
//
// Two things follow. It takes NO code argument — it always evaluates the LIVE
// buffer `this.code` — and it never rejects: repl.evaluate() catches everything
// and parks the failure on `repl.state.evalError` (an Error) while logging
// "[eval] error: …" to the console. A try/catch around the call therefore sees
// nothing, which is how a broken pattern used to sit at "Playing..." forever.
//
// So we wrap the instance method. All evaluation paths — our Play button, the
// tool-input render, and the editor's own Ctrl+Enter keybinding (which calls
// `this.evaluate()`, an instance-property lookup, so the wrapper wins) — go
// through one place that stages the visuals for the code about to run and then
// reports the real outcome to the status line and to the model.
// =============================================================================

/** Whether the scheduler is actually running (not what we hoped it would do). */
function isSchedulerStarted(): boolean {
  return getEditor()?.repl?.state?.started === true;
}

/**
 * A master limiter between superdough's output and the speakers — a safety
 * default the brief asked for, and needed: with the worklet effects loading,
 * crush/coarse layers drove the gallery's glitch piece to peak 2.36 (hard
 * clipping). Idempotent per output node (superdough rebuilds it on reset).
 */
const limiters = new WeakMap<object, DynamicsCompressorNode>();
/** The limiter on the current master, if installed — the recorder taps its output. */
function currentLimiter(): DynamicsCompressorNode | null {
  const master = (window as any).getSuperdoughAudioController?.()?.output?.destinationGain;
  return (master && limiters.get(master)) ?? null;
}
function ensureLimiter(): void {
  try {
    const ctx: AudioContext | undefined = (window as any).getAudioContext?.();
    const master: AudioNode | undefined = (window as any).getSuperdoughAudioController?.()?.output?.destinationGain;
    if (!ctx || !master?.connect || limiters.has(master)) return;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    master.disconnect(ctx.destination);
    master.connect(limiter);
    limiter.connect(ctx.destination);
    limiters.set(master, limiter);
  } catch (err) {
    console.warn("[strudel] master limiter not installed:", err);
  }
}

/** Load superdough's AudioWorklets once (bounded wait; a failure only costs those sounds). */
let workletsReady: Promise<void> | null = null;
function ensureWorklets(): Promise<void> {
  const load = (window as any).loadWorklets;
  if (typeof load !== "function") return Promise.resolve();
  workletsReady ??= Promise.race([
    Promise.resolve()
      .then(() => load())
      .catch((err: unknown) => {
        console.warn("[strudel] AudioWorklets did not load:", err);
        workletsReady = null; // retry on the next evaluation
      }),
    new Promise<void>((resolve) => setTimeout(resolve, 3000)),
  ]).then(() => undefined);
  return workletsReady;
}

/** What tilt()/mic() can do in THIS frame, measured — not assumed. */
function describeSensor(sensor: "tilt" | "mic", state: { state: string; detail?: string }): string {
  const what = sensor === "tilt" ? "tilt (motion sensor)" : "mic (microphone loudness)";
  switch (state.state) {
    case "live":
      return `${what}: LIVE — readings are arriving from the device`;
    case "waiting":
      return `${what}: waiting for the user's first tap to ask permission; until then it is played by hand on the strip`;
    case "listening":
      return `${what}: asked, but no readings have arrived — in a chat widget the host's frame usually blocks it; the performer plays it by hand on the strip`;
    case "denied":
      return `${what}: refused here (${state.detail ?? "denied"}) — the host's frame or the user blocked it; it is played by hand on the strip. A share link opens a page where it may be allowed`;
    case "unsupported":
      return `${what}: this browser has no such sensor — played by hand on the strip`;
    default:
      return `${what}: not in use`;
  }
}

function sensorNotes(code: string): string {
  const states = stage.sensorStates();
  const parts: string[] = [];
  if (/tilt\s*\(/.test(code)) parts.push(describeSensor("tilt", states.tilt));
  if (/mic\s*\(/.test(code)) parts.push(describeSensor("mic", states.mic));
  return parts.join("; ");
}

/** Tell the model when a sensor's state CHANGES (a tap granted it, a host refused it) — once per state. */
const reportedSensor: Record<string, string> = {};
const sensorSilenceTimer: Record<string, ReturnType<typeof setTimeout> | undefined> = {};
/** "Asked but nothing arrived" is only news if it stays that way this long. */
const SENSOR_SILENCE_MS = 3000;
function reportSensor(sensor: "tilt" | "mic", state: { state: string; detail?: string }): void {
  clearTimeout(sensorSilenceTimer[sensor]);
  if (state.state === "off" || state.state === "waiting") return;
  if (state.state === "listening") {
    sensorSilenceTimer[sensor] = setTimeout(() => {
      if (stage.sensorStates()[sensor].state === "listening") sayOnce(sensor, state);
    }, SENSOR_SILENCE_MS);
    return;
  }
  sayOnce(sensor, state);
}
function sayOnce(sensor: "tilt" | "mic", state: { state: string; detail?: string }): void {
  const key = `${state.state}:${state.detail ?? ""}`;
  if (reportedSensor[sensor] === key) return;
  reportedSensor[sensor] = key;
  reportToModel(`Strudel widget: ${describeSensor(sensor, state)}.`);
}

/** Bumped by every evaluation, so a stale one can tell if a newer one began. */
let evaluationSeq = 0;
/** Settles when the evaluation in flight is done; the next one queues on it. */
let evaluationTail: Promise<void> = Promise.resolve();
/** How long a queued evaluation waits for a predecessor that never finishes. */
const EVALUATION_QUEUE_MAX_WAIT_MS = 10_000;

/**
 * Did a cancel, a teardown or a newer tool input take over (renderGeneration
 * moved) while this evaluation was in flight?
 *
 * repl.evaluate() transpiles and evaluates asynchronously and only calls
 * scheduler.setPattern(…, autostart) at its END, so a cancel's stop() ran
 * BEFORE this start: the cancelled pattern played anyway, the status flipped
 * to "Playing..." and the model was told "playing" (measured in the dev
 * harness, a cancel during a Hydra pattern's evaluation).
 *
 * So a stale evaluation stops what it started — unless a newer evaluation has
 * begun since, which owns the scheduler now — and reports NOTHING: the
 * canceller owns the status and the model context.
 */
function evaluationSuperseded(editor: any, generation: number, seq: number): boolean {
  if (generation === renderGeneration) return false;
  if (seq === evaluationSeq && isSchedulerStarted()) {
    // Not playing FIRST, so the stop's `update` event is a no-op for the state
    // listener and cannot write "Ready" over the canceller's status.
    widgetState.setIsPlaying(false);
    widgetState.setAudioBlocked(false);
    audibleStatus = null;
    try {
      editor.stop?.();
    } catch { /* already stopped */ }
    // Its shader, if it started one, belongs to the cancelled pattern too.
    setHydraActive(false);
    renderPlayButton();
    // The start this evaluation made may have queued a report; let it settle
    // on "stopped", which says nothing unless the model was told otherwise.
    scheduleStateReport();
  }
  return true;
}

/**
 * Wrap this StrudelMirror instance's evaluate() once, so every evaluation —
 * ours and the user's Ctrl+Enter — stages visuals and reports its outcome.
 */
function installEvaluateHook(editor: any): void {
  if (editor.__musicStudioHooked) return;
  editor.__musicStudioHooked = true;
  const original = editor.evaluate.bind(editor);
  // remember() state applied at setPattern (hookSchedulerForEarlyState below).
  let earlyStateToken: number | null = null;
  // The renderGeneration the early-state evaluation began in: a cancel moves it.
  let earlyStateGeneration = -1;
  let evaluationsInFlight = 0;
  const hookedSchedulers = new WeakSet<object>();
  editor.evaluate = async (shouldPlay?: unknown) => {
    companion?.stop();
    const byPress = playPressIntent;
    playPressIntent = false;
    // Taken synchronously: it belongs to this call and no other.
    const forSwap = swapEvaluation;
    swapEvaluation = null;
    // A press of Play / Ctrl+Enter replaces any swap or update still waiting
    // for its bar (it answers "replaced") — what the docs promise (Kimi review).
    if (byPress) sessionApplySeq++;
    // Checked after every await below (evaluationSuperseded).
    const generation = renderGeneration;
    // One evaluation at a time. repl.evaluate() installs its pattern only when
    // it FINISHES, so two in flight finished in either order: a cancelled one
    // still loading hydra-synth that landed after a newer one replaced the
    // newer pattern (and shader) and stayed audible. Queued, a stale
    // evaluation finishes while it is still the latest, and stops itself.
    const previous = evaluationTail;
    let finished!: () => void;
    evaluationTail = new Promise<void>((resolve) => {
      finished = resolve;
    });
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        previous,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, EVALUATION_QUEUE_MAX_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
      // Cancelled (or replaced by a newer tool call) while queued: never start.
      if (generation !== renderGeneration) return;
      await evaluateNow(shouldPlay, generation, byPress, forSwap);
    } finally {
      finished();
    }
  };

  /**
   * remember() state must be stored before the scheduler's first query of a
   * new pattern. Repl.evaluate installs it with scheduler.setPattern — and a
   * stopped player starts and queries right there (Codex review) — so the
   * scheduler's setPattern applies the evaluation's state first. Only when
   * exactly ONE evaluation is in flight: with two, the call can't be tied to
   * its evaluation (a stalled run must never apply a newer one's state — the
   * 0.8 splice lesson), and the state applies at the commit as before — so
   * with overlapping evaluations (rare: they queue; only one that waited past
   * EVALUATION_QUEUE_MAX_WAIT_MS overlaps) the first query of the new pattern
   * can hear the previous state for one scheduler tick. Accepted (Codex,
   * round 3: #1 partial).
   * A quantized swap never uses it: its state lands at the bar.
   *
   * The activation is PROVISIONAL (remember-store): a cancel or a newer run
   * after this point rolls it back; only the commit announces its merges.
   * An evaluation already cancelled (renderGeneration moved) skips it.
   */
  function hookSchedulerForEarlyState(scheduler: any): void {
    if (!scheduler || hookedSchedulers.has(scheduler) || typeof scheduler.setPattern !== "function") return;
    hookedSchedulers.add(scheduler);
    const install = scheduler.setPattern;
    scheduler.setPattern = function (this: unknown, ...args: unknown[]) {
      const token = earlyStateToken;
      if (token !== null && evaluationsInFlight === 1 && earlyStateGeneration === renderGeneration) {
        earlyStateToken = null;
        try {
          stage.activateStateNow(token);
        } catch (error) {
          console.error("[stage] remember() state could not apply early:", error);
        }
      }
      return install.apply(this, args);
    };
  }

  async function evaluateNow(
    shouldPlay: unknown,
    generation: number,
    byPress = false,
    forSwap: SwapEvaluation | null = null,
  ): Promise<void> {
    /** A swap evaluation whose code is no longer the buffer, or that was superseded, must not run. */
    const swapStale = () =>
      !!forSwap && (forSwap.seq !== sessionApplySeq || (typeof editor.code === "string" && editor.code !== forSwap.code));
    if (swapStale()) {
      forSwap!.refused = true;
      return;
    }
    const seq = ++evaluationSeq;
    // Idempotent, and cheap once it has taken. It must run here rather than at
    // CDN load: initHydra/H only land on globalThis when the REPL's eval scope
    // is published, which is after <strudel-editor> initialises.
    installEvalScopeHooks();
    snapshotStrudelGlobals();
    const code = typeof editor.code === "string" ? editor.code : currentCode;
    stageVisuals(code);
    // A fresh pattern gets a fresh missing-sound report.
    resetMissingSounds();
    // superdough loads its AudioWorklets (supersaw, pulse, crush, djf, …) only
    // on the first mousedown AFTER Strudel loaded — so a piece that started
    // without one played those silent, and a .djf() anywhere silenced its
    // whole orbit (measured). Loading them needs no gesture: do it here.
    await ensureWorklets();
    // This evaluation's onFrame/onEvent/onTap go live only if it succeeds.
    const stageToken = stage.begin();
    speechFailureReported = false;
    // A voiced piece that is about to START: evaluate it without starting,
    // let its say() clips load, then start — superdough drops a sample that is
    // not decoded by its start time, so a line in bar 0 used to be lost on the
    // first play. (A re-evaluation of a running piece keeps playing.)
    const holdForVoice = shouldPlay !== false && /\b(?:say|sing)\s*\(/.test(code) && !isSchedulerStarted();
    // A swap lands on its bar: the scheduler gets the old pattern until the
    // boundary and this one from it (src/shared/splice.ts). Only the
    // evaluation the swap asked for: another run that slips in first must not
    // be spliced at its bar (Kimi review).
    // Last check, right before the editor reads its buffer (synchronously, in
    // original()): the awaits above are where a newer swap could write it.
    if (swapStale()) {
      forSwap!.refused = true;
      stage.rollback(stageToken);
      return;
    }
    const splice = forSwap && forSwap.boundary !== null ? { boundary: forSwap.boundary } : null;
    const previousPattern = splice ? editor.repl?.scheduler?.pattern : null;
    // Without a swap the new pattern is queried as soon as it is installed —
    // inside original() when a stopped player starts — so its remember() state
    // is applied right before that (setPattern), not at the commit below.
    hookSchedulerForEarlyState(editor.repl?.scheduler);
    evaluationsInFlight++;
    earlyStateToken = splice ? null : stageToken;
    earlyStateGeneration = generation;
    try {
      await original(holdForVoice ? false : shouldPlay !== false);
    } catch (err) {
      stage.rollback(stageToken);
      if (evaluationSuperseded(editor, generation, seq)) return;
      reportEvaluation(code, err as Error);
      return;
    } finally {
      evaluationsInFlight--;
      if (earlyStateToken === stageToken) earlyStateToken = null;
    }
    // Splice AFTER the evaluation, onto the pattern it installed: nothing is
    // patched while it runs, so a stalled evaluation can't hand its splice to
    // another one (Codex review). Only microtasks separate setPattern from
    // here, so no scheduler tick has queried the new pattern yet.
    let stateAtBar = false;
    if (splice && !readEvalError() && !evaluationSuperseded(editor, generation, seq)) {
      stateAtBar = applySplice(editor, previousPattern, splice.boundary, () => stage.activateState(stageToken, splice.boundary));
    }
    if (evaluationSuperseded(editor, generation, seq)) {
      stage.rollback(stageToken);
      return;
    }
    // A pattern that failed keeps the old one playing — and its layers, and
    // its stage loops.
    if (!readEvalError()) {
      noteHumanEdit(code);
      pruneDrawLayers(code);
      // remember() resets and merges land on the swap's bar, with the music.
      stage.commit(stageToken, { deferState: stateAtBar });
      // Before the report below goes out: the share page reads it on that report.
      if (byPress && shouldPlay !== false) playPressed = true;
      logControlSurface();
      stageErrorReported = false;
      if (holdForVoice) {
        setStatus("Loading voice…", "normal");
        await stageSpeechReady(SAY_PRELOAD_TIMEOUT_MS);
        if (evaluationSuperseded(editor, generation, seq)) return;
        try {
          editor.repl?.start?.();
        } catch { /* the state listener reports what actually happened */ }
        // start() flips repl.state.started asynchronously; the one report this
        // evaluation makes must not say "loaded, not playing" over audible
        // music (measured: it did, and the status stayed "Ready").
        for (let waited = 0; !isSchedulerStarted() && waited < 1000; waited += 25) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (evaluationSuperseded(editor, generation, seq)) return;
      }
    } else {
      stage.rollback(stageToken);
    }
    // Some of the clobbered globals (`time`) are only published onto globalThis
    // by the evaluation itself, so the pre-eval snapshot above cannot see them
    // on a cold widget. This second pass catches them, and no-ops once a
    // pattern has initialised Hydra (after which they are Hydra's, not
    // Strudel's). A widget whose FIRST pattern uses Hydra therefore has no
    // Strudel value to put back — nothing observable depends on it.
    snapshotStrudelGlobals();
    // The pattern owns the `setcps` name, so the requested bpm could not be
    // written into the source — apply it now that the scheduler is up.
    const tempoAtRuntime = applyRuntimeTempo();
    ensureLimiter();
    // A context that is only still starting gets a moment to come up, so the
    // one report this evaluation makes says "blocked" only when it is.
    if (isSchedulerStarted()) await ensureAudioRunning(AUDIO_SETTLE_MS);
    if (evaluationSuperseded(editor, generation, seq)) return;
    reportEvaluation(code, null, tempoAtRuntime);
  }
}

/**
 * <strudel-editor> dispatches an `update` CustomEvent carrying the whole repl
 * state whenever it changes. We report outcomes from the evaluate wrapper (one
 * message per evaluation), so this listener handles the state changes we did
 * NOT initiate — a pattern calling hush(), the scheduler stopping — keeping the
 * Play button honest and telling the model the music has stopped (debounced, and
 * skipped when the evaluate report already said so). It touches the status
 * text only to say a stop happened, and never over an error.
 */
function installStateListener(element: HTMLElement): void {
  if ((element as any).__musicStudioStateHooked) return;
  (element as any).__musicStudioStateHooked = true;
  element.addEventListener("update", (event) => {
    const started = (event as CustomEvent).detail?.started;
    if (typeof started !== "boolean" || started === widgetState.isPlaying) return;
    widgetState.setIsPlaying(started);
    // The scheduler's clock has created the context by now; follow its state.
    if (started) watchAudioContext(replAudioContext());
    widgetState.setAudioBlocked(started && audioIsBlockedNow());
    if (!started) {
      audibleStatus = null;
      // A stop from the editor itself (Ctrl+., hush()) — clear the layers too.
      clearDrawLayers();
    }
    renderPlayButton();
    // A stop nobody announced (hush(), the editor's own stop key) left the
    // status reading "Playing..." over silence. An error stays up, and so does
    // the recording status.
    if (!started && !widgetState.isRecording && !statusEl.classList.contains("error")) {
      setStatus("Ready", "normal");
    }
    scheduleStateReport();
  });
}

// =============================================================================
// Pattern Rendering
// =============================================================================

/**
 * Show a visible retry affordance when the Strudel REPL CDN script fails to
 * load. Re-runs the last pattern (or a no-op message) on click instead of
 * leaving the widget at a dead-end error status.
 */
function showCdnError(): void {
  container.replaceChildren();
  // The previous <strudel-editor> (if any) was just detached — drop the ref so
  // a retry creates a fresh element instead of calling setCode on a dead node.
  editorEl = null;
  const box = document.createElement("div");
  box.className = "cdn-error";

  const msg = document.createElement("p");
  msg.textContent =
    "Couldn't load the Strudel player (network or CDN issue).";
  box.appendChild(msg);

  const retry = document.createElement("button");
  retry.className = "retry-btn";
  retry.textContent = "Retry loading";
  retry.setAttribute("aria-label", "Retry loading Strudel player");
  retry.addEventListener("click", () => {
    if (lastRenderArgs) {
      renderPattern(lastRenderArgs);
    }
  });
  box.appendChild(retry);

  container.appendChild(box);
}

/**
 * Create the <strudel-editor> element if it isn't there yet.
 *
 * Built programmatically (no innerHTML sink); the code goes in through the safe
 * editor.setCode() API. Shared by renderPattern() and the streaming path below,
 * which both need "an element exists" without caring who made it.
 */
function ensureEditorElement(): void {
  if (editorEl) return;
  const el = document.createElement("strudel-editor");
  container.replaceChildren(el);
  editorEl = el;
  // A fresh element starts from its own settings, not the last one's.
  currentTheme = null;
  editorCompact = null;
}

/** One-time per-editor setup: eval hook, prebake watch, theme, layout. */
async function prepareEditor(): Promise<any> {
  ensureEditorElement();
  const editor = await waitForEditor();
  // Route every evaluation (ours and the user's Ctrl+Enter) through one hook.
  installEvaluateHook(editor);
  installEvalScopeHooks();
  if (editorEl) installStateListener(editorEl);
  // The editor owns the single prebake() — observe it for the soundfont warning.
  watchPrebake(editor);
  // Theme first, then the scrim derived from it.
  applyEditorTheme(editor, pendingTheme);
  syncEditorToWidth();
  // Make `a` resolvable in the eval scope from the very first evaluation.
  installAudioReactiveGlobals();
  // Fix the broken layout (hide canvas, ensure editor visible)
  fixLayout();
  // Re-check layout after a short delay (canvas may be created lazily)
  setTimeout(fixLayout, 500);
  setTimeout(fixLayout, 1500);
  return editor;
}

// -----------------------------------------------------------------------------
// Streaming boot
//
// ontoolinputpartial arrives while the model is still writing the pattern. On
// the FIRST tool call there is no editor yet and the CDN hasn't been fetched, so
// every partial chunk used to be dropped on the floor and the user watched an
// empty box until the whole pattern landed. Start the load on the first partial
// instead (the ABC widget does the same), and fill the buffer as it streams.
// -----------------------------------------------------------------------------

let streamingBoot: Promise<void> | null = null;
let pendingPartialCode = "";

function startStreamingBoot(): Promise<void> {
  if (streamingBoot) return streamingBoot;
  const generation = renderGeneration;
  streamingBoot = (async () => {
    try {
      await loadStrudelCDN();
      if (generation !== renderGeneration) return;
      const editor = await prepareEditor();
      // A real tool input (or a teardown) landed while we were booting — it owns
      // the buffer now, so don't write a half-streamed pattern over it.
      if (generation !== renderGeneration) return;
      if (pendingPartialCode) editor.setCode(pendingPartialCode);
    } catch {
      // Speculative: renderPattern() runs the real load with its own error
      // surface (including the CDN retry affordance). Clear the memo so a
      // failure here can't wedge the actual render behind a rejected promise.
      streamingBoot = null;
    }
  })();
  return streamingBoot;
}

/**
 * @param permit a tool call's autoplay also waits for this: false when the
 *   host rebuilt a widget this view already autoplayed in (src/view-memory.ts).
 */
async function renderPattern(args: Record<string, unknown>, permit?: Promise<boolean>, canReplace?: () => boolean, onCommit?: () => void) {
  const code = args.code as string | undefined;
  if (!code) return;

  // Every overlapping tool input gets its own generation; the older one stops
  // at its next checkpoint instead of writing into a buffer it no longer owns.
  const generation = ++renderGeneration;
  const pressesAtRender = playPresses;
  const superseded = () => generation !== renderGeneration;

  const bpm = args.bpm as number | undefined;
  const autoplay = args.autoplay as boolean | undefined;
  const commitMetadata = () => {
    lastRenderArgs = args;
    pendingTheme = typeof args.theme === "string" ? args.theme : undefined;
    setPatternTitle(args.title);
  };
  // Native/local edits commit source and musical settings together, after the
  // live-buffer guard. Ordinary tool rendering retains its existing timing.
  if (!canReplace) commitMetadata();

  try {
    setStatus("Loading Strudel...");
    // A streaming boot may already be loading the CDN and building the editor —
    // let it finish rather than racing it with a second <strudel-editor>.
    if (streamingBoot) {
      await streamingBoot.catch(() => { /* falls through to the real load */ });
      if (superseded()) return;
    }
    try {
      await loadStrudelCDN();
    } catch (cdnErr) {
      if (superseded()) return;
      setStatus("Failed to load Strudel — click Retry", "error");
      showCdnError();
      return;
    }
    if (superseded()) return;

    let finalCode = code;
    let nextRuntimeCps: number | null = null;
    if (bpm) {
      const tempo = injectTempo(finalCode, bpm);
      finalCode = tempo.code;
      // String compare, so this still builds against a tempo.ts whose policy
      // union predates the branch.
      if ((tempo.policy as string) === "unchanged-ambiguous") {
        nextRuntimeCps = tempo.cps;
      }
    }
    // Fold in the `visuals` preset AFTER the tempo injection, so a Hydra recipe
    // keeps `await initHydra()` on the first line where the engine expects it.
    // Reduced motion drops the Hydra presets (a WebGL shader is exactly the
    // continuous animation that setting is asking us not to start).
    const reduced = prefersReducedMotion();
    const skippedForMotion =
      reduced && typeof args.visuals === "string" && args.visuals.startsWith("hydra-");
    finalCode = applyVisualPreset(finalCode, args.visuals, { allowHydra: !reduced });
    const commitSource = () => {
      widgetState.setSentCode(code);
      runtimeCps = nextRuntimeCps;
      widgetState.setHydraPresetSkippedForMotion(skippedForMotion);
      currentCode = finalCode;
      pendingPartialCode = "";
      stageVisuals(finalCode);
    };

    // Auto-reveal the visuals when the pattern includes a viz method, unless the
    // user has taken manual control of the "Visuals" toggle. (stageVisuals also
    // runs from the evaluate hook, so a Ctrl+Enter on hand-edited code stages
    // too; doing it here as well keeps autoplay:false patterns showing the
    // backdrop they asked for.)
    if (!canReplace) commitSource();

    setStatus("Initializing...");
    const editor = await prepareEditor();
    if (superseded()) return;

    if (canReplace && !canReplace()) {
      setStatus("The editor changed while loading. Read the current session before editing again.", "error");
      return;
    }

    if (canReplace) {
      commitMetadata();
      commitSource();
      applyEditorTheme(editor, pendingTheme);
    }

    editor.setCode(finalCode);
    lastProgrammaticCode = finalCode;
    onCommit?.();

    // Enable recording once pattern is loaded
    if (!widgetState.isRecording) {
      recordBtn.disabled = false;
      videoBtn.disabled = false;
    }

    // Surface a non-blocking warning if soundfont registration failed —
    // explains silent/absent audio rather than swallowing it.
    const soundfontNote = widgetState.soundfontWarning
      ? " (soundfonts unavailable — audio may be silent)"
      : "";

    const mayAutoplay = autoplay !== false && (permit ? await permit : true);
    if (superseded()) return;
    // The user pressed Play while we waited: what plays is theirs to decide.
    if (playPresses !== pressesAtRender) return;
    if (mayAutoplay) {
      setStatus("Evaluating...");
      // The hook reports the real outcome (including async eval failures) to the
      // status line and the model — no optimistic "Playing..." here.
      await editor.evaluate(true);
    } else {
      setStatus(`Ready — click Play or Ctrl+Enter${soundfontNote}`, "normal");
    }
  } catch (err) {
    if (superseded()) return;
    setStatus(`Error: ${(err as Error).message}`, "error");
  }
}

// =============================================================================
// Controls
// =============================================================================

/**
 * Play presses that reached an editor. A tool call's autoplay that is still
 * waiting for its permit stands down if the user pressed Play meanwhile — a
 * late autoplay would restart a pattern they had stopped.
 */
let playPresses = 0;

playBtn.addEventListener("click", (event) => void pressPlay(event.isTrusted));

/** The Play button's press — also the watch page's tap-to-start. */
async function pressPlay(trusted: boolean): Promise<void> {
  const editor = getEditor();
  if (!editor) return;
  playPresses++;
  // resume() runs here, synchronously inside the gesture — the only place
  // WebKit honours it. Evaluation below does not wait for it.
  const audioRunning = ensureAudioRunning();
  // The capture-phase gesture listener may already have unlocked audio before
  // this click arrived, so ask what the gesture STARTED over, not the live state.
  const action = playTapAction(widgetState.isPlaying, gestureLatch.consume() || widgetState.audioBlocked);
  try {
    if (action === "resume-audio") {
      // The pattern is already running over a suspended context: this tap means
      // "let me hear it". statechange restores the status once audio runs; if
      // the browser still refuses, "Tap Play to start audio" stays up.
      await audioRunning;
      syncAudioState();
    } else if (action === "stop") {
      if (widgetState.isRecording) stopRecording();
      editor.stop();
      updatePlayState(false);
      // The model was last told "playing"; say the music has stopped.
      scheduleStateReport();
    } else {
      // evaluate() always runs the LIVE buffer (editor.code), so a pattern the
      // user edited in the REPL is what plays. The hook stages its visuals and
      // reports the outcome, so there is no optimistic state to set here.
      setStatus("Evaluating...");
      // Armed right before the call that consumes it (synchronously, on entry).
      playPressIntent = trusted;
      await editor.evaluate(true);
    }
  } catch (err) {
    setStatus(`Playback error: ${(err as Error).message}`, "error");
  }
}

// The editor's own evaluate keys (Ctrl/Cmd/Alt+Enter), pressed INSIDE the
// editor: its keymap calls evaluate() synchronously during this same keydown,
// which takes the intent on entry. Cleared after the event, so a press that
// evaluated nothing can't be claimed by a later programmatic run (Kimi review).
container.addEventListener(
  "keydown",
  (event) => {
    if (!event.isTrusted || event.key !== "Enter" || !(event.ctrlKey || event.metaKey || event.altKey)) return;
    if (!(event.target instanceof Element) || !event.target.closest(".cm-editor")) return;
    playPressIntent = true;
    setTimeout(() => {
      playPressIntent = false;
    }, 0);
  },
  { capture: true },
);

recordBtn.addEventListener("click", () => {
  if (widgetState.isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
});

videoBtn.addEventListener("click", () => {
  if (videoBtn.getAttribute("aria-disabled") === "true") {
    // No downloadFile here (Claude's phone apps): the share page saves files.
    setStatus("Videos can't be saved in this app — ask Claude for a share link and record on that page", "normal");
  } else if (widgetState.isRecording) {
    stopRecording();
  } else {
    startRecording("video");
  }
});

downloadBtn.addEventListener("click", () => {
  handleDownload();
});

// Send the user's CURRENT (possibly edited) pattern back to the conversation.
sendBtn.addEventListener("click", async () => {
  const code = getLiveCode().trim();
  if (!code) return;
  sendBtn.disabled = true;
  try {
    await app.sendMessage({
      role: "user",
      content: [
        {
          type: "text",
          text: "Here's my edited Strudel pattern:\n```\n" + code + "\n```",
        },
      ],
    });
  } catch (err) {
    setStatus(`Send failed: ${(err as Error).message}`, "error");
  } finally {
    sendBtn.disabled = false;
  }
});

// Fullscreen toggle.
//
// The call was fire-and-forget, so a host that declines (or doesn't implement
// the method at all — it answers -32601) produced an unhandled rejection and no
// feedback: the button looked broken. Await it, report what the host actually
// granted, and leave the inline layout working either way — fullscreen is an
// enhancement to the stage, never a requirement for it.
fullscreenBtn.addEventListener("click", () => {
  void toggleDisplayMode();
});

/** The mode the host says we are in; drives the toggle and the button state. */
let displayMode: "inline" | "fullscreen" | "pip" = "inline";
let availableDisplayModes: readonly string[] | null = null;

/**
 * Size the stage to the host's container (src/frame-size.ts). Inline it is a
 * FIXED height — the host's max or a share of the screen — and the code
 * scrolls inside it, so the frame can never grow to the length of the pattern
 * (which is what put the visuals below the fold). Fullscreen or a fixed
 * container, it fills the frame. The canvases follow via the ResizeObserver.
 */
function syncFrameSize(): void {
  applyFrameSize(
    resolveFrameSize(
      { ...app.getHostContext(), displayMode },
      screenAvailHeight(),
      STRUDEL_INLINE_CAP,
    ),
  );
}
syncFrameSize();

function syncFullscreenButton(): void {
  const isFullscreen = displayMode === "fullscreen";
  fullscreenBtn.classList.toggle("active", isFullscreen);
  fullscreenBtn.setAttribute("aria-pressed", String(isFullscreen));
  fullscreenBtn.title = isFullscreen ? "Leave fullscreen" : "Toggle fullscreen";
}

async function toggleDisplayMode(): Promise<void> {
  const wanted = displayMode === "fullscreen" ? "inline" : "fullscreen";
  if (availableDisplayModes && !availableDisplayModes.includes(wanted)) {
    setStatus(`This host doesn't offer ${wanted} mode — using the inline layout`, "normal");
    return;
  }
  try {
    const result = await app.requestDisplayMode({ mode: wanted });
    // Trust what was GRANTED, not what was asked for.
    if (result?.mode) displayMode = result.mode;
    syncFullscreenButton();
    syncFrameSize();
    // A host may answer with the mode it kept: say so, or the button looks broken.
    if (wanted === "fullscreen" && displayMode !== "fullscreen") {
      setStatus("This host kept the inline layout — fullscreen isn't available here", "normal");
    }
    // Fullscreen changes the frame, so the backdrop needs a new backing store.
    requestAnimationFrame(syncVizCanvasSize);
  } catch {
    setStatus("Fullscreen isn't available here — using the inline layout", "normal");
    syncFullscreenButton();
  }
}

// Visuals toggle — once clicked, the user's choice sticks across re-renders.
// Guard the reveal: visuals only PAINT when the pattern has a viz method, so
// turning them on for a plain pattern would show an empty dark stage. Turning
// OFF always works; turning ON requires a draw method (else nudge the user).
vizBtn.addEventListener("click", () => {
  if (!widgetState.vizVisible && !detectViz(getLiveCode()).any) {
    setStatus(
      "Add .pianoroll(), .scope() or `await initHydra()` to the pattern to see visuals",
      "normal",
    );
    return;
  }
  widgetState.setVizManual(true);
  widgetState.setVizVisible(!widgetState.vizVisible);
  applyVizVisibility();
});

// Stage mode — visuals only. Dimmed but clickable with nothing to stage, so the
// click can explain itself instead of silently doing nothing.
/**
 * openStage(): a piece that draws its own controls asks for the stage, where
 * taps reach the drawing (inline, the code covers it). Honoured unless the
 * listener is typing in the editor or has left the stage this same piece
 * opened (src/stage-request-policy.ts); never binding — the Stage/Code button
 * and Escape still switch back.
 */
const pieceStage = createPieceStagePolicy();
function requestStageFromPiece(attempt = 0): void {
  const code = getEditor()?.code ?? currentCode;
  if (!pieceStage.requested(code, widgetState.stageMode)) return;
  if (document.activeElement?.closest?.(".cm-editor")) return;
  // The visuals the stage shows may appear a moment after the evaluation (Hydra).
  if (!widgetState.vizVisible) {
    if (attempt < 10) setTimeout(() => requestStageFromPiece(attempt + 1), 100);
    return;
  }
  widgetState.setStageMode(true);
  pieceStage.opened(code);
  applyStageMode();
}

stageBtn.addEventListener("click", () => {
  if (widgetState.stageMode) pieceStage.left();
  if (!widgetState.stageMode && !widgetState.vizVisible) {
    setStatus(
      "Stage mode needs a visual — add .pianoroll() or `await initHydra()`, or set the visuals parameter",
      "normal",
    );
    return;
  }
  widgetState.setStageMode(!widgetState.stageMode);
  applyStageMode();
});

// Escape leaves the stage, the way it leaves any other "took over the frame"
// mode. Bound on the document so it works with focus inside CodeMirror.
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && widgetState.stageMode && !watchMode) {
    pieceStage.left();
    widgetState.setStageMode(false);
    applyStageMode();
  } else if (event.key === "Escape" && !event.defaultPrevented && displayMode === "fullscreen") {
    // Leave fullscreen too: a share page's window fill never hears keys typed in
    // this frame. defaultPrevented = the editor used the key (closing a completion).
    void toggleDisplayMode();
  }
});

syncStageAffordance();

// =============================================================================
// Watch page — /p/<id>?watch, /s/<id>?watch: the share page frames us with
// ?watch=1. The stage alone (code hidden; the controls strip shows only when
// the piece declares controls, as everywhere), and one tap to start: a shared
// page never runs on its own, so the tap IS the Play press.
// =============================================================================

const watchMode = new URLSearchParams(location.search).get("watch") === "1";
if (watchMode) {
  document.documentElement.dataset.watch = "true";
  widgetState.setVizManual(true);
  widgetState.setVizVisible(true);
  widgetState.setStageMode(true);
  applyVizVisibility();
  applyStageMode();
  const start = document.createElement("button");
  start.className = "watch-start";
  start.textContent = "▶ Play";
  start.setAttribute("aria-label", "Play");
  start.addEventListener("click", (event) => {
    if (!getEditor()) {
      setStatus("Still loading — tap again in a moment", "normal");
      return;
    }
    start.remove();
    void pressPlay(event.isTrusted);
  });
  replSection.appendChild(start);
}

observeVisualSize(syncEditorToWidth);

// =============================================================================
// Live session — one player the model keeps changing (src/shared/session.ts)
// =============================================================================

/** How long before its bar an update is evaluated (its audio still lands on the bar). */
const SESSION_EVAL_LEAD_S = 0.6;

function sessionClock() {
  const scheduler = getEditor()?.repl?.scheduler;
  const cps = Number(scheduler?.cps);
  return {
    cycle: stageEnv.audibleCycle(),
    cps: Number.isFinite(cps) && cps > 0 ? cps : null,
    state: currentPlaybackState(),
  };
}

let sessionStatus: SessionStatus = "connecting";
let claudeListening = false;
function setSessionBadge(status: SessionStatus = sessionStatus): void {
  sessionStatus = status;
  sessionBadge.hidden = false;
  sessionBadge.dataset.status = status;
  sessionBadge.textContent =
    status === "live"
      ? claudeListening
        ? "● Claude is listening — Pass when you're done"
        : "● live"
      : status === "gone" || status === "ended"
        ? "○ session ended"
        : status === "parked"
          ? "○ session paused — press Play to rejoin"
        : status === "retrying"
          ? "◌ reconnecting"
          : "◌ joining";
  sessionBadge.title =
    status === "ended"
      ? "This live session was ended. The pattern keeps playing here; Claude can no longer change this player."
      : status === "gone"
      ? "This live session has ended (2 hours idle). The pattern keeps playing here."
      : status === "parked"
        ? "Stopped and untouched for 30 minutes, so the player stopped checking in. Play or edit to rejoin; the session lasts 2 hours idle."
      : "Live session: Claude can change this pattern without opening a new player, and reads what you do.";
  syncChatButtons();
}

/**
 * Say what a press will do. Pass always logs the turn in the session; only
 * when Claude is NOT listening does it also post a chat message (the only
 * way to start Claude's next turn) — the label says so ("Pass → chat").
 * In a live session "Send to chat" is redundant (edits are logged and read
 * with get-session) and was a second button writing into the chat: hidden.
 */
function syncChatButtons(): void {
  const inSession = !!widgetState.session && sessionStatus !== "gone" && sessionStatus !== "ended";
  sendBtn.hidden = !canSendMessage || inSession;
  passBtn.hidden = !inSession;
  endBtn.hidden = !inSession;
  const toChat = !claudeListening && canSendMessage;
  passBtn.textContent = toChat ? "Pass → chat" : "Pass";
  const what = claudeListening
    ? "Claude is listening: hand it the turn. It reads what you did and answers on this player."
    : canSendMessage
      ? "Claude isn't listening right now: Pass logs your turn in the session and puts a message in the chat so Claude takes its turn."
      : "Logs your turn in the session. Tell Claude in the chat that it's their turn.";
  passBtn.title = what;
  passBtn.setAttribute("aria-label", what);
}

function startSession(id: string, origin: string, startRev = 0): void {
  if (widgetState.session || !SESSION_ID_RE.test(id) || !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return;
  widgetState.setSession(new SessionClient(origin.replace(/\/+$/, ""), id, {
    fetch: (url, init) => fetch(url, init),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    clock: sessionClock,
    apply: applySessionPattern,
    onStatus: setSessionBadge,
    onListening: (listening) => {
      if (listening === claudeListening) return;
      claudeListening = listening;
      setSessionBadge();
    },
    onPassUnanswered: () => {
      if (claudeListening) return;
      setStatus(
        canSendMessage
          ? "No answer on the player yet — Pass again to send it to the chat"
          : "No answer on the player yet — tell Claude in the chat it's their turn",
        "playing",
      );
    },
  }, startRev));
  const ctx = app.getHostContext() as { platform?: string } | undefined;
  const host = (app as unknown as { getHostVersion?: () => { name?: string; version?: string } | undefined })
    .getHostVersion?.();
  widgetState.session!.start({
    host: host?.name ? `${host.name}${host.version ? ` ${host.version}` : ""}` : undefined,
    platform: ctx?.platform,
    caps: Object.keys(app.getHostCapabilities() ?? {}),
    // So the model can tell a host-cached older widget from the current one.
    widget: VERSION,
  });
  // The first report this widget made may have come before the session existed.
  if (widgetState.lastReportText) widgetState.session!.log({ t: "report", text: widgetState.lastReportText }, true);
  lastControlSurface = "";
  logControlSurface();
  // State a piece already remembers when the session starts.
  const remembered = stage.remembered();
  if (remembered.length) widgetState.session!.rememberedState(remembered);
}

/**
 * Give the scheduler the old pattern until `boundary` and the one just
 * installed from it. `onBoundary` runs when the scheduler first reaches the
 * bar (remember() state lands with the music). Returns false when nothing was
 * spliced — the swap is immediate and the caller applies state at once.
 */
function applySplice(editor: any, previous: any, boundary: number, onBoundary?: () => void): boolean {
  const scheduler = editor?.repl?.scheduler;
  const next = scheduler?.pattern;
  const stack = (window as any).stack;
  if (!scheduler || !previous || !next || next === previous || typeof stack !== "function") return false;
  try {
    scheduler.pattern = spliceAt(previous, next, boundary, stack, stageEnv.audibleCycle() ?? -Infinity, onBoundary);
  } catch {
    return false; // an unspliceable pattern just swaps at once
  }
  scheduleSpliceSweep();
  return true;
}

/**
 * Drop spliced halves that are over, by the AUDIO clock — not a wall-clock
 * guess, which a suspended context or a tempo change makes wrong (Codex review).
 */
let spliceSweep: ReturnType<typeof setTimeout> | null = null;
function scheduleSpliceSweep(): void {
  if (spliceSweep !== null) return;
  spliceSweep = setTimeout(() => {
    spliceSweep = null;
    const scheduler = getEditor()?.repl?.scheduler;
    if (!scheduler?.pattern || !isSpliced(scheduler.pattern)) return;
    // Half a cycle of margin: the scheduler queries a little ahead of what is heard.
    const heard = stageEnv.audibleCycle();
    if (heard !== null) scheduler.pattern = settle(scheduler.pattern, heard - 0.5);
    if (isSpliced(scheduler.pattern)) scheduleSpliceSweep();
  }, 1000);
}

async function applySessionPattern(pattern: QueuedPattern): Promise<ApplyOutcome> {
  const outcome = await quantizedSwap(pattern.code, pattern.quantize, () => (widgetState.session ? null : "the player closed"), {
    // Tell the service at once which bar THIS player picked: update-session
    // reports it instead of the server's estimate (a field run said "cycle 40"
    // for a swap the player put on 48).
    onQueued: (boundary) => widgetState.session?.log({ t: "scheduled", rev: pattern.rev, boundary }, true),
  });
  if (outcome.ok) noteSetlistChange({ by: "claude", rev: pattern.rev, cycle: outcome.cycle, code: pattern.code });
  return outcome;
}

/**
 * The quantized swap shared by update-session and the swap-pattern widget
 * tool: the code goes into the editor at once; while playing, it is evaluated
 * just before the next `quantize`-cycle boundary and spliced in from it (old
 * pattern until the bar). One counter for both callers, so the newest swap of
 * either kind wins and an older one answers "replaced". `cancelled` returns a
 * reason when the caller has gone away.
 */
async function quantizedSwap(
  code: string,
  quantize: number,
  cancelled: () => string | null,
  hooks: StudioSwapHooks = {},
): Promise<ApplyOutcome> {
  const mine = ++sessionApplySeq;
  const replaced = {
    ok: false,
    cycle: null,
    error: "replaced before it played by a newer edit, swap, update, play, undo or stop",
  } as const;
  const editor = await prepareEditor().catch(() => null);
  if (!editor?.repl) return { ok: false, cycle: null, error: "the player could not load Strudel" };
  if (mine !== sessionApplySeq) return replaced;
  hooks.beforeLoad?.();
  lastProgrammaticCode = code;
  widgetState.setSentCode(code);
  currentCode = code;
  editor.setCode(code);
  if (!isSchedulerStarted()) {
    return {
      ok: true,
      cycle: null,
      report: "Loaded into the editor, but the player is stopped — it plays when the user taps Play.",
    };
  }
  const scheduler = editor.repl.scheduler;
  const cps = Number(scheduler?.cps) || 0.5;
  let boundary: number | null = null;
  if (quantize > 0) {
    boundary = nextBoundary(stageEnv.audibleCycle() ?? 0, quantize, SESSION_SWAP_LEAD_S * cps);
    hooks.onQueued?.(boundary, Math.max(0, (boundary - (stageEnv.audibleCycle() ?? 0)) / cps));
    setStatus(`Next pattern lands at bar ${Math.round(boundary)}`, "playing");
    const giveUpAt = Date.now() + ((boundary - (stageEnv.audibleCycle() ?? 0)) / cps) * 1000 + 5000;
    for (;;) {
      if (mine !== sessionApplySeq) return replaced;
      const gone = cancelled();
      if (gone) return { ok: false, cycle: null, error: gone };
      // Stopped while waiting: the boundary will never come (Codex review).
      if (!isSchedulerStarted()) {
        return {
          ok: true,
          cycle: null,
          report: "Loaded into the editor, but someone stopped the player before the bar — it plays when Play is pressed.",
        };
      }
      const scheduled = Number(scheduler.now?.());
      const remaining = (boundary - SESSION_EVAL_LEAD_S * cps - scheduled) / cps;
      if (!Number.isFinite(remaining) || remaining <= 0 || Date.now() > giveUpAt) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(remaining * 1000, 250)));
    }
  }
  // Takeover: still ours, still wanted, and the editor still holds OUR code —
  // a human edit (or anything else) during the wait must not be evaluated
  // under this swap's name (Codex + Kimi review).
  if (mine !== sessionApplySeq) return replaced;
  const gone = cancelled();
  if (gone) return { ok: false, cycle: null, error: gone };
  if (typeof editor.code === "string" && editor.code !== code) {
    return { ok: false, cycle: null, error: "the code was edited before the bar; not swapped" };
  }
  widgetState.setLastReportText("");
  const ranBefore = evaluationSeq;
  const mark: SwapEvaluation = { code, seq: mine, boundary, refused: false };
  swapEvaluation = mark;
  const evaluating = editor.evaluate(true);
  // The hook took it on entry; never leave it for another call.
  if (swapEvaluation === mark) swapEvaluation = null;
  await evaluating;
  const err = readEvalError();
  const msg = err ? err.message || String(err) : null;
  return swapOutcome({
    refused: mark.refused,
    ran: evaluationSeq !== ranBefore,
    started: isSchedulerStarted(),
    error: msg === null ? null : msg + sourceLineNote(msg, code, code),
    cancelled: cancelled(),
    cycle: boundary ?? stageEnv.audibleCycle(),
    report: widgetState.lastReportText || undefined,
    replaced,
  });
}

/** Tell the session which controls the player now shows (when that changes). */
let lastControlSurface = "";
function logControlSurface(): void {
  const list = stage.controls().map(({ spec, value }) => ({
    name: spec.name,
    kind: spec.kind,
    value,
    ...(spec.kind === "fader" ? { min: spec.min, max: spec.max } : {}),
    ...(spec.sensor ? { sensor: spec.sensor, source: spec.source } : {}),
  }));
  const key = JSON.stringify(list.map(({ name, kind, source }) => [name, kind, source]));
  if (key === lastControlSurface) return;
  lastControlSurface = key;
  widgetState.session?.log({ t: "controls", list }, true);
}

/** A successful evaluation of code we did not put there is the human's edit. */
function noteHumanEdit(code: string): void {
  if (!widgetState.session) return;
  if (code.trim() === lastProgrammaticCode.trim() || code === lastLoggedEdit) return;
  lastLoggedEdit = code;
  const cycle = stageEnv.audibleCycle();
  widgetState.session.log({ t: "edit", cycle, code, chars: code.length }, true);
  noteSetlistChange({ by: "you", cycle, code });
}

// End session: the listener closes it. The pattern keeps playing locally;
// the service is told (a listening model hears it at once) and this player
// stops polling and logging.
endBtn.addEventListener("click", async () => {
  if (!widgetState.session) return;
  endBtn.disabled = true;
  const ok = await widgetState.session.end(stageEnv.audibleCycle()).finally(() => (endBtn.disabled = false));
  setStatus(
    ok
      ? "Session ended — the music keeps playing here"
      : "Session closed on this player (the service could not be reached to confirm)",
    isSchedulerStarted() ? "playing" : "normal",
  );
});

passBtn.addEventListener("click", async () => {
  if (!widgetState.session) return;
  passBtn.disabled = true;
  // A model listening with get-session(wait) reads the Pass straight away:
  // no chat message (one could not land mid-turn anyway).
  const heard = await widgetState.session.pass(stageEnv.audibleCycle()).finally(() => (passBtn.disabled = false));
  if (heard) {
    setStatus("Passed — Claude is answering", "playing");
    return;
  }
  if (!canSendMessage) {
    setStatus("Passed — tell Claude it's their turn", "playing");
    return;
  }
  passBtn.disabled = true;
  try {
    await app.sendMessage({
      role: "user",
      content: [
        {
          type: "text",
          text:
            `Your turn (live session ${widgetState.session.id}). Read what I just did with get-session, ` +
            "then answer on the player with update-session.",
        },
      ],
    });
  } catch (err) {
    setStatus(`Pass failed: ${(err as Error).message} — tell Claude in the chat`, "error");
  } finally {
    passBtn.disabled = false;
  }
});

// =============================================================================
// MCP ext-apps Integration
// =============================================================================

// Register notification handlers BEFORE connect() — the SDK drops
// notifications that have no handler registered at arrival time.
// A host may rebuild a widget it scrolled away and replay the same call, so a
// tool call autoplays once per view, not once per mount (src/view-memory.ts).
const autoplayMemory = new AutoplayMemory(browserStorage);
const viewIds = new ViewIdChannel();

app.ontoolresult = (result) => {
  viewIds.put(viewIdOf(result));
  const meta = (result as { _meta?: { session?: { id?: unknown; origin?: unknown; rev?: unknown } } })._meta?.session;
  if (meta && typeof meta.id === "string" && typeof meta.origin === "string") {
    startSession(meta.id, meta.origin, typeof meta.rev === "number" ? meta.rev : 0);
    return;
  }
  // A host that drops a result's _meta still shows the widget its text: the
  // session line names the id (the hosted origin is the default).
  const text = (result.content ?? [])
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
  const named = /Live session: ([a-z2-7]{16})\./.exec(text);
  if (named) startSession(named[1], DEFAULT_SHARE_ORIGIN);
};

app.ontoolinput = (params) => {
  const args = params.arguments ?? {};
  // Claimed for every tool input, so each one pairs with its own result.
  const permit = claimAutoplay(
    autoplayMemory,
    toolCallKey(app.getHostContext()?.toolInfo?.id, args),
    viewIds.take(),
  );
  renderPattern(args, permit);
};

app.ontoolinputpartial = (params) => {
  const code = params.arguments?.code as string | undefined;
  if (!code) return;
  setStatus("Composing pattern...");
  // The title streams too — show it while the pattern is still being written.
  if (typeof params.arguments?.title === "string") {
    setPatternTitle(params.arguments.title);
  }
  if (typeof params.arguments?.theme === "string") {
    pendingTheme = params.arguments.theme as string;
  }
  pendingPartialCode = code;
  const editor = getEditor();
  if (editor?.setCode) {
    editor.setCode(code);
    return;
  }
  // First tool call: no editor exists yet, so this chunk (and every chunk until
  // the CDN lands) would be dropped. Boot the editor now and replay into it.
  void startStreamingBoot();
};

// Generation cancelled — clear the stuck "Composing pattern..." status and,
// like the ABC widget, make it stick: a renderPattern() still waiting on the
// CDN or the editor used to carry on to evaluate(true) and start the pattern
// the user had just cancelled. Bumping the generation stops it at its next
// checkpoint, and a streaming boot in flight no longer writes its half-pattern.
app.ontoolcancelled = (params) => {
  renderGeneration++;
  viewIds.abandon();
  pendingPartialCode = "";
  streamingBoot = null;
  if (widgetState.isRecording) stopRecording();
  getEditor()?.stop?.();
  updatePlayState(false);
  const reason = params?.reason ? ` (${params.reason})` : "";
  setStatus(`Generation cancelled${reason}.`, "normal");
};

// Stop all audio + recording and release the recording tap when the host
// tears this instance down, so a discarded widget leaves nothing running.
app.onteardown = () => {
  try {
    widgetState.session?.stop();
    widgetState.setSession(null);
    studioSession.dispose();
    // Invalidate any in-flight render/boot so a late `await` can't repopulate
    // the DOM of a widget the host has already discarded.
    renderGeneration++;
    teardownRecording();
    const editor = getEditor();
    editor?.stop?.();
    updatePlayState(false);
    disconnectRecordingTap();
    disconnectVisualObservers();
    cancelMissingSoundReport();
    // A pending state report would fire into a host that has already let go.
    cancelStateReport();
    removeConsoleWatch();
    // Stop Hydra's WebGL render loop too — it runs independently of the
    // Strudel scheduler and would otherwise keep the GPU busy after teardown.
    setHydraActive(false);
    // Release the analyser tap and take `a` / a0…aN back off the eval scope.
    teardownAudioAnalyser();
    // A discarded widget must not resume audio on a stray tap.
    stopGestureUnlock();
    // Its loops, tap listener and speech end with it.
    stage.stop();
    removeDrawLayers();
    watchedAudioContext?.removeEventListener("statechange", syncAudioState);
    watchedAudioContext = null;
  } catch { /* best-effort cleanup */ }
  return {};
};

app.onerror = console.error;

/**
 * Follow the host's own chrome: theme (which may differ from the OS preference),
 * any CSS variable tokens it hands us, and the safe-area insets that keep the
 * toolbar out from under a notch. Mirrors src/mcp-app.ts.
 */
function handleHostContextChanged(ctx: McpUiHostContext) {
  if (ctx.theme) {
    applyDocumentTheme(ctx.theme);
  }
  if (ctx.displayMode) {
    displayMode = ctx.displayMode;
    syncFullscreenButton();
    // The frame just changed size; the backdrop's backing store must follow.
    requestAnimationFrame(syncVizCanvasSize);
  }
  if (ctx.availableDisplayModes) {
    availableDisplayModes = ctx.availableDisplayModes;
  }
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

// Source access uses the host link API inside sandboxed MCP widgets.
bindSourceLink(app);

const studioSession = createStudioSession({
  read: () => ({
    args: {
      // Read the LIVE buffer, including edits not evaluated yet.
      code: getEditor()?.code ?? currentCode,
      title: titleEl.textContent ?? "",
      ...(runtimeCps !== null ? { bpm: runtimeCps * 240 } : {}),
      ...(pendingTheme ? { theme: pendingTheme } : {}),
    },
    selection: (() => {
      const range = getEditor()?.editor?.state?.selection?.main;
      const from = range?.from ?? 0;
      const to = range?.to ?? from;
      return { from, to, text: (getEditor()?.code ?? currentCode).slice(from, to) };
    })(),
    playback: currentPlaybackState(),
    status: statusEl.textContent ?? "",
    error: statusEl.classList.contains("error") ? statusEl.textContent : null,
    playPressed,
  }),
  apply: async (args, _settings, isCancelled, onCommit) => {
    if (isCancelled?.()) throw new Error("The review request changed. Review the current question before applying.");
    // Any waiting swap or session update stands down (it answers "replaced").
    sessionApplySeq++;
    // A replacement is staged stopped; Play is a separate, explicit action.
    if (widgetState.isRecording) stopRecording();
    getEditor()?.stop?.();
    updatePlayState(false);
    const before = getLiveCode();
    if (args.code === "") {
      renderGeneration++;
      getEditor()?.setCode(""); currentCode = "";
      runtimeCps = null;
      pendingTheme = typeof args.theme === "string" ? args.theme : undefined;
      setPatternTitle(args.title);
      if (getEditor()) applyEditorTheme(getEditor(), pendingTheme);
      setStatus("Enter a Strudel pattern");
      onCommit?.();
      return;
    }
    await renderPattern({ ...args, autoplay: false }, undefined, () => !isCancelled?.() && getLiveCode() === before, onCommit);
  },
  swap: async (code, quantize, isCancelled, hooks) => {
    // Edits stage stopped and Play is explicit (studio rule): a swap only
    // changes music that is already playing.
    if (!isSchedulerStarted()) {
      throw new Error("The player is stopped: swap-pattern changes a PLAYING pattern on the bar. Use set-pattern, then play-current-music.");
    }
    const outcome = await quantizedSwap(
      code,
      quantize,
      () => (isCancelled() ? "replaced before it played by a newer edit, swap, play, undo or stop" : null),
      hooks,
    );
    if (outcome.ok && widgetState.session) {
      // The booth's other side sees it like a human edit (it came from the
      // user's page — e.g. their browser agent), and /s/<id> follows it.
      widgetState.session.log({
        t: "report",
        text: `swap-pattern (a tool on the user's page) swapped new code in${outcome.cycle !== null ? ` at cycle ${outcome.cycle.toFixed(1)}` : ""}.`,
      });
      lastLoggedEdit = code;
      widgetState.session.log({ t: "edit", cycle: outcome.cycle, code, chars: code.length }, true);
      noteSetlistChange({ by: "tool", cycle: outcome.cycle, code });
    }
    return outcome;
  },
  play: async () => {
    const editor = getEditor();
    if (!editor) throw new Error("The editor has not loaded yet.");
    sessionApplySeq++;
    playPresses++;
    void ensureAudioRunning();
    await editor.evaluate(true);
  },
  stop: () => {
    companion?.stop();
    sessionApplySeq++;
    renderGeneration++;
    playPresses++;
    if (widgetState.isRecording) stopRecording();
    getEditor()?.stop?.();
    updatePlayState(false);
    scheduleStateReport();
    setStatus("Stopped");
  },
}, { mode: "live", schemas: liveStudioSchemas });
registerStudioAppTools(app, studioSession);
installStudioBridge(studioSession);
installStudioReviewPanel(app, studioSession);

// Connect, then read host capabilities and gate features accordingly.
app.connect().then(() => {
  const caps = app.getHostCapabilities();

  // Download is host-mediated; if unsupported (e.g. mobile), hide the
  // download/record flow so users don't hit a raw -32601 error.
  widgetState.setCanDownload(!!caps?.downloadFile);
  // Runtime feedback to the model (eval failures, what's actually playing).
  widgetState.setCanUpdateModelContext(!!caps?.updateModelContext);
  if (!widgetState.canDownload) {
    downloadBtn.hidden = true;
    recordBtn.hidden = true;
    recordBtn.title = "Recording export not supported on this host";
    // Kept visible but inert: its click points at the share page, which can save.
    videoBtn.setAttribute("aria-disabled", "true");
    videoBtn.title = "Saving a video isn't supported in this app — a share link's page can record and save one";
  }
  videoBtn.hidden = !canRecordVideo();

  // "Send to chat" needs the host to accept ui/message.
  if (caps?.message) canSendMessage = true;
  syncChatButtons();

  const ctx = app.getHostContext();
  if (ctx) {
    handleHostContextChanged(ctx);
  }
});

if (document.documentElement.dataset.audition) container.inert = true;

if (document.documentElement.dataset.studio === "true" && !document.documentElement.dataset.audition) {
  companion = installStrudelCompanion({
    container, stage: replSection, status: statusEl, editor: getEditor,
    playing: isSchedulerStarted, recording: () => widgetState.isRecording,
  });
  // Host teardown, not only pagehide: a host can unmount the frame without one (Kimi review).
  studioSession.onDispose(() => companion?.dispose());
  playBtn.addEventListener("click", () => companion?.stop(), { capture: true });
}
