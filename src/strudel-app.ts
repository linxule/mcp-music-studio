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
import { App } from "@modelcontextprotocol/ext-apps";
import { detectViz } from "./shared/viz-detect";
import { injectTempo } from "./shared/tempo";
import { audioBufferToWavBase64 } from "./wav-encoder";
import { VERSION } from "./version";

const STRUDEL_CDN = "https://unpkg.com/@strudel/repl@1.3.0";

const app = new App({ name: "Strudel Live Pattern", version: VERSION });

const playBtn = document.getElementById("play-btn") as HTMLButtonElement;
const recordBtn = document.getElementById("record-btn") as HTMLButtonElement;
const downloadBtn = document.getElementById("download-btn") as HTMLButtonElement;
const sendBtn = document.getElementById("send-btn") as HTMLButtonElement;
const fullscreenBtn = document.getElementById("fullscreen-btn") as HTMLButtonElement;
const vizBtn = document.getElementById("viz-btn") as HTMLButtonElement;
const replSection = document.querySelector(".repl-section") as HTMLElement;
const vizCanvas = document.getElementById("test-canvas") as HTMLCanvasElement;
const statusEl = document.getElementById("status")!;
const container = document.getElementById("strudel-container")!;

let editorEl: HTMLElement | null = null;
let currentCode = "";
let isPlaying = false;
let cdnLoaded = false;

// Visualization panel. The pattern's code decides whether a visual shows: the
// panel auto-reveals when the code contains a viz method or initHydra(), unless
// the user has manually toggled it (vizManual sticks their choice across
// re-renders). Detection lives in src/shared/viz-detect.ts (pure, unit-tested).
let vizVisible = false;
let vizManual = false;
let vizResizeObserver: ResizeObserver | null = null;
// True while the current pattern uses Hydra (WebGL layer under #test-canvas).
let hydraActive = false;
// Pending late re-apply of the Hydra resolution (see syncVizCanvasSize).
let hydraLateResize: ReturnType<typeof setTimeout> | null = null;
// Hydra renders at this many CSS px wide at most, then upscales (pixelated).
// 960px is plenty for a widget backdrop and keeps the GPU cost low inside the
// inline iframe; strudel.cc itself defaults to pixelRatio 1 at window size.
const HYDRA_MAX_WIDTH = 960;

// Host capabilities (populated after connect)
let canDownload = false;
let canUpdateModelContext = false;
// Last args from renderPattern, so a CDN retry can re-run the same pattern
let lastRenderArgs: Record<string, unknown> | null = null;

// Recording state
let mediaRecorder: MediaRecorder | null = null;
let recordedChunks: Blob[] = [];
let isRecording = false;
let recordingStream: MediaStream | null = null;
// The master-output node the tap is connected to, and the tap destination,
// so teardown can disconnect precisely the tap (not the speakers).
let recordingMasterGain: AudioNode | null = null;
let recordingDest: AudioNode | null = null;

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

// Set when prebake() soundfont registration fails — audio may be silent/absent.
let soundfontWarning = false;

async function loadStrudelCDN(): Promise<void> {
  if (cdnLoaded) return;
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = STRUDEL_CDN;
    script.onload = async () => {
      cdnLoaded = true;
      // Trigger prebake to register soundfonts (128 GM instruments)
      // and load default samples (dirt-samples, drum machines)
      try {
        const strudel = (window as any).strudel;
        if (strudel?.prebake) await strudel.prebake();
        soundfontWarning = false;
      } catch {
        // Non-fatal: the REPL still works, but soundfonts may be unavailable.
        // Surfaced to the user instead of silently swallowed (see renderPattern).
        soundfontWarning = true;
      }
      // The console watch can go in immediately; the eval-scope globals
      // (initHydra, H, …) are only published when <strudel-editor> builds its
      // REPL, so installEvalScopeHooks() is retried from the evaluate hook.
      installConsoleWatch();
      resolve();
    };
    script.onerror = () => reject(new Error("Failed to load Strudel REPL"));
    document.head.appendChild(script);
  });
}

function setStatus(text: string, type: "normal" | "playing" | "error" = "normal") {
  statusEl.textContent = text;
  statusEl.className = `status ${type}`;
}

function updatePlayState(playing: boolean) {
  isPlaying = playing;
  playBtn.classList.toggle("playing", playing);
  playBtn.textContent = playing ? "Playing" : "Play";
  if (!isRecording) {
    setStatus(playing ? "Playing..." : "Ready", playing ? "playing" : "normal");
  }
}

// Tempo injection is shared with the browser fallback (src/shared/tempo.ts):
// one documented policy, no regex that corrupts nested parens.
function injectBpm(code: string, bpm: number): string {
  return injectTempo(code, bpm).code;
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

/**
 * Fix the strudel-editor layout:
 * - Hide the position:fixed canvas that covers the viewport
 * - Ensure the CodeMirror sibling div is visible
 */
function fixLayout(): void {
  // Canvases prepended to document.body by @strudel/draw's getDrawContext.
  // #hydra-canvas belongs in the widget, so adopt it (the MutationObserver
  // normally gets there first; this is the backstop). Anything else full-viewport
  // is a stray overlay — hide it. #test-canvas is pre-created in .repl-section
  // and is never a body child.
  document.querySelectorAll("body > canvas").forEach((canvas) => {
    const el = canvas as HTMLCanvasElement;
    if (el.id === "hydra-canvas") {
      adoptHydraCanvas(el);
      return;
    }
    if (el.id === "test-canvas") return;
    if (el.style.position === "fixed") {
      el.style.display = "none";
    }
  });

  // The editor content is placed as a sibling AFTER <strudel-editor>
  // Make sure it's visible and properly sized
  if (editorEl?.nextElementSibling) {
    const sibling = editorEl.nextElementSibling as HTMLElement;
    if (sibling.querySelector(".cm-editor")) {
      sibling.style.minHeight = "200px";
      sibling.style.flex = "1";
    }
  }
}

// =============================================================================
// Visualization panel
// =============================================================================

/**
 * Match the canvas backing store to the panel's CSS size × devicePixelRatio so
 * Strudel's pianoroll/scope render crisply (it reads canvas.width/height every
 * frame and clears with clearRect). The ext-apps iframe makes window.innerWidth
 * unreliable, so we measure the panel element directly (+ ResizeObserver).
 */
function syncVizCanvasSize(): void {
  if (!vizVisible) return;
  // The backdrop canvas fills the repl section; measure that element directly.
  const w = replSection.clientWidth;
  const h = replSection.clientHeight;
  if (w === 0 || h === 0) return;
  const dpr = window.devicePixelRatio || 1;
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (vizCanvas.width !== bw) vizCanvas.width = bw;
  if (vizCanvas.height !== bh) vizCanvas.height = bh;
  if (!hydraActive) return;
  syncHydraCanvasSize(w, h);
  // getDrawContext installed its own debounced (200ms) window-resize handler
  // that rewrites the Hydra canvas to innerWidth × innerHeight without telling
  // hydra-synth, which would leave the viewport stretched. Re-apply after it.
  if (hydraLateResize !== null) clearTimeout(hydraLateResize);
  hydraLateResize = setTimeout(() => {
    hydraLateResize = null;
    if (hydraActive && vizVisible) {
      syncHydraCanvasSize(replSection.clientWidth, replSection.clientHeight);
    }
  }, 320);
}

// -----------------------------------------------------------------------------
// Hydra (WebGL) layer
//
// @strudel/hydra@1.3.0's initHydra() reads (verified against the live bundle):
//
//   async function initHydra(opts = {}) {
//     ...
//     if (!document.getElementById("hydra-canvas")) {
//       const { canvas } = getDrawContext("hydra-canvas", { contextType: "webgl", ... });
//       await import("https://unpkg.com/hydra-synth");
//       hydra = new Hydra({ ...opts, canvas });
//       if (feedStrudel) { getDrawContext().canvas.style.display = "none"; ... }
//     }
//     return hydra;
//   }
//
// So the ELEMENT'S EXISTENCE is Hydra's own "already initialised" flag. Any
// pre-created #hydra-canvas turns initHydra() into a silent no-op: no engine, no
// osc/o0 globals, and the pattern dies on "osc is not defined". We therefore let
// getDrawContext() create the canvas (it prepends a position:fixed, full-viewport
// element to <body>) and ADOPT it into .repl-section the instant it appears.
//
// Adoption runs from a MutationObserver, whose callback is a microtask queued
// during the synchronous getDrawContext() call — comfortably before the
// `await import(...)` that precedes `new Hydra(...)`. That matters because
// hydra-synth reads canvas.width/height in its constructor, so the capped
// backing-store size must be in place by then.
//
// Teardown goes through clearHydra() (also in eval scope), which hushes the
// synth, REMOVES the canvas, and restores the Strudel `speed` / `shape` globals
// that hydra-synth's makeGlobal clobbered. We must NOT put a canvas back
// afterwards, or the next initHydra() no-ops again.
// -----------------------------------------------------------------------------

function getHydraCanvas(): HTMLCanvasElement | null {
  return document.getElementById("hydra-canvas") as HTMLCanvasElement | null;
}

/** Panel size capped at HYDRA_MAX_WIDTH CSS px, aspect preserved. */
function cappedHydraSize(w: number, h: number): [number, number] {
  const scale = Math.min(1, HYDRA_MAX_WIDTH / Math.max(1, w));
  return [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))];
}

/**
 * Pull Hydra's freshly created canvas out of <body> and into the visuals stack,
 * under the 2D #test-canvas, and give it the capped backing-store size before
 * hydra-synth's constructor reads it.
 *
 * getDrawContext() writes an inline `position:fixed; top:0; left:0; width:100%;
 * height:100%` style; dropping the whole attribute (our CSS class re-applies
 * image-rendering:pixelated) is what turns it from a viewport overlay into an
 * in-flow backdrop.
 */
function adoptHydraCanvas(c: HTMLCanvasElement): void {
  if (c.parentElement !== replSection) {
    c.removeAttribute("style");
    c.className = "viz-canvas hydra-canvas";
    replSection.insertBefore(c, vizCanvas);
  }
  const [rw, rh] = cappedHydraSize(replSection.clientWidth, replSection.clientHeight);
  if (c.width !== rw || c.height !== rh) {
    c.width = rw;
    c.height = rh;
  }
}

// Catch the canvas the moment @strudel/hydra prepends it to <body>.
const hydraCanvasObserver = new MutationObserver((records) => {
  for (const record of records) {
    for (const node of Array.from(record.addedNodes)) {
      if (node instanceof HTMLCanvasElement && node.id === "hydra-canvas") {
        adoptHydraCanvas(node);
      }
    }
  }
});
hydraCanvasObserver.observe(document.body, { childList: true });

/**
 * Resize the live Hydra layer. Once hydra-synth is running, writing
 * canvas.width/height behind its back desyncs its viewport, so go through the
 * setResolution() global it installs.
 *
 * getDrawContext() also registered its OWN debounced (200ms) window-resize
 * handler that resets the canvas to innerWidth × innerHeight without telling
 * Hydra. syncVizCanvasSize() schedules a late re-apply so ours lands last.
 */
function syncHydraCanvasSize(w: number, h: number): void {
  const c = getHydraCanvas();
  if (!c) return;
  const [rw, rh] = cappedHydraSize(w, h);
  const setRes = (window as any).setResolution;
  if (typeof setRes === "function") {
    try {
      setRes(rw, rh);
      return;
    } catch { /* fall through to a direct resize */ }
  }
  if (c.width !== rw || c.height !== rh) {
    c.width = rw;
    c.height = rh;
  }
}

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
//      hydra-synth (upstream defaults to an UNVERSIONED unpkg URL) and re-assert
//      the resolution once the engine is actually up.
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

/** Strudel globals that hydra-synth's makeGlobal clobbers. */
const CLOBBERED_GLOBALS = ["time", "speed", "shape", "hush"] as const;

let evalScopeHooked = false;
let hydraInstance: any = null;
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
function defineWrappedGlobal(key: string, wrap: (original: any) => any): void {
  const w = window as any;
  let exposed = typeof w[key] === "function" ? wrap(w[key]) : w[key];
  Object.defineProperty(w, key, {
    configurable: true,
    enumerable: true,
    get: () => exposed,
    set: (value) => {
      exposed = typeof value === "function" ? wrap(value) : value;
    },
  });
}

function installEvalScopeHooks(): void {
  const w = window as any;
  if (evalScopeHooked || typeof w.initHydra !== "function") return;
  evalScopeHooked = true;

  snapshotStrudelGlobals();

  defineWrappedGlobal("initHydra", (original) => async (options: Record<string, unknown> = {}) => {
    // `src` first so an explicit caller value still wins. It is destructured out
    // by initHydra and never reaches the Hydra constructor.
    hydraEverInitialised = true;
    const instance = await original({ src: HYDRA_SYNTH_CDN, ...options });
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
    return instance;
  });

  defineWrappedGlobal("H", (original) => (pattern: unknown) => {
    const sample = original(pattern);
    return () => {
      try {
        const value = Number(sample());
        return Number.isFinite(value) ? value : 0;
      } catch {
        // Rest under the playhead — the zero-width query returns no hap and the
        // upstream H throws. Hydra calls this every frame, so one rest would
        // otherwise kill the shader while the audio kept going.
        return 0;
      }
      // NOTE: the Number() above also flattens NOTE-valued patterns to 0 —
      // H("<c3 e3>") feeds a shader 0 rather than a pitch. That is deliberate:
      // Hydra parameters are numeric, and a silent 0 beats a per-frame throw.
      // Patterns meant to drive a shader should carry numbers, as the guide's
      // recipes do.
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
 * Release the HydraRenderer. clearHydra() only hushes it and drops the canvas;
 * the regl context (and the render loop driving it) survives, so destroy it.
 * The next initHydra() builds a fresh renderer, having found no #hydra-canvas.
 */
function stopHydraInstance(): void {
  const instance = hydraInstance;
  hydraInstance = null;
  if (!instance) return;
  try {
    instance.hush?.();
  } catch { /* already torn down */ }
  try {
    instance.regl?.destroy?.();
  } catch { /* regl may already be gone */ }
}

/** Stage or strike the Hydra layer for the pattern about to run. */
function setHydraActive(active: boolean): void {
  hydraActive = active;
  replSection.classList.toggle("hydra-on", active);
  // A previous `initHydra({ feedStrudel: true })` sets an INLINE display:none on
  // #test-canvas to hide the piano roll it is texturing. Nothing upstream ever
  // undoes that, so a later .pianoroll() pattern would draw into a hidden
  // canvas. Clear it on every staging; feedStrudel re-applies it if still asked.
  vizCanvas.style.removeProperty("display");
  if (active) return;

  // Pattern no longer uses Hydra: stop its render loop so a stale shader doesn't
  // keep the GPU busy under the code. Leave NO #hydra-canvas behind — its
  // presence is what would make the next initHydra() a no-op.
  try {
    (window as any).clearHydra?.();
  } catch { /* hydra never initialised — nothing to clear */ }
  stopHydraInstance();
  restoreStrudelGlobals();
  getHydraCanvas()?.remove();
}

/** Reflect viz visibility on the backdrop + editor scrim + toggle button. */
function applyVizVisibility(): void {
  // .viz-on reveals the backdrop canvas and makes the editor translucent (CSS).
  replSection.classList.toggle("viz-on", vizVisible);
  vizBtn.classList.toggle("active", vizVisible);
  vizBtn.setAttribute("aria-pressed", String(vizVisible));
  if (vizVisible) {
    // Backdrop just gained layout — size the backing store on the next frame.
    requestAnimationFrame(syncVizCanvasSize);
  }
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

// -----------------------------------------------------------------------------
// Missing sounds
//
// An unknown sound name does NOT fail evaluation — the pattern is valid, and
// superdough only discovers the sample is missing when it tries to trigger it,
// a cycle later. It reports through Strudel's logger, which writes to
// console.LOG (styled with %c), not console.error, so the only way to see it is
// to watch the console. We pass everything through untouched and just pick the
// sound name out.
// -----------------------------------------------------------------------------

const MISSING_SOUND_RE = /sound\s+(\S+?)\s+not found/i;
const missingSounds = new Set<string>();
let missingSoundTimer: ReturnType<typeof setTimeout> | null = null;
let missingSoundReported = false;
let consoleWatchInstalled = false;

function noteMissingSound(name: string): void {
  if (missingSoundReported || missingSounds.has(name)) return;
  missingSounds.add(name);
  if (missingSoundTimer !== null) return;
  // Collect for a beat so several missing sounds become ONE report.
  missingSoundTimer = setTimeout(() => {
    missingSoundTimer = null;
    missingSoundReported = true;
    const list = [...missingSounds].join(", ");
    setStatus(`Playing — sound not found: ${list}`, "error");
    reportToModel(
      `Strudel widget: sound not found: ${list}. The pattern is running, but that ` +
        "part is silent — use a sound name from the guide's 'sounds' topic.",
    );
  }, 900);
}

/** Console methods as they were before installConsoleWatch(), for teardown. */
const originalConsole: Partial<Record<"log" | "error", (...args: any[]) => void>> = {};

function installConsoleWatch(): void {
  if (consoleWatchInstalled) return;
  consoleWatchInstalled = true;
  for (const level of ["log", "error"] as const) {
    const original = console[level].bind(console);
    originalConsole[level] = console[level];
    console[level] = (...args: unknown[]) => {
      try {
        const match = MISSING_SOUND_RE.exec(args.map(String).join(" "));
        if (match) noteMissingSound(match[1]);
      } catch { /* never let the watch break logging */ }
      original(...args);
    };
  }
}

/** Hand the console back untouched when the host discards this widget. */
function removeConsoleWatch(): void {
  if (!consoleWatchInstalled) return;
  consoleWatchInstalled = false;
  for (const level of ["log", "error"] as const) {
    const original = originalConsole[level];
    if (original) console[level] = original;
    delete originalConsole[level];
  }
}

/** Reveal/stage the visual layers the given pattern asks for. */
function stageVisuals(code: string): void {
  const intent = detectViz(code);
  // Stage the Hydra layer BEFORE evaluation so the canvas Hydra creates is
  // adopted and sized while hydra-synth is still importing.
  setHydraActive(intent.hydra);
  if (!vizManual) {
    vizVisible = intent.any;
    applyVizVisibility();
  }
  if (intent.any && vizVisible) {
    // applyVizVisibility() defers sizing to the next frame; Hydra may init
    // sooner than that (it only awaits the hydra-synth import), so size now.
    syncVizCanvasSize();
  }
}

/** The Error @strudel/repl parked from the last evaluation, if it failed. */
function readEvalError(): Error | null {
  const state = getEditor()?.repl?.state;
  const err = state?.evalError ?? state?.schedulerError;
  return err instanceof Error ? err : err ? new Error(String(err)) : null;
}

/** Whether the scheduler is actually running (not what we hoped it would do). */
function isSchedulerStarted(): boolean {
  return getEditor()?.repl?.state?.started === true;
}

/**
 * Tell the model what the widget is actually doing, without needing a user turn.
 * Exactly one call per evaluation — never per frame.
 */
function reportToModel(text: string): void {
  if (!canUpdateModelContext) return;
  void app
    .updateModelContext({ content: [{ type: "text", text }] })
    .catch(() => { /* context updates are best-effort */ });
}

/** Status line + model context for one finished evaluation. */
function reportEvaluation(code: string, thrown: Error | null): void {
  const err = thrown ?? readEvalError();
  const soundfontNote = soundfontWarning
    ? " (soundfonts unavailable — audio may be silent)"
    : "";

  if (err) {
    const msg = err.message || String(err);
    setStatus(`Error: ${msg}`, "error");
    // Correct the play state from the scheduler rather than assuming: a failed
    // re-evaluation leaves the PREVIOUS pattern running.
    const playing = isSchedulerStarted();
    isPlaying = playing;
    playBtn.classList.toggle("playing", playing);
    playBtn.textContent = playing ? "Playing" : "Play";
    reportToModel(`Strudel widget: pattern failed to evaluate — ${msg}`);
    return;
  }

  updatePlayState(isSchedulerStarted());
  if (soundfontWarning && isPlaying) {
    setStatus(`Playing...${soundfontNote}`, "playing");
  }
  const intent = detectViz(code);
  const layers = [
    intent.hydra ? "hydra shader" : null,
    intent.strudelViz ? "strudel draw canvas" : null,
  ].filter(Boolean);
  reportToModel(
    `Strudel widget: ${isPlaying ? "playing" : "loaded, not playing"}` +
      ` (visuals: ${layers.length ? layers.join(" + ") : "none"})${soundfontNote}`,
  );
}

/**
 * Wrap this StrudelMirror instance's evaluate() once, so every evaluation —
 * ours and the user's Ctrl+Enter — stages visuals and reports its outcome.
 */
function installEvaluateHook(editor: any): void {
  if (editor.__musicStudioHooked) return;
  editor.__musicStudioHooked = true;
  const original = editor.evaluate.bind(editor);
  editor.evaluate = async (shouldPlay?: unknown) => {
    // Idempotent, and cheap once it has taken. It must run here rather than at
    // CDN load: initHydra/H only land on globalThis when the REPL's eval scope
    // is published, which is after <strudel-editor> initialises.
    installEvalScopeHooks();
    snapshotStrudelGlobals();
    const code = typeof editor.code === "string" ? editor.code : currentCode;
    stageVisuals(code);
    // A fresh pattern gets a fresh missing-sound report.
    missingSounds.clear();
    missingSoundReported = false;
    if (missingSoundTimer !== null) {
      clearTimeout(missingSoundTimer);
      missingSoundTimer = null;
    }
    try {
      await original(shouldPlay !== false);
    } catch (err) {
      reportEvaluation(code, err as Error);
      return;
    }
    // Some of the clobbered globals (`time`) are only published onto globalThis
    // by the evaluation itself, so the pre-eval snapshot above cannot see them
    // on a cold widget. This second pass catches them, and no-ops once a
    // pattern has initialised Hydra (after which they are Hydra's, not
    // Strudel's). A widget whose FIRST pattern uses Hydra therefore has no
    // Strudel value to put back — nothing observable depends on it.
    snapshotStrudelGlobals();
    reportEvaluation(code, null);
  };
}

/**
 * <strudel-editor> dispatches an `update` CustomEvent carrying the whole repl
 * state whenever it changes. We report outcomes from the evaluate wrapper (one
 * message per evaluation), so this listener only keeps the Play button honest
 * for state changes we did not initiate — a pattern calling hush(), say. It
 * deliberately leaves the status text alone so it can't overwrite an error.
 */
function installStateListener(element: HTMLElement): void {
  if ((element as any).__musicStudioStateHooked) return;
  (element as any).__musicStudioStateHooked = true;
  element.addEventListener("update", (event) => {
    const started = (event as CustomEvent).detail?.started;
    if (typeof started !== "boolean" || started === isPlaying) return;
    isPlaying = started;
    playBtn.classList.toggle("playing", started);
    playBtn.textContent = started ? "Playing" : "Play";
  });
}

// =============================================================================
// Recording — tap Strudel's audio graph via MediaRecorder
// =============================================================================

function setupRecordingTap(): MediaStream | null {
  try {
    // After prebake(), audio functions are on globalThis, NOT window.strudel
    const audioCtx: AudioContext | undefined = (window as any).getAudioContext?.();
    if (!audioCtx) return null;

    const dest = audioCtx.createMediaStreamDestination();
    // Master output: superdough controller's destinationGain node
    const controller = (window as any).getSuperdoughAudioController?.();
    const masterGain = controller?.output?.destinationGain;
    if (masterGain?.connect) {
      masterGain.connect(dest);
      recordingMasterGain = masterGain;
      recordingDest = dest;
      return dest.stream;
    }
    return null;
  } catch {
    return null;
  }
}

function startRecording(): void {
  if (!recordingStream) {
    recordingStream = setupRecordingTap();
  }
  if (!recordingStream) {
    setStatus("Recording not available", "error");
    return;
  }

  recordedChunks = [];
  try {
    mediaRecorder = new MediaRecorder(recordingStream, {
      mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm",
    });
  } catch {
    setStatus("Recording not supported", "error");
    return;
  }

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    downloadBtn.disabled = recordedChunks.length === 0;
  };

  mediaRecorder.start(100);
  isRecording = true;
  recordBtn.classList.add("recording");
  recordBtn.textContent = "Stop Rec";
  setStatus("Recording...", "playing");
}

function stopRecording(): void {
  if (mediaRecorder?.state === "recording") {
    mediaRecorder.stop();
  }
  isRecording = false;
  recordBtn.classList.remove("recording");
  recordBtn.textContent = "Record";
  if (isPlaying) {
    setStatus("Playing...", "playing");
  } else {
    setStatus("Ready", "normal");
  }
}

async function handleDownload(): Promise<void> {
  if (recordedChunks.length === 0) return;
  if (!canDownload) {
    setStatus("Download not supported on this host", "error");
    return;
  }

  downloadBtn.disabled = true;
  downloadBtn.textContent = "...";
  try {
    // Decode recorded WebM → AudioBuffer → WAV for consistent format
    const blob = new Blob(recordedChunks, { type: "audio/webm" });
    const arrayBuf = await blob.arrayBuffer();
    const audioCtx: AudioContext | undefined = (window as any).getAudioContext?.();
    if (!audioCtx) throw new Error("No audio context");
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuf);
    const wavBase64 = audioBufferToWavBase64(audioBuffer);

    await app.downloadFile({
      contents: [
        {
          type: "resource",
          resource: {
            uri: "file:///strudel-recording.wav",
            mimeType: "audio/wav",
            blob: wavBase64,
          },
        },
      ],
    });
  } catch (err) {
    setStatus(`Download failed: ${(err as Error).message}`, "error");
  } finally {
    downloadBtn.textContent = "↓";
    downloadBtn.disabled = recordedChunks.length === 0;
  }
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

async function renderPattern(args: Record<string, unknown>) {
  const code = args.code as string | undefined;
  if (!code) return;

  lastRenderArgs = args;
  const bpm = args.bpm as number | undefined;
  const autoplay = args.autoplay as boolean | undefined;

  try {
    setStatus("Loading Strudel...");
    try {
      await loadStrudelCDN();
    } catch (cdnErr) {
      setStatus("Failed to load Strudel — click Retry", "error");
      showCdnError();
      return;
    }

    let finalCode = code;
    if (bpm) {
      finalCode = injectBpm(finalCode, bpm);
    }
    currentCode = finalCode;

    // Auto-reveal the visuals when the pattern includes a viz method, unless the
    // user has taken manual control of the "Visuals" toggle. (stageVisuals also
    // runs from the evaluate hook, so a Ctrl+Enter on hand-edited code stages
    // too; doing it here as well keeps autoplay:false patterns showing the
    // backdrop they asked for.)
    stageVisuals(finalCode);

    // Create the <strudel-editor> element programmatically (no innerHTML sink).
    // The code is loaded via the safe editor.setCode() API below.
    if (!editorEl) {
      const newEditor = document.createElement("strudel-editor");
      container.replaceChildren(newEditor);
      editorEl = newEditor;
    }

    setStatus("Initializing...");
    const editor = await waitForEditor();
    // Route every evaluation (ours and the user's Ctrl+Enter) through one hook.
    installEvaluateHook(editor);
    installEvalScopeHooks();
    if (editorEl) installStateListener(editorEl);

    // Fix the broken layout (hide canvas, ensure editor visible)
    fixLayout();
    // Re-check layout after a short delay (canvas may be created lazily)
    setTimeout(fixLayout, 500);
    setTimeout(fixLayout, 1500);

    editor.setCode(finalCode);

    // Enable recording once pattern is loaded
    recordBtn.disabled = false;

    // Surface a non-blocking warning if soundfont registration failed —
    // explains silent/absent audio rather than swallowing it.
    const soundfontNote = soundfontWarning
      ? " (soundfonts unavailable — audio may be silent)"
      : "";

    if (autoplay !== false) {
      setStatus("Evaluating...");
      // The hook reports the real outcome (including async eval failures) to the
      // status line and the model — no optimistic "Playing..." here.
      await editor.evaluate(true);
    } else {
      setStatus(`Ready — click Play or Ctrl+Enter${soundfontNote}`, "normal");
    }
  } catch (err) {
    setStatus(`Error: ${(err as Error).message}`, "error");
  }
}

// =============================================================================
// Controls
// =============================================================================

playBtn.addEventListener("click", async () => {
  const editor = getEditor();
  if (!editor) return;
  try {
    if (isPlaying) {
      if (isRecording) stopRecording();
      editor.stop();
      updatePlayState(false);
    } else {
      // evaluate() always runs the LIVE buffer (editor.code), so a pattern the
      // user edited in the REPL is what plays. The hook stages its visuals and
      // reports the outcome, so there is no optimistic state to set here.
      setStatus("Evaluating...");
      await editor.evaluate(true);
    }
  } catch (err) {
    setStatus(`Playback error: ${(err as Error).message}`, "error");
  }
});

recordBtn.addEventListener("click", () => {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
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

// Fullscreen toggle
fullscreenBtn.addEventListener("click", () => {
  app.requestDisplayMode({ mode: "fullscreen" });
});

// Visuals toggle — once clicked, the user's choice sticks across re-renders.
// Guard the reveal: visuals only PAINT when the pattern has a viz method, so
// turning them on for a plain pattern would show an empty dark stage. Turning
// OFF always works; turning ON requires a draw method (else nudge the user).
vizBtn.addEventListener("click", () => {
  if (!vizVisible && !detectViz(getLiveCode()).any) {
    setStatus(
      "Add .pianoroll(), .scope() or `await initHydra()` to the pattern to see visuals",
      "normal",
    );
    return;
  }
  vizManual = true;
  vizVisible = !vizVisible;
  applyVizVisibility();
});

// Keep the canvas backing store DPR-correct as the editor/iframe resizes.
vizResizeObserver = new ResizeObserver(() => syncVizCanvasSize());
vizResizeObserver.observe(replSection);

// =============================================================================
// MCP ext-apps Integration
// =============================================================================

// Register notification handlers BEFORE connect() — the SDK drops
// notifications that have no handler registered at arrival time.
app.ontoolinput = (params) => {
  renderPattern(params.arguments ?? {});
};

app.ontoolinputpartial = (params) => {
  const code = params.arguments?.code as string | undefined;
  if (!code) return;
  setStatus("Composing pattern...");
  const editor = getEditor();
  if (editor?.setCode) {
    editor.setCode(code);
  }
};

// Generation cancelled — clear the stuck "Composing pattern..." status
// (mirrors the ABC widget).
app.ontoolcancelled = (params) => {
  const reason = params?.reason ? ` (${params.reason})` : "";
  setStatus(`Generation cancelled${reason}.`, "normal");
};

// Stop all audio + recording and release the recording tap when the host
// tears this instance down, so a discarded widget leaves nothing running.
app.onteardown = () => {
  try {
    if (isRecording) stopRecording();
    if (mediaRecorder?.state === "recording") mediaRecorder.stop();
    mediaRecorder = null;
    const editor = getEditor();
    editor?.stop?.();
    updatePlayState(false);
    // Disconnect ONLY the recording tap from the master output (not the
    // speakers): masterGain.disconnect(dest) targets just our tap edge.
    if (recordingMasterGain && recordingDest) {
      try {
        (recordingMasterGain as any).disconnect(recordingDest);
      } catch { /* edge may already be gone */ }
    }
    recordingMasterGain = null;
    recordingDest = null;
    recordingStream?.getTracks().forEach((t) => t.stop());
    recordingStream = null;
    vizResizeObserver?.disconnect();
    vizResizeObserver = null;
    hydraCanvasObserver.disconnect();
    if (hydraLateResize !== null) {
      clearTimeout(hydraLateResize);
      hydraLateResize = null;
    }
    if (missingSoundTimer !== null) {
      clearTimeout(missingSoundTimer);
      missingSoundTimer = null;
    }
    removeConsoleWatch();
    // Stop Hydra's WebGL render loop too — it runs independently of the
    // Strudel scheduler and would otherwise keep the GPU busy after teardown.
    setHydraActive(false);
  } catch { /* best-effort cleanup */ }
  return {};
};

app.onerror = console.error;

// Connect, then read host capabilities and gate features accordingly.
app.connect().then(() => {
  const caps = app.getHostCapabilities();

  // Download is host-mediated; if unsupported (e.g. mobile), hide the
  // download/record flow so users don't hit a raw -32601 error.
  canDownload = !!caps?.downloadFile;
  // Runtime feedback to the model (eval failures, what's actually playing).
  canUpdateModelContext = !!caps?.updateModelContext;
  if (!canDownload) {
    downloadBtn.hidden = true;
    recordBtn.hidden = true;
    recordBtn.title = "Recording export not supported on this host";
  }

  // "Send to chat" needs the host to accept ui/message.
  if (caps?.message) {
    sendBtn.hidden = false;
  }
});
