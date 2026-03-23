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

const STRUDEL_CDN = "https://unpkg.com/@strudel/repl@1.3.0";

const app = new App({ name: "Strudel Live Pattern", version: "0.2.1" });

const playBtn = document.getElementById("play-btn") as HTMLButtonElement;
const stopBtn = document.getElementById("stop-btn") as HTMLButtonElement;
const fullscreenBtn = document.getElementById("fullscreen-btn") as HTMLButtonElement;
const statusEl = document.getElementById("status")!;
const container = document.getElementById("strudel-container")!;

let editorEl: HTMLElement | null = null;
let currentCode = "";
let isPlaying = false;
let cdnLoaded = false;

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
  setStatus(playing ? "Playing..." : "Ready", playing ? "playing" : "normal");
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

// Play/stop controls
playBtn.addEventListener("click", () => {
  const editor = getEditor();
  if (!editor) return;
  try {
    if (isPlaying) {
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

stopBtn.addEventListener("click", () => {
  const editor = getEditor();
  if (!editor) return;
  try {
    editor.stop();
    updatePlayState(false);
  } catch (err) {
    setStatus(`Stop error: ${(err as Error).message}`, "error");
  }
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
