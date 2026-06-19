// =============================================================================
// Strudel ext-apps client — uses @strudel/repl with layout fixes
//
// @strudel/repl's <strudel-editor> renders:
//   1. A position:fixed canvas prepended to document.body (visualization)
//   2. The CodeMirror editor in a sibling div (not inside the element)
// We fix the layout by hiding the blank canvas and ensuring the editor
// sibling is visible and properly sized.
// =============================================================================

import "./strudel-app.css";
import { App } from "@modelcontextprotocol/ext-apps";
import { audioBufferToWavBase64 } from "./wav-encoder";
import { VERSION } from "./version";

const STRUDEL_CDN = "https://unpkg.com/@strudel/repl@1.3.0";

const app = new App({ name: "Strudel Live Pattern", version: VERSION });

const playBtn = document.getElementById("play-btn") as HTMLButtonElement;
const recordBtn = document.getElementById("record-btn") as HTMLButtonElement;
const downloadBtn = document.getElementById("download-btn") as HTMLButtonElement;
const sendBtn = document.getElementById("send-btn") as HTMLButtonElement;
const fullscreenBtn = document.getElementById("fullscreen-btn") as HTMLButtonElement;
const statusEl = document.getElementById("status")!;
const container = document.getElementById("strudel-container")!;

let editorEl: HTMLElement | null = null;
let currentCode = "";
let isPlaying = false;
let cdnLoaded = false;

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
  // Hide the full-viewport visualization canvas
  // (prepended to document.body by @strudel/draw's getDrawContext)
  document.querySelectorAll("body > canvas").forEach((canvas) => {
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
