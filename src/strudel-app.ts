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
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import { detectViz } from "./shared/viz-detect";
import { injectTempo } from "./shared/tempo";
import { applyVisualPreset } from "./shared/visual-presets";
import { audioBufferToWavBase64 } from "./wav-encoder";
import { sanitizeFileStem } from "./bytes-to-base64";
import { VERSION } from "./version";

const STRUDEL_CDN = "https://unpkg.com/@strudel/repl@1.3.0";

const app = new App({ name: "Strudel Live Pattern", version: VERSION });

const playBtn = document.getElementById("play-btn") as HTMLButtonElement;
const recordBtn = document.getElementById("record-btn") as HTMLButtonElement;
const downloadBtn = document.getElementById("download-btn") as HTMLButtonElement;
const sendBtn = document.getElementById("send-btn") as HTMLButtonElement;
const fullscreenBtn = document.getElementById("fullscreen-btn") as HTMLButtonElement;
const vizBtn = document.getElementById("viz-btn") as HTMLButtonElement;
const stageBtn = document.getElementById("stage-btn") as HTMLButtonElement;
const titleEl = document.getElementById("pattern-title") as HTMLElement;
const replSection = document.querySelector(".repl-section") as HTMLElement;
const mainEl = document.querySelector(".main") as HTMLElement;
const vizCanvas = document.getElementById("test-canvas") as HTMLCanvasElement;
const statusEl = document.getElementById("status")!;
const container = document.getElementById("strudel-container")!;

let editorEl: HTMLElement | null = null;
let currentCode = "";
let isPlaying = false;

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
    () => { soundfontWarning = false; },
    () => { soundfontWarning = true; },
  );
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
// @strudel/hydra@1.3.0's initHydra() reads (verified against the live bundle,
// and pinned by tests/hydra-contract.test.ts against the real source):
//
//   async function initHydra(opts = {}) {
//     if (latestOptions && JSON.stringify(latestOptions) !== JSON.stringify(opts))
//       document.getElementById("hydra-canvas")?.remove();
//     latestOptions = opts;
//     if (!document.getElementById("hydra-canvas")) {
//       const { canvas } = getDrawContext("hydra-canvas", { contextType: "webgl", ... });
//       await import("https://unpkg.com/hydra-synth");
//       hydra = new Hydra({ ...opts, canvas });
//       if (feedStrudel) { getDrawContext().canvas.style.display = "none"; ... }
//     }
//     return hydra;
//   }
//
// Note what the guard covers: with UNCHANGED options the whole block is skipped
// and the existing instance is returned as-is. So anything that block does —
// the feedStrudel hide, and the engine construction that starts a render loop —
// must be re-established by our wrapper, or a second Ctrl+Enter on the same
// pattern silently loses it.
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
  hydraActive = active;
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
  // Stage mode shows ONLY the visuals; with the visuals off it would be a blank
  // rectangle, so leaving them takes the stage down too.
  if (!vizVisible && stageMode) {
    stageMode = false;
    applyStageMode();
  }
  syncStageAffordance();
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

function applyEditorTheme(editor: any, theme: string | undefined): void {
  if (theme && theme !== currentTheme) {
    try {
      // updateSettings() also reads fontSize/fontFamily off the object it is
      // given, so merge over the element's current settings rather than handing
      // it a lone { theme } and clobbering those with undefined.
      const base = (editorEl as any)?.settings ?? {};
      editor.updateSettings({ ...base, theme });
      currentTheme = theme;
    } catch {
      // An unknown name is non-fatal upstream (activateTheme warns and falls
      // back to strudelTheme); the scrim below still follows whatever landed.
    }
  }
  syncVizTheme();
}

/** `#abc` / `#aabbcc` / `rgb()` / `rgba()` → [r, g, b], or null if unparseable. */
function parseCssColor(value: string): [number, number, number] | null {
  const text = value.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(text);
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      digits = digits.slice(0, 3).split("").map((c) => c + c).join("");
    }
    if (digits.length < 6) return null;
    return [
      parseInt(digits.slice(0, 2), 16),
      parseInt(digits.slice(2, 4), 16),
      parseInt(digits.slice(4, 6), 16),
    ];
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
      return [parts[0], parts[1], parts[2]];
    }
  }
  return null;
}

/**
 * Rebuild the visuals stage + readability scrim from the ACTIVE editor theme.
 *
 * The v0.4.2 scrim was a hard-coded near-black. Under a light theme
 * (githubLight, xcodeLight, solarizedLight, …) that put dark syntax colours on
 * a dark veil — unreadable. Deriving both from the theme's own `--background`
 * keeps one rule working in both directions: the stage IS the editor background
 * and the veil is that same colour, so only the animation shows through.
 */
function syncVizTheme(): void {
  const background = getComputedStyle(document.documentElement)
    .getPropertyValue("--background");
  const rgb = parseCssColor(background);
  if (!rgb) return;
  const [r, g, b] = rgb;
  // Rec. 709 relative luminance, 0..1.
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const isLight = luminance > 0.5;
  const style = replSection.style;
  style.setProperty("--viz-stage", `rgb(${r}, ${g}, ${b})`);
  // A light theme needs a HEAVIER veil: dark code over a bright moving image is
  // a worse contrast case than light code over a dark one.
  style.setProperty("--viz-scrim", `rgba(${r}, ${g}, ${b}, ${isLight ? 0.72 : 0.5})`);
  style.setProperty("--viz-gutter-scrim", `rgba(${r}, ${g}, ${b}, ${isLight ? 0.58 : 0.3})`);
  // The glow that lifts code off the animation has to flip with it, or it turns
  // into a dark smear around dark text.
  style.setProperty(
    "--viz-code-shadow",
    isLight ? "0 1px 2px rgba(255, 255, 255, 0.95)" : "0 1px 2px rgba(0, 0, 0, 0.95)",
  );
}

// =============================================================================
// Audio-reactive visuals — `a`, driven by Strudel's OWN output
//
// hydra-synth's `a` comes from `new Audio(...)`, which opens the MICROPHONE via
// getUserMedia and runs Meyda over it. @strudel/hydra passes `detectAudio:false`
// (so `a` is simply undefined in the REPL) — which is right: we do not want a
// permission prompt, and the mic hears the room, not the pattern.
//
// So we build the same object over an AnalyserNode tapped off the SAME master
// bus the recorder taps (`getSuperdoughAudioController().output.destinationGain`).
// Every hydra tutorial that reads `a.fft[0]`, `a0()`, `a.setBins(6)`,
// `a.setSmooth(...)`, `a.setCutoff(...)`, `a.setScale(...)`, `a.show()/hide()`
// works verbatim — but reacting to the music the widget is playing.
//
// Value semantics are ported from hydra-synth 1.4.0 src/lib/audio.js:
//   bins[i]  = raw[i] * (1 - smooth) + prevBins[i] * smooth
//   fft[i]   = max(0, (bins[i] - settings[i].cutoff) / settings[i].scale)
// with the same defaults (4 bins, cutoff 2, scale 10, smooth 0.4, max 15).
// The one deviation: hydra SUMS Meyda's bark-band loudness per band, which has
// no meaning for an FFT magnitude array, so `raw` here is the band's mean
// magnitude normalised 0..1 and then scaled by `max` into hydra's units — which
// is what puts a loud band near fft ≈ 1.3 and silence at 0, the range the
// cutoff/scale defaults were tuned for.
// =============================================================================

const ANALYSER_FFT_SIZE = 256;
const ANALYSER_SMOOTHING = 0.8;
/** Musical range. The -100..-30 dB default squashes Strudel's output flat. */
const ANALYSER_MIN_DB = -90;
const ANALYSER_MAX_DB = -20;
/** How long to keep looking for Hydra after a render asks for it. */
const ANALYSER_WAIT_MS = 20000;

interface AudioBandSetting {
  cutoff: number;
  scale: number;
  smooth: number;
}

interface StrudelAudioApi {
  vol: number;
  cutoff: number;
  scale: number;
  smooth: number;
  max: number;
  bins: number[];
  prevBins: number[];
  fft: number[];
  settings: AudioBandSetting[];
  isDrawing: boolean;
  setBins(count: number): void;
  setCutoff(value: number): void;
  setSmooth(value: number): void;
  setScale(value: number): void;
  setMax(value: number): void;
  show(): void;
  hide(): void;
  tick(): void;
}

let audioApi: StrudelAudioApi | null = null;
let analyserNode: AnalyserNode | null = null;
let analyserTapSource: AudioNode | null = null;
let analyserBytes: Uint8Array<ArrayBuffer> | null = null;
let analyserRaf: number | null = null;
let analyserDeadline = 0;
let audioMeterCanvas: HTMLCanvasElement | null = null;
/** `a0`…`aN` globals we installed, so teardown can take them back off. */
let installedBandGlobals: string[] = [];

/**
 * Hydra is live exactly when its canvas exists — @strudel/hydra uses the same
 * fact as its own "already initialised" flag.
 *
 * `hydraInstance` is captured by the initHydra() wrapper; the canvas check
 * covers the window between adoption and the wrapper resolving.
 */
function isHydraLive(): boolean {
  if (hydraInstance || hydraActive) return true;
  return document.getElementById("hydra-canvas") !== null;
}

/** Tap the master bus with an AnalyserNode. Idempotent; false until audio exists. */
function ensureAnalyser(): boolean {
  if (analyserNode) return true;
  try {
    // The AudioContext is lazy — it only exists once something has played.
    const ctx: AudioContext | undefined = (window as any).getAudioContext?.();
    if (!ctx) return false;
    const controller = (window as any).getSuperdoughAudioController?.();
    const master: AudioNode | undefined = controller?.output?.destinationGain;
    if (!master?.connect) return false;
    const node = ctx.createAnalyser();
    node.fftSize = ANALYSER_FFT_SIZE;
    node.smoothingTimeConstant = ANALYSER_SMOOTHING;
    node.minDecibels = ANALYSER_MIN_DB;
    node.maxDecibels = ANALYSER_MAX_DB;
    // Tap only: the analyser is never connected onward, so it reads the bus
    // without adding a second path to the speakers.
    master.connect(node);
    analyserTapSource = master;
    analyserNode = node;
    analyserBytes = new Uint8Array(node.frequencyBinCount);
    return true;
  } catch {
    return false;
  }
}

/** hydra-synth's debug meter, ported — `a.show()` draws the live band levels. */
function drawAudioMeter(api: StrudelAudioApi): void {
  if (!audioMeterCanvas) return;
  const ctx = audioMeterCanvas.getContext("2d");
  if (!ctx) return;
  const { width, height } = audioMeterCanvas;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#DFFFFF";
  const spacing = width / Math.max(1, api.bins.length);
  const scale = height / (api.max * 2);
  api.bins.forEach((bin, index) => {
    const barHeight = bin * scale;
    ctx.fillRect(index * spacing, height - barHeight, spacing - 1, barHeight);
  });
}

function createAudioApi(): StrudelAudioApi {
  const api: StrudelAudioApi = {
    vol: 0,
    cutoff: 2,
    scale: 10,
    smooth: 0.4,
    max: 15,
    bins: [],
    prevBins: [],
    fft: [],
    settings: [],
    isDrawing: false,

    setBins(count: number) {
      const n = Math.max(1, Math.floor(count) || 1);
      api.bins = new Array(n).fill(0);
      api.prevBins = new Array(n).fill(0);
      api.fft = new Array(n).fill(0);
      api.settings = new Array(n).fill(0).map(() => ({
        cutoff: api.cutoff,
        scale: api.scale,
        smooth: api.smooth,
      }));
      // hydra installs a0()…aN() alongside a.fft; tutorials use both forms.
      for (const name of installedBandGlobals) delete (window as any)[name];
      installedBandGlobals = [];
      for (let i = 0; i < n; i++) {
        const name = `a${i}`;
        (window as any)[name] = (scale = 1, offset = 0) => () => api.fft[i] * scale + offset;
        installedBandGlobals.push(name);
      }
    },

    setCutoff(value: number) {
      api.cutoff = value;
      api.settings = api.settings.map((s) => ({ ...s, cutoff: value }));
    },
    setSmooth(value: number) {
      api.smooth = value;
      api.settings = api.settings.map((s) => ({ ...s, smooth: value }));
    },
    setScale(value: number) {
      api.scale = value;
      api.settings = api.settings.map((s) => ({ ...s, scale: value }));
    },
    setMax(value: number) {
      api.max = value;
    },

    show() {
      api.isDrawing = true;
      if (!audioMeterCanvas) {
        const canvas = document.createElement("canvas");
        canvas.width = 100;
        canvas.height = 80;
        canvas.className = "audio-meter";
        replSection.appendChild(canvas);
        audioMeterCanvas = canvas;
      }
      audioMeterCanvas.style.display = "block";
    },
    hide() {
      api.isDrawing = false;
      if (audioMeterCanvas) audioMeterCanvas.style.display = "none";
    },

    tick() {
      const node = analyserNode;
      const bytes = analyserBytes;
      if (!node || !bytes) return;
      node.getByteFrequencyData(bytes);
      const count = api.bins.length;
      const spacing = Math.max(1, Math.floor(bytes.length / count));
      api.prevBins = api.bins.slice(0);
      let total = 0;
      for (let i = 0; i < count; i++) {
        const start = i * spacing;
        const end = Math.min(start + spacing, bytes.length);
        let sum = 0;
        for (let j = start; j < end; j++) sum += bytes[j];
        // Mean magnitude 0..1, then into hydra's loudness units via `max`.
        const level = sum / Math.max(1, end - start) / 255;
        const raw = level * api.max;
        const smooth = api.settings[i].smooth;
        api.bins[i] = raw * (1 - smooth) + api.prevBins[i] * smooth;
        total += api.bins[i];
      }
      api.vol = total / Math.max(1, count);
      for (let i = 0; i < count; i++) {
        api.fft[i] = Math.max(
          0,
          (api.bins[i] - api.settings[i].cutoff) / api.settings[i].scale,
        );
      }
      if (api.isDrawing) drawAudioMeter(api);
    },
  };
  api.setBins(4);
  return api;
}

/**
 * Publish `a` (and a0…a3) into the REPL's eval scope. Installed eagerly once an
 * editor exists, so a shader's `() => a.fft[0] * 4` never sees an undefined `a`
 * on Hydra's first frame — the analyser attaches later, and until it does the
 * bands simply read 0.
 */
function installAudioReactiveGlobals(): void {
  if (!audioApi) audioApi = createAudioApi();
  (window as any).a = audioApi;
}

/**
 * Drive the band analysis. Runs ONLY while Hydra is up — a pattern with no
 * shader has nothing to react, so there is no reason to burn a frame callback.
 * The loop stops itself once Hydra's canvas is gone.
 */
function startAnalyserLoop(): void {
  analyserDeadline = performance.now() + ANALYSER_WAIT_MS;
  if (analyserRaf !== null) return;
  const frame = (now: number) => {
    if (isHydraLive()) {
      // Keep the window open while Hydra is alive; close it once it goes.
      analyserDeadline = now + 1000;
      if (analyserNode || ensureAnalyser()) audioApi?.tick();
    } else if (now > analyserDeadline) {
      analyserRaf = null;
      return;
    }
    analyserRaf = requestAnimationFrame(frame);
  };
  analyserRaf = requestAnimationFrame(frame);
}

function stopAnalyserLoop(): void {
  if (analyserRaf !== null) {
    cancelAnimationFrame(analyserRaf);
    analyserRaf = null;
  }
}

function teardownAudioAnalyser(): void {
  stopAnalyserLoop();
  if (analyserTapSource && analyserNode) {
    try {
      (analyserTapSource as any).disconnect(analyserNode);
    } catch { /* edge may already be gone */ }
  }
  analyserTapSource = null;
  analyserNode = null;
  analyserBytes = null;
  for (const name of installedBandGlobals) delete (window as any)[name];
  installedBandGlobals = [];
  delete (window as any).a;
  audioApi = null;
  audioMeterCanvas?.remove();
  audioMeterCanvas = null;
}

// =============================================================================
// Stage mode — the visuals without the code
//
// Composes with the host's fullscreen display mode rather than replacing it:
// "Stage" hides #strudel-container so the backdrop canvases (already absolutely
// filling .repl-section) become the whole frame, and "⛶" asks the host for more
// frame to fill. Either is useful alone; together they are a projector.
// =============================================================================

let stageMode = false;

function applyStageMode(): void {
  replSection.classList.toggle("stage-on", stageMode);
  stageBtn.classList.toggle("active", stageMode);
  stageBtn.setAttribute("aria-pressed", String(stageMode));
  stageBtn.textContent = stageMode ? "Code" : "Stage";
  stageBtn.title = stageMode
    ? "Show the code again (Esc)"
    : "Stage mode — hide the code and let the visuals fill the frame";
  if (stageMode) requestAnimationFrame(syncVizCanvasSize);
}

/**
 * Dim the button when there is nothing to stage, but leave it CLICKABLE so the
 * click can say why — same choice the "Visuals" toggle already makes. A
 * genuinely disabled button just swallows the question.
 */
function syncStageAffordance(): void {
  const usable = vizVisible || stageMode;
  stageBtn.setAttribute("aria-disabled", String(!usable));
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
  if (intent.hydra) {
    // Make `a` resolvable before the shader's first frame, and start reading
    // the master bus (see the audio-reactive section).
    installAudioReactiveGlobals();
    startAnalyserLoop();
  }
  if (!vizManual) {
    // Reduced motion: never reveal a moving backdrop on our own initiative.
    // The "Visuals" button still works — that is the user asking.
    vizVisible = intent.any && !prefersReducedMotion();
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

/**
 * Whether the pattern the REPL just accepted produces NO events.
 *
 * "Playing…" with a pattern that is `silence` is the widget's most misleading
 * state: evaluation succeeded, the scheduler runs, nothing sounds. The REPL
 * plays the LAST expression, so `pattern; all(...)` or `pattern; setcps(...)`
 * hands it undefined → silence, without an error. Query-time errors are
 * swallowed by queryArc() the same way (an empty result), so both shapes land
 * here. Bounded to a few cycles; a slow-building pattern (`<~ ~ ~ x>`) that
 * genuinely rests through the window is a false positive we accept, which is
 * why the wording is "produces no events", not "is broken".
 */
const SILENCE_CHECK_CYCLES = 4;
function patternIsSilent(): boolean {
  const pattern = getEditor()?.repl?.state?.pattern;
  if (!pattern || typeof pattern.queryArc !== "function") return false;
  try {
    return pattern.queryArc(0, SILENCE_CHECK_CYCLES).length === 0;
  } catch {
    return true;
  }
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

// -----------------------------------------------------------------------------
// Playback-state reports
//
// Evaluation reports itself (reportEvaluation below). What used to go
// unreported is everything that stops playback WITHOUT an evaluation: the user
// pressing Stop, a pattern calling hush(), the scheduler falling over. Those
// only flipped the Play button, so the model's last known state stayed
// "playing" — and it would answer questions about a silent widget as if the
// music were still running.
//
// One bounded message per real transition: coalesced by a 500ms debounce (the
// `update` event can arrive in bursts), and suppressed entirely when the state
// is the one already reported. Never per frame.
// -----------------------------------------------------------------------------

const MODEL_STATE_DEBOUNCE_MS = 500;

let modelStateTimer: ReturnType<typeof setTimeout> | null = null;
/** Playing-state the model has been told about, so we only send transitions. */
let lastReportedPlaying: boolean | null = null;
/** Error text from the last failed evaluation, carried into stop reports. */
let lastEvalErrorText: string | null = null;

function cancelStateReport(): void {
  if (modelStateTimer !== null) {
    clearTimeout(modelStateTimer);
    modelStateTimer = null;
  }
}

/** Note a state we have just reported ourselves, so the debounce won't repeat it. */
function markReportedPlaying(playing: boolean, errorText: string | null): void {
  cancelStateReport();
  lastReportedPlaying = playing;
  lastEvalErrorText = errorText;
}

/** Report a stop/start that no evaluation announced. Debounced, deduplicated. */
function scheduleStateReport(): void {
  if (!canUpdateModelContext) return;
  cancelStateReport();
  modelStateTimer = setTimeout(() => {
    modelStateTimer = null;
    const playing = isSchedulerStarted();
    if (playing === lastReportedPlaying) return;
    lastReportedPlaying = playing;
    const errorNote = lastEvalErrorText ? ` (last error: ${lastEvalErrorText})` : "";
    reportToModel(
      playing
        ? `Strudel widget: playing again${errorNote}`
        : `Strudel widget: playback stopped — nothing is sounding now${errorNote}`,
    );
  }, MODEL_STATE_DEBOUNCE_MS);
}

/** Status line + model context for one finished evaluation. */
function reportEvaluation(
  code: string,
  thrown: Error | null,
  tempoAtRuntime = false,
): void {
  const err = thrown ?? readEvalError();
  const soundfontNote = soundfontWarning
    ? " (soundfonts unavailable — audio may be silent)"
    : "";
  const tempoNote = tempoAtRuntime
    ? " — tempo applied at runtime: the pattern defines its own setcps"
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
    markReportedPlaying(playing, msg);
    reportToModel(
      `Strudel widget: pattern failed to evaluate — ${msg}` +
        (playing ? " (the previous pattern is still playing)" : " (nothing is playing)"),
    );
    return;
  }

  updatePlayState(isSchedulerStarted());
  markReportedPlaying(isPlaying, null);
  if (isPlaying && patternIsSilent()) {
    setStatus("Playing — but the pattern produces no events (silent)", "error");
    reportToModel(
      "Strudel widget: the pattern evaluated and the scheduler is running, but it " +
        `produces NO events in the first ${SILENCE_CHECK_CYCLES} cycles — nothing will sound. ` +
        "The REPL plays the LAST expression: make sure the pattern is the final statement " +
        "(all(), setcps() and helpers go before it), and that every layer yields events.",
    );
    return;
  }
  if ((soundfontWarning || tempoAtRuntime) && isPlaying) {
    setStatus(`Playing...${soundfontNote}${tempoNote}`, "playing");
  }
  const intent = detectViz(code);
  const layers = [
    intent.hydra ? "hydra shader" : null,
    intent.strudelViz ? "strudel draw canvas" : null,
  ].filter(Boolean);
  reportToModel(
    `Strudel widget: ${isPlaying ? "playing" : "loaded, not playing"}` +
      ` (visuals: ${layers.length ? layers.join(" + ") : "none"})${soundfontNote}${tempoNote}`,
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
    // The pattern owns the `setcps` name, so the requested bpm could not be
    // written into the source — apply it now that the scheduler is up.
    const tempoAtRuntime = applyRuntimeTempo();
    reportEvaluation(code, null, tempoAtRuntime);
  };
}

/**
 * <strudel-editor> dispatches an `update` CustomEvent carrying the whole repl
 * state whenever it changes. We report outcomes from the evaluate wrapper (one
 * message per evaluation), so this listener handles the state changes we did
 * NOT initiate — a pattern calling hush(), the scheduler stopping — keeping the
 * Play button honest and telling the model the music has stopped (debounced, and
 * skipped when the evaluate report already said so). It deliberately leaves the
 * status text alone so it can't overwrite an error.
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
    scheduleStateReport();
  });
}

// =============================================================================
// Recording — tap Strudel's audio graph via MediaRecorder
//
// Container negotiation: WebM/Opus is what Chromium gives us, but Safari and
// WKWebView (which is what an ext-apps host is on macOS/iOS) record MP4/AAC and
// support NO webm at all — the old code tried two webm types and gave up, so
// "Record" was simply dead there. Walk a candidate list through
// MediaRecorder.isTypeSupported() instead, and keep whichever type was actually
// negotiated so decodeAudioData() is handed a blob whose type is true.
//
// A recording also owns its own chunk array. The chunks used to live in a
// module-level `recordedChunks` that startRecording() reset, so a late
// `ondataavailable` from the PREVIOUS recorder appended into the new
// recording's buffer and the WAV came out spliced.
// =============================================================================

/** Tried in order; the first supported one wins. "" = let the UA choose. */
const RECORDING_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4;codecs=mp4a.40.2", // Safari / WKWebView
  "audio/mp4",
  "",
];

/** Bounds. A recording is decoded whole into memory, so it cannot be open-ended. */
const MAX_RECORDING_MINUTES = 5;
const MAX_RECORDING_MS = MAX_RECORDING_MINUTES * 60_000;
const MAX_RECORDING_BYTES = 50 * 1024 * 1024;

interface Recording {
  chunks: Blob[];
  mimeType: string;
  bytes: number;
}

/** The recorder currently filling, and the finished one the ↓ button exports. */
let activeRecording: Recording | null = null;
let lastRecording: Recording | null = null;
let recordingLimitTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * The MIME type to record in — `""` meaning "let the UA choose" — or null when
 * this browser has no MediaRecorder at all.
 *
 * The null case is why the `typeof` check is spelled out rather than folded
 * into the loop's `MediaRecorder?.isTypeSupported`: optional chaining does NOT
 * protect an UNDECLARED identifier. On a browser without MediaRecorder that
 * expression threw a ReferenceError, and it ran BEFORE the constructor's
 * try/catch — so the one handler written for exactly this case ("Recording not
 * supported on this browser") never saw it and the Record click died silently.
 */
function pickRecordingMime(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  const canCheck = typeof MediaRecorder.isTypeSupported === "function";
  for (const mime of RECORDING_MIME_CANDIDATES) {
    if (mime === "") break;
    if (!canCheck || MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return ""; // no named type claimed support — let the UA pick its default
}

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

  const mime = pickRecordingMime();
  if (mime === null) {
    setStatus("Recording not supported on this browser", "error");
    return;
  }
  try {
    mediaRecorder = mime
      ? new MediaRecorder(recordingStream, { mimeType: mime })
      : new MediaRecorder(recordingStream);
  } catch {
    setStatus("Recording not supported on this browser", "error");
    return;
  }

  // Closed over, so a late callback from a PREVIOUS recorder fills its own
  // buffer and can never splice itself into this recording.
  const recorder = mediaRecorder;
  const recording: Recording = {
    chunks: [],
    mimeType: recorder.mimeType || mime || "audio/webm",
    bytes: 0,
  };
  activeRecording = recording;

  recorder.ondataavailable = (e) => {
    if (e.data.size === 0) return;
    recording.chunks.push(e.data);
    recording.bytes += e.data.size;
    if (recording.bytes >= MAX_RECORDING_BYTES && activeRecording === recording) {
      stopRecording("size");
    }
  };

  recorder.onstop = () => {
    // The negotiated type is only reliably readable once recording has begun.
    recording.mimeType = recorder.mimeType || recording.mimeType;
    if (recording.chunks.length > 0) lastRecording = recording;
    downloadBtn.disabled = !lastRecording;
  };

  recorder.start(100);
  isRecording = true;
  recordBtn.classList.add("recording");
  recordBtn.textContent = "Stop Rec";
  setStatus("Recording...", "playing");

  if (recordingLimitTimer !== null) clearTimeout(recordingLimitTimer);
  recordingLimitTimer = setTimeout(() => {
    recordingLimitTimer = null;
    if (activeRecording === recording) stopRecording("time");
  }, MAX_RECORDING_MS);
}

/** `reason` is set when a bound tripped, so the status can say why it ended. */
function stopRecording(reason?: "time" | "size"): void {
  if (recordingLimitTimer !== null) {
    clearTimeout(recordingLimitTimer);
    recordingLimitTimer = null;
  }
  if (mediaRecorder?.state === "recording") {
    mediaRecorder.stop();
  }
  if (!isRecording) return;
  isRecording = false;
  activeRecording = null;
  recordBtn.classList.remove("recording");
  recordBtn.textContent = "Record";
  if (reason === "time") {
    setStatus(
      `Recording stopped at the ${MAX_RECORDING_MINUTES}-minute limit — ready to download`,
      "normal",
    );
    return;
  }
  if (reason === "size") {
    setStatus("Recording stopped at the size limit — ready to download", "normal");
    return;
  }
  if (isPlaying) {
    setStatus("Playing...", "playing");
  } else {
    setStatus("Ready", "normal");
  }
}

async function handleDownload(): Promise<void> {
  const recording = lastRecording;
  if (!recording || recording.chunks.length === 0) return;
  if (!canDownload) {
    setStatus("Download not supported on this host", "error");
    return;
  }

  downloadBtn.disabled = true;
  downloadBtn.textContent = "...";
  try {
    // Decode the recording (WebM/Opus, MP4/AAC, whatever was negotiated) →
    // AudioBuffer → WAV, so the exported format is the same everywhere.
    const blob = new Blob(recording.chunks, { type: recording.mimeType });
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
            uri: `file:///${recordingFileStem()}.wav`,
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
    downloadBtn.disabled = !lastRecording;
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

async function renderPattern(args: Record<string, unknown>) {
  const code = args.code as string | undefined;
  if (!code) return;

  // Every overlapping tool input gets its own generation; the older one stops
  // at its next checkpoint instead of writing into a buffer it no longer owns.
  const generation = ++renderGeneration;
  const superseded = () => generation !== renderGeneration;

  lastRenderArgs = args;
  const bpm = args.bpm as number | undefined;
  const autoplay = args.autoplay as boolean | undefined;
  pendingTheme = typeof args.theme === "string" ? args.theme : undefined;
  setPatternTitle(args.title);

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
    runtimeCps = null;
    if (bpm) {
      const tempo = injectTempo(finalCode, bpm);
      finalCode = tempo.code;
      // String compare, so this still builds against a tempo.ts whose policy
      // union predates the branch.
      if ((tempo.policy as string) === "unchanged-ambiguous") {
        runtimeCps = tempo.cps;
      }
    }
    // Fold in the `visuals` preset AFTER the tempo injection, so a Hydra recipe
    // keeps `await initHydra()` on the first line where the engine expects it.
    // Reduced motion drops the Hydra presets (a WebGL shader is exactly the
    // continuous animation that setting is asking us not to start).
    finalCode = applyVisualPreset(finalCode, args.visuals, {
      allowHydra: !prefersReducedMotion(),
    });
    currentCode = finalCode;
    pendingPartialCode = "";

    // Auto-reveal the visuals when the pattern includes a viz method, unless the
    // user has taken manual control of the "Visuals" toggle. (stageVisuals also
    // runs from the evaluate hook, so a Ctrl+Enter on hand-edited code stages
    // too; doing it here as well keeps autoplay:false patterns showing the
    // backdrop they asked for.)
    stageVisuals(finalCode);

    setStatus("Initializing...");
    const editor = await prepareEditor();
    if (superseded()) return;

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
    if (superseded()) return;
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
      // The model was last told "playing"; say the music has stopped.
      scheduleStateReport();
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

// Stage mode — visuals only. Dimmed but clickable with nothing to stage, so the
// click can explain itself instead of silently doing nothing.
stageBtn.addEventListener("click", () => {
  if (!stageMode && !vizVisible) {
    setStatus(
      "Stage mode needs a visual — add .pianoroll() or `await initHydra()`, or set the visuals parameter",
      "normal",
    );
    return;
  }
  stageMode = !stageMode;
  applyStageMode();
});

// Escape leaves the stage, the way it leaves any other "took over the frame"
// mode. Bound on the document so it works with focus inside CodeMirror.
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && stageMode) {
    stageMode = false;
    applyStageMode();
  }
});

syncStageAffordance();

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
    // Invalidate any in-flight render/boot so a late `await` can't repopulate
    // the DOM of a widget the host has already discarded.
    renderGeneration++;
    if (isRecording) stopRecording();
    if (mediaRecorder?.state === "recording") mediaRecorder.stop();
    mediaRecorder = null;
    activeRecording = null;
    if (recordingLimitTimer !== null) {
      clearTimeout(recordingLimitTimer);
      recordingLimitTimer = null;
    }
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
    // A pending state report would fire into a host that has already let go.
    cancelStateReport();
    removeConsoleWatch();
    // Stop Hydra's WebGL render loop too — it runs independently of the
    // Strudel scheduler and would otherwise keep the GPU busy after teardown.
    setHydraActive(false);
    // Release the analyser tap and take `a` / a0…aN back off the eval scope.
    teardownAudioAnalyser();
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
  if (ctx.safeAreaInsets) {
    mainEl.style.paddingTop = `${ctx.safeAreaInsets.top}px`;
    mainEl.style.paddingRight = `${ctx.safeAreaInsets.right}px`;
    mainEl.style.paddingBottom = `${ctx.safeAreaInsets.bottom}px`;
    mainEl.style.paddingLeft = `${ctx.safeAreaInsets.left}px`;
  }
}

app.onhostcontextchanged = handleHostContextChanged;

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

  const ctx = app.getHostContext();
  if (ctx) {
    handleHostContextChanged(ctx);
  }
});
