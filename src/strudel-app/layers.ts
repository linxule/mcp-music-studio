import { detectViz, drawLayerIds } from "../shared/viz-detect";
import * as widgetState from "./state";

interface LayersHost {
  replSection: HTMLElement;
  vizCanvas: HTMLCanvasElement;
  vizBtn: HTMLButtonElement;
  stageBtn: HTMLButtonElement;
  hasAudioApi(): boolean;
  installAudioReactiveGlobals(): void;
  startAnalyserLoop(): void;
  setHydraActive(active: boolean): void;
  prefersReducedMotion(): boolean;
}

/** Own the canvas stack; eval-scope/renderer lifetime remains in the entry. */
let replSection: LayersHost["replSection"];
let vizCanvas: LayersHost["vizCanvas"];
let vizBtn: LayersHost["vizBtn"];
let stageBtn: LayersHost["stageBtn"];
let hasAudioApi: LayersHost["hasAudioApi"];
let installAudioReactiveGlobals: LayersHost["installAudioReactiveGlobals"];
let startAnalyserLoop: LayersHost["startAnalyserLoop"];
let setHydraActive: LayersHost["setHydraActive"];
let prefersReducedMotion: LayersHost["prefersReducedMotion"];

export function initLayers(host: LayersHost): void {
  ({
    replSection, vizCanvas, vizBtn,
    stageBtn, hasAudioApi, installAudioReactiveGlobals,
    startAnalyserLoop, setHydraActive, prefersReducedMotion,
  } = host);

  // Catch the canvases the moment @strudel/hydra or getDrawContext('id')
  // prepends them to <body>.
  hydraCanvasObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (node instanceof HTMLCanvasElement && node.id === "hydra-canvas") {
          adoptHydraCanvas(node);
        } else if (isDrawLayer(node)) {
          adoptDrawLayer(node);
        }
      }
    }
  });
  hydraCanvasObserver.observe(document.body, { childList: true });
}

// Pending late re-apply of the Hydra resolution (see syncVizCanvasSize).
let hydraLateResize: ReturnType<typeof setTimeout> | null = null;
// Hydra renders at this many CSS px wide at most, then upscales (pixelated).
// 960px is plenty for a widget backdrop and keeps the GPU cost low inside the
// inline iframe; strudel.cc itself defaults to pixelRatio 1 at window size.
const HYDRA_MAX_WIDTH = 960;

let vizResizeObserver: ResizeObserver | null = null;

/**
 * Fix the strudel-editor layout:
 * - Hide the position:fixed canvas that covers the viewport
 * - Ensure the CodeMirror sibling div is visible
 */
export function fixLayout(): void {
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
    // A getDrawContext('id') layer: adopt it (the observer's backstop).
    if (isDrawLayer(el)) adoptDrawLayer(el);
  });

  // The editor content is a sibling AFTER <strudel-editor>. Its size is owned
  // by strudel-app.css (it fills the stage and scrolls inside it); an inline
  // min-height here used to let a long pattern grow the whole frame.
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
export function syncVizCanvasSize(): void {
  if (!widgetState.vizVisible) return;
  // The backdrop canvas fills the repl section; measure that element directly.
  const w = replSection.clientWidth;
  const h = replSection.clientHeight;
  if (w === 0 || h === 0) return;
  const dpr = window.devicePixelRatio || 1;
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (vizCanvas.width !== bw) vizCanvas.width = bw;
  if (vizCanvas.height !== bh) vizCanvas.height = bh;
  syncDrawLayerSizes();
  if (!widgetState.hydraActive) return;
  syncHydraCanvasSize(w, h);
  // getDrawContext installed its own debounced (200ms) window-resize handler
  // that rewrites the Hydra canvas to innerWidth × innerHeight without telling
  // hydra-synth, which would leave the viewport stretched. Re-apply after it.
  if (hydraLateResize !== null) clearTimeout(hydraLateResize);
  hydraLateResize = setTimeout(() => {
    hydraLateResize = null;
    if (widgetState.hydraActive && widgetState.vizVisible) {
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

export function getHydraCanvas(): HTMLCanvasElement | null {
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
export function adoptHydraCanvas(c: HTMLCanvasElement): void {
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

// -----------------------------------------------------------------------------
// Extra 2D layers — getDrawContext('layer2')
//
// Every 2D painter clears its canvas each frame, so two visuals on the default
// #test-canvas erase each other. Strudel's answer is a canvas per visual:
// `.pianoroll({ ctx: getDrawContext('layer2') })`. getDrawContext() creates
// that canvas the same way it creates Hydra's — a position:fixed, full-viewport
// child of <body> — and our stray-canvas rule used to hide it, so the second
// layer never showed. Now it is adopted like #hydra-canvas: into the visuals
// stack, over #test-canvas, sized with it. A layer the next pattern no longer
// names is removed (only #test-canvas is cleared upstream, so a stale layer
// would otherwise sit over the new pattern), and a stop clears them all.
// -----------------------------------------------------------------------------

/** Canvases a pattern created with getDrawContext('id'), adopted into the stack. */
const drawLayers = new Set<HTMLCanvasElement>();
/** Pending re-apply after getDrawContext's own debounced resize handler. */
let drawLayerLateResize: ReturnType<typeof setTimeout> | null = null;

function isDrawLayer(node: Node): node is HTMLCanvasElement {
  return (
    node instanceof HTMLCanvasElement &&
    node.id !== "hydra-canvas" &&
    node.id !== "test-canvas" &&
    node.parentElement === document.body
  );
}

function adoptDrawLayer(c: HTMLCanvasElement): void {
  if (c.parentElement !== replSection) {
    c.removeAttribute("style");
    c.className = "viz-canvas viz-layer";
    c.setAttribute("aria-hidden", "true");
    // Over #test-canvas, under the code, in creation order.
    replSection.insertBefore(c, strudelContainerEl());
  }
  drawLayers.add(c);
  sizeDrawLayer(c);
}

function strudelContainerEl(): Element | null {
  return replSection.querySelector(".strudel-container");
}

function sizeDrawLayer(c: HTMLCanvasElement): void {
  if (c.width === vizCanvas.width && c.height === vizCanvas.height) return;
  const w = replSection.clientWidth;
  const h = replSection.clientHeight;
  if (w === 0 || h === 0) return;
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
}

/** Size every layer like #test-canvas, now and after getDrawContext's resize handler. */
function syncDrawLayerSizes(): void {
  if (drawLayers.size === 0) return;
  drawLayers.forEach(sizeDrawLayer);
  if (drawLayerLateResize !== null) clearTimeout(drawLayerLateResize);
  drawLayerLateResize = setTimeout(() => {
    drawLayerLateResize = null;
    drawLayers.forEach(sizeDrawLayer);
  }, 320);
}

/**
 * After an evaluation: hide (and clear) the layers this pattern no longer
 * names, and show the ones it does. Hidden, not removed: getDrawContext()
 * finds a canvas by id and reuses it, while a removed one is re-created with a
 * SECOND window-resize listener (upstream never removes the first, which keeps
 * the detached canvas alive — Codex).
 */
export function pruneDrawLayers(code: string): void {
  const keep = drawLayerIds(code);
  for (const layer of Array.from(drawLayers)) {
    if (!layer.isConnected) {
      drawLayers.delete(layer);
      continue;
    }
    // A computed id (null) — can't tell which are in use, so show them all.
    const used = keep === null || keep.includes(layer.id);
    if (!used) clearLayer(layer);
    layer.classList.toggle("viz-layer-idle", !used);
  }
}

function clearLayer(layer: HTMLCanvasElement): void {
  try {
    layer.getContext("2d")?.clearRect(0, 0, layer.width, layer.height);
  } catch { /* a layer used as a WebGL context has no 2d; hiding it is enough */ }
}

/** A stop: the layers' last frames would otherwise stay painted. */
export function clearDrawLayers(): void {
  drawLayers.forEach(clearLayer);
}

let hydraCanvasObserver: MutationObserver;

/**
 * Resize the live Hydra layer. Once hydra-synth is running, writing
 * canvas.width/height behind its back desyncs its viewport, so go through the
 * setResolution() global it installs.
 *
 * getDrawContext() also registered its OWN debounced (200ms) window-resize
 * handler that resets the canvas to innerWidth × innerHeight without telling
 * Hydra. syncVizCanvasSize() schedules a late re-apply so ours lands last.
 */
export function syncHydraCanvasSize(w: number, h: number): void {
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

/** Reflect viz visibility on the backdrop + editor scrim + toggle button. */
export function applyVizVisibility(): void {
  // .viz-on reveals the backdrop canvas and makes the editor translucent (CSS).
  replSection.classList.toggle("viz-on", widgetState.vizVisible);
  vizBtn.classList.toggle("active", widgetState.vizVisible);
  vizBtn.setAttribute("aria-pressed", String(widgetState.vizVisible));
  if (widgetState.vizVisible) {
    // Backdrop just gained layout — size the backing store on the next frame.
    requestAnimationFrame(syncVizCanvasSize);
    // The analyser loop stops itself a second after the visuals go; showing
    // them again must restart it, or an onPaint() reading `a` froze (Codex).
    if (hasAudioApi()) startAnalyserLoop();
  }
  // Stage mode shows ONLY the visuals; with the visuals off it would be a blank
  // rectangle, so leaving them takes the stage down too.
  if (!widgetState.vizVisible && widgetState.stageMode) {
    widgetState.setStageMode(false);
    applyStageMode();
  }
  syncStageAffordance();
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
export function syncVizTheme(): void {
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
// Stage mode — the visuals without the code
//
// Composes with the host's fullscreen display mode rather than replacing it:
// "Stage" hides #strudel-container so the backdrop canvases (already absolutely
// filling .repl-section) become the whole frame, and "⛶" asks the host for more
// frame to fill. Either is useful alone; together they are a projector.
// =============================================================================

export function applyStageMode(): void {
  replSection.classList.toggle("stage-on", widgetState.stageMode);
  stageBtn.classList.toggle("active", widgetState.stageMode);
  stageBtn.setAttribute("aria-pressed", String(widgetState.stageMode));
  stageBtn.textContent = widgetState.stageMode ? "Code" : "Stage";
  stageBtn.title = widgetState.stageMode
    ? "Show the code again (Esc)"
    : "Stage mode — hide the code and let the visuals fill the frame";
  if (widgetState.stageMode) requestAnimationFrame(syncVizCanvasSize);
}

/**
 * Dim the button when there is nothing to stage, but leave it CLICKABLE so the
 * click can say why — same choice the "Visuals" toggle already makes. A
 * genuinely disabled button just swallows the question.
 */
export function syncStageAffordance(): void {
  const usable = widgetState.vizVisible || widgetState.stageMode;
  stageBtn.setAttribute("aria-disabled", String(!usable));
}

/** Reveal/stage the visual layers the given pattern asks for. */
export function stageVisuals(code: string): void {
  const intent = detectViz(code);
  // Stage the Hydra layer BEFORE evaluation so the canvas Hydra creates is
  // adopted and sized while hydra-synth is still importing.
  setHydraActive(intent.hydra);
  if (intent.any) {
    // Make `a` resolvable before the first frame, and start reading the master
    // bus (see the audio-reactive section). Any visual, not only Hydra: a
    // hand-drawn onPaint() reading a.fft used to see zeros.
    installAudioReactiveGlobals();
    startAnalyserLoop();
  }
  if (!widgetState.vizManual) {
    // Reduced motion: never reveal a moving backdrop on our own initiative.
    // The "Visuals" button still works — that is the user asking.
    widgetState.setVizVisible(intent.any && !prefersReducedMotion());
    applyVizVisibility();
  }
  if (intent.any && widgetState.vizVisible) {
    // applyVizVisibility() defers sizing to the next frame; Hydra may init
    // sooner than that (it only awaits the hydra-synth import), so size now.
    syncVizCanvasSize();
  }
}

/** Current primary visual surfaces; Hydra is never created by this accessor.
 * Named extra 2D layers remain owned by this module. */
export function getVisualCanvases(): { hydra: HTMLCanvasElement | null; viz: HTMLCanvasElement } {
  return { hydra: getHydraCanvas(), viz: vizCanvas };
}

/**
 * The stage's layers bottom to top, as the video recorder composites them:
 * Hydra, #test-canvas unless feedStrudel hid it (Hydra already shows it), then
 * the named 2D layers this pattern still uses.
 */
export function getVisualLayers(): HTMLCanvasElement[] {
  const hydra = getHydraCanvas();
  const out: HTMLCanvasElement[] = hydra ? [hydra] : [];
  if (vizCanvas.style.display !== "none") out.push(vizCanvas);
  drawLayers.forEach((layer) => {
    if (layer.isConnected && !layer.classList.contains("viz-layer-idle")) out.push(layer);
  });
  return out;
}

/** The stage's size in CSS px and its background (the theme's), for the recorder. */
export function stageFrame(): { width: number; height: number; background: string } {
  return {
    width: replSection.clientWidth,
    height: replSection.clientHeight,
    background: replSection.style.getPropertyValue("--viz-stage")
      || getComputedStyle(document.documentElement).getPropertyValue("--background").trim()
      || "#000",
  };
}

export function observeVisualSize(onResize: () => void): void {
  // Keep the canvas backing store DPR-correct as the editor/iframe resizes.
  vizResizeObserver = new ResizeObserver(() => {
    syncVizCanvasSize();
    onResize();
  });
  vizResizeObserver.observe(replSection);
}

export function disconnectVisualObservers(): void {
  vizResizeObserver?.disconnect();
  vizResizeObserver = null;
  hydraCanvasObserver.disconnect();
  if (hydraLateResize !== null) {
    clearTimeout(hydraLateResize);
    hydraLateResize = null;
  }
}

export function removeDrawLayers(): void {
  drawLayers.forEach((layer) => layer.remove());
  drawLayers.clear();
}
