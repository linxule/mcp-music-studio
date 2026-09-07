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
// Hydra renders at this many CSS px wide at most, then upscales (pixelated).
// 960px is plenty for a widget backdrop and keeps the GPU cost low inside the
// inline iframe; strudel.cc itself defaults to pixelRatio 1 at window size.
const HYDRA_MAX_WIDTH = 960;

// Host capabilities (populated after connect)
let canDownload = false;
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

function injectBpm(code: string, bpm: number): string {
  const cps = bpm / 60 / 4;
  const cpsRounded = Math.round(cps * 10000) / 10000;
  if (/setcps\s*\(/.test(code)) {
    return code.replace(/setcps\s*\([^)]*\)/, `setcps(${cpsRounded})`);
  }
  return `setcps(${cpsRounded})\n${code}`;
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
  // Hide a STRAY full-viewport canvas (prepended to document.body by
  // @strudel/draw's getDrawContext) — but never our own pre-created
  // #test-canvas, which getDrawContext should be reusing instead.
  document.querySelectorAll("body > canvas").forEach((canvas) => {
    const id = (canvas as HTMLElement).id;
    if (id === "test-canvas" || id === "hydra-canvas") return;
    const style = (canvas as HTMLElement).style;
    if (style.position === "fixed") {
      style.display = "none";
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
  if (hydraActive) syncHydraCanvasSize(w, h);
}

// -----------------------------------------------------------------------------
// Hydra (WebGL) layer
//
// @strudel/hydra's initHydra() does getDrawContext("hydra-canvas"), which
// REUSES an element with that id if one exists — so we keep a #hydra-canvas
// inside .repl-section (static HTML) and Hydra paints there, under the 2D
// #test-canvas. hydra-synth takes its render resolution from canvas.width/height
// at construction time, so the backing store must be sized BEFORE the pattern
// evaluates; afterwards we go through the global setResolution() hydra exposes.
// clearHydra() (also in eval scope) REMOVES the element, so ensureHydraCanvas()
// re-creates it in place whenever it has gone missing.
// -----------------------------------------------------------------------------

/** Find or re-create the in-widget Hydra canvas (clearHydra() removes it). */
function ensureHydraCanvas(): HTMLCanvasElement {
  let c = document.getElementById("hydra-canvas") as HTMLCanvasElement | null;
  if (!c) {
    c = document.createElement("canvas");
    c.id = "hydra-canvas";
    c.className = "viz-canvas hydra-canvas";
    replSection.insertBefore(c, vizCanvas);
  }
  markOnContextBind(c);
  return c;
}

/**
 * Record the moment Hydra binds a WebGL context to the canvas. We can't hook
 * initHydra() itself (it runs inside the pattern's eval), but getDrawContext()
 * has to call canvas.getContext(), so wrapping that on our element is a
 * reliable, allocation-free signal. Probing with getContext() ourselves would
 * CREATE a context and confuse the check.
 */
function markOnContextBind(c: HTMLCanvasElement): void {
  if ((c as any).__ctxHooked) return;
  (c as any).__ctxHooked = true;
  const orig = c.getContext.bind(c);
  (c as any).getContext = (...args: unknown[]) => {
    const ctx = (orig as any)(...args);
    if (ctx) c.dataset.hydraBound = "1";
    return ctx;
  };
}

/**
 * Hydra resolution = panel size capped at HYDRA_MAX_WIDTH CSS px (aspect kept),
 * upscaled with image-rendering:pixelated. Before Hydra has initialised we set
 * canvas.width/height directly (hydra-synth reads them in its constructor);
 * once it's live, changing them behind its back would desync its viewport, so
 * we call the setResolution() global it installs instead.
 */
function syncHydraCanvasSize(w: number, h: number): void {
  const c = ensureHydraCanvas();
  const scale = Math.min(1, HYDRA_MAX_WIDTH / w);
  const rw = Math.max(1, Math.round(w * scale));
  const rh = Math.max(1, Math.round(h * scale));
  if (c.width === rw && c.height === rh) return;
  const setRes = (window as any).setResolution;
  const live = typeof setRes === "function" && hasHydraInstance();
  if (live) {
    try {
      setRes(rw, rh);
      return;
    } catch { /* fall through to a direct resize */ }
  }
  c.width = rw;
  c.height = rh;
}

/** True once Hydra has bound a WebGL context to the CURRENT #hydra-canvas. */
function hasHydraInstance(): boolean {
  const c = document.getElementById("hydra-canvas") as HTMLCanvasElement | null;
  return c?.dataset.hydraBound === "1";
}

/** Stage or strike the Hydra layer for the pattern about to run. */
function setHydraActive(active: boolean): void {
  if (active === hydraActive && (!active || document.getElementById("hydra-canvas"))) {
    return;
  }
  hydraActive = active;
  replSection.classList.toggle("hydra-on", active);
  if (active) {
    ensureHydraCanvas();
    return;
  }
  // Pattern no longer uses Hydra: stop its render loop so a stale shader
  // doesn't keep animating under the code. clearHydra() (exported by
  // @strudel/hydra into the eval scope) hushes + removes the canvas; we then
  // put a fresh, unbound one back so a later initHydra() finds it in-widget
  // rather than prepending a position:fixed canvas to <body>.
  try {
    (window as any).clearHydra?.();
  } catch { /* hydra never initialised — nothing to clear */ }
  document.getElementById("hydra-canvas")?.remove();
  ensureHydraCanvas();
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
    // user has taken manual control of the "Visuals" toggle. Scan a copy with //
    // line comments stripped so a commented-out ".pianoroll()" (the guide uses
    // such examples) doesn't flip the scrim on with nothing to draw. The (^|[^:])
    // guard avoids stripping the "//" inside protocol URLs like https://….
    const intent = detectViz(finalCode);
    // Stage the Hydra layer BEFORE evaluation so initHydra() finds a canvas
    // that is already sized for the panel (hydra-synth reads canvas.width /
    // height in its constructor and keeps that resolution).
    setHydraActive(intent.hydra);
    if (!vizManual) {
      vizVisible = intent.any;
      applyVizVisibility();
    }
    if (intent.hydra && vizVisible) {
      // applyVizVisibility() defers sizing to the next frame; Hydra may init
      // sooner than that (it only awaits the hydra-synth import), so size now.
      syncVizCanvasSize();
    }

    // Create the <strudel-editor> element programmatically (no innerHTML sink).
    // The code is loaded via the safe editor.setCode() API below.
    if (!editorEl) {
      const newEditor = document.createElement("strudel-editor");
      container.replaceChildren(newEditor);
      editorEl = newEditor;
    }

    setStatus("Initializing...");
    const editor = await waitForEditor();

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
      try {
        editor.evaluate(finalCode, true);
        updatePlayState(true);
        if (soundfontWarning) {
          setStatus(`Playing...${soundfontNote}`, "playing");
        }
      } catch {
        setStatus(`Click Play to start${soundfontNote}`, "normal");
      }
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

playBtn.addEventListener("click", () => {
  const editor = getEditor();
  if (!editor) return;
  try {
    if (isPlaying) {
      if (isRecording) stopRecording();
      editor.stop();
      updatePlayState(false);
    } else {
      editor.evaluate(currentCode, true);
      updatePlayState(true);
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

// Hook the static #hydra-canvas so we can tell when Hydra binds to it.
ensureHydraCanvas();

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
