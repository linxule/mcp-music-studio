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

const STRUDEL_CDN = "https://unpkg.com/@strudel/repl@1.3.0";

const app = new App({ name: "Strudel Live Pattern", version: "0.3.0" });

const playBtn = document.getElementById("play-btn") as HTMLButtonElement;
const recordBtn = document.getElementById("record-btn") as HTMLButtonElement;
const downloadBtn = document.getElementById("download-btn") as HTMLButtonElement;
const fullscreenBtn = document.getElementById("fullscreen-btn") as HTMLButtonElement;
const statusEl = document.getElementById("status")!;
const container = document.getElementById("strudel-container")!;

let editorEl: HTMLElement | null = null;
let currentCode = "";
let isPlaying = false;
let cdnLoaded = false;

// Recording state
let mediaRecorder: MediaRecorder | null = null;
let recordedChunks: Blob[] = [];
let isRecording = false;
let recordingStream: MediaStream | null = null;

// Hint to the OS that this app produces audio playback
if ("audioSession" in navigator) {
  (navigator as any).audioSession.type = "playback";
}

function getEditor(): any {
  return (editorEl as any)?.editor ?? null;
}

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
      } catch { /* non-fatal */ }
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

async function renderPattern(args: Record<string, unknown>) {
  const code = args.code as string | undefined;
  if (!code) return;

  const bpm = args.bpm as number | undefined;
  const autoplay = args.autoplay as boolean | undefined;

  try {
    setStatus("Loading Strudel...");
    await loadStrudelCDN();

    let finalCode = code;
    if (bpm) {
      finalCode = injectBpm(finalCode, bpm);
    }
    currentCode = finalCode;

    // Create <strudel-editor> with code in HTML comment format
    if (!editorEl) {
      container.innerHTML = `<strudel-editor><!--\n${finalCode}\n--></strudel-editor>`;
      editorEl = container.querySelector("strudel-editor");
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

    if (autoplay !== false) {
      try {
        editor.evaluate(finalCode, true);
        updatePlayState(true);
      } catch {
        setStatus("Click Play to start", "normal");
      }
    } else {
      setStatus("Ready — click Play or Ctrl+Enter", "normal");
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

// Fullscreen toggle
fullscreenBtn.addEventListener("click", () => {
  app.requestDisplayMode({ mode: "fullscreen" });
});

// Connect to MCP ext-apps
app.connect().then(() => {
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
});
