/**
 * @file Sheet Music App — renders ABC notation with abcjs, multi-instrument audio,
 *       style presets, note highlighting, and playback controls.
 */
import { App, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import ABCJS from "abcjs";
import type { NoteTimingEvent, CursorControl, SynthOptions } from "abcjs";
import "abcjs/abcjs-audio.css";
import "./global.css";
import "./mcp-app.css";
import {
  DEFAULT_INSTRUMENT,
  INSTRUMENTS,
  STYLE_PRESETS,
  applyStyleToAbc,
  isStyleName,
  prepareToolInput,
} from "./music-logic";

// =============================================================================
// State
// =============================================================================

interface AppState {
  visualObj: ABCJS.TuneObject[] | null;
  synthControl: ABCJS.SynthObjectController | null;
  currentInstrument: string;
  currentStyle: string;
  currentAbc: string | null;
  highlightedEls: HTMLElement[];
}

const state: AppState = {
  visualObj: null,
  synthControl: null,
  currentInstrument: DEFAULT_INSTRUMENT,
  currentStyle: "",
  currentAbc: null,
  highlightedEls: [],
};

// =============================================================================
// DOM References
// =============================================================================

const mainEl = document.querySelector(".main") as HTMLElement;
const statusEl = document.getElementById("status")!;
const sheetMusicEl = document.getElementById("sheet-music")!;
const audioControlsEl = document.getElementById("audio-controls")!;
const instrumentSelectorEl = document.getElementById("instrument-selector")!;
const styleSelectorEl = document.getElementById("style-selector")!;
const toolbarEl = document.getElementById("toolbar")!;

// =============================================================================
// Audio Session
// =============================================================================

if ("audioSession" in navigator) {
  (navigator.audioSession as { type: string }).type = "playback";
}

// =============================================================================
// Cursor Control (note highlighting during playback)
// =============================================================================

const cursorControl: CursorControl = {
  onEvent(ev: NoteTimingEvent) {
    state.highlightedEls.forEach((el) => el.classList.remove("note-playing"));
    state.highlightedEls = [];

    if (!ev.elements) return;

    for (const group of ev.elements) {
      for (const el of group) {
        el.classList.add("note-playing");
        state.highlightedEls.push(el);
      }
    }

    if (state.highlightedEls.length > 0) {
      state.highlightedEls[0].scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    }
  },

  onFinished() {
    state.highlightedEls.forEach((el) => el.classList.remove("note-playing"));
    state.highlightedEls = [];
  },
};

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

instrumentSelect.addEventListener("change", () => {
  state.currentInstrument = instrumentSelect.value;
  if (state.visualObj && state.synthControl) {
    applySettings();
  }
});

async function applySettings(): Promise<void> {
  if (!state.synthControl || !state.visualObj?.[0]) return;
  try {
    const program = INSTRUMENTS[state.currentInstrument] ?? 0;
    const opts: Record<string, unknown> = { program };
    await state.synthControl.setTune(
      state.visualObj[0],
      false,
      opts as SynthOptions,
    );
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

const noneOption = document.createElement("option");
noneOption.value = "";
noneOption.textContent = "No style (melody only)";
styleSelect.appendChild(noneOption);

for (const name of Object.keys(STYLE_PRESETS)) {
  const option = document.createElement("option");
  option.value = name;
  option.textContent = name.charAt(0).toUpperCase() + name.slice(1);
  styleSelect.appendChild(option);
}

styleSelect.addEventListener("change", () => {
  state.currentStyle = styleSelect.value;
  if (state.currentAbc) {
    renderAbc(state.currentAbc);
  }
});

const styleLabel = document.createElement("label");
styleLabel.className = "control-label";
styleLabel.htmlFor = "style-select";
styleLabel.textContent = "Style";
styleSelectorEl.appendChild(styleLabel);
styleSelectorEl.appendChild(styleSelect);

// =============================================================================
// Fullscreen Button
// =============================================================================

let appInstance: App | null = null;

const fullscreenBtn = document.createElement("button");
fullscreenBtn.className = "toolbar-btn";
fullscreenBtn.textContent = "⛶";
fullscreenBtn.title = "Toggle fullscreen";
fullscreenBtn.addEventListener("click", () => {
  appInstance?.requestDisplayMode({ mode: "fullscreen" });
});
toolbarEl.appendChild(fullscreenBtn);

// =============================================================================
// ABC Rendering
// =============================================================================

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

async function renderAbc(
  abcNotation: string,
  extraSynthOpts?: Record<string, unknown>,
): Promise<void> {
  try {
    setStatus("Rendering...");

    // Stop any active playback before re-rendering
    if (state.synthControl) {
      state.synthControl.pause();
    }

    state.currentAbc = abcNotation;
    sheetMusicEl.innerHTML = "";
    audioControlsEl.innerHTML = "";

    const abcWithStyle = applyStyleToAbc(abcNotation, state.currentStyle);

    state.visualObj = ABCJS.renderAbc(sheetMusicEl, abcWithStyle, {
      responsive: "resize",
      add_classes: true,
    });

    if (!state.visualObj || state.visualObj.length === 0) {
      throw new Error("Failed to parse music notation");
    }

    if (!ABCJS.synth.supportsAudio()) {
      throw new Error("Audio not supported in this browser");
    }

    state.synthControl = new ABCJS.synth.SynthController();
    state.synthControl.load(audioControlsEl, cursorControl, {
      displayLoop: true,
      displayPlay: true,
      displayProgress: true,
      displayWarp: true,
    });

    const program = INSTRUMENTS[state.currentInstrument] ?? 0;
    const synthOpts: Record<string, unknown> = { program, ...extraSynthOpts };
    await state.synthControl.setTune(
      state.visualObj[0],
      false,
      synthOpts as SynthOptions,
    );

    // Show toolbar once we have content
    toolbarEl.classList.add("visible");
    setStatus("Ready to play!");
  } catch (error) {
    console.error("Render error:", error);
    setStatus(`Error: ${(error as Error).message}`, true);
    audioControlsEl.innerHTML = "";
  }
}

// =============================================================================
// MCP Apps SDK Integration
// =============================================================================

const app = new App({ name: "Music Studio", version: "0.1.0" });
appInstance = app;

// Handle complete tool input
app.ontoolinput = (params) => {
  console.info("Received tool input:", params);
  const preparedInput = prepareToolInput(params.arguments ?? {});

  state.currentInstrument = preparedInput.instrument;
  instrumentSelect.value = preparedInput.instrument;

  state.currentStyle = preparedInput.style;
  styleSelect.value = preparedInput.style;

  if (preparedInput.abcNotation) {
    renderAbc(preparedInput.abcNotation, preparedInput.synthOptions).catch(
      console.error,
    );
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

  // Keep state current during streaming so UI controls work
  state.currentAbc = abcNotation;

  // Apply style from partial input if provided
  const style = params.arguments?.style as string | undefined;
  if (style && isStyleName(style) && state.currentStyle !== style) {
    state.currentStyle = style;
    styleSelect.value = style;
  }

  // Only attempt render if we have at least a key signature (minimum viable ABC)
  if (!abcNotation.match(/K:[^\n]+/)) {
    setStatus("Composing...");
    return;
  }

  // Skip if content hasn't changed
  if (abcNotation === lastPartialAbc) return;
  lastPartialAbc = abcNotation;

  // Debounce: wait for a pause in streaming before re-rendering
  if (partialRenderTimer) clearTimeout(partialRenderTimer);
  partialRenderTimer = setTimeout(() => {
    try {
      const abcWithStyle = applyStyleToAbc(abcNotation, state.currentStyle);
      // Render in place — ABCJS replaces the target element's content
      ABCJS.renderAbc(sheetMusicEl, abcWithStyle, {
        responsive: "resize",
        add_classes: true,
      });
      // Scroll to show the latest notation at the bottom
      sheetMusicEl.scrollTop = sheetMusicEl.scrollHeight;
      // Also scroll the sheet section into view if needed
      const sheetSection = sheetMusicEl.closest(".sheet-section");
      if (sheetSection) {
        sheetSection.scrollTop = sheetSection.scrollHeight;
      }
      setStatus("Composing...");
    } catch {
      // Partial input may not parse — that's fine
    }
  }, 150);
};

app.onerror = console.error;

function handleHostContextChanged(ctx: McpUiHostContext) {
  if (ctx.safeAreaInsets) {
    mainEl.style.paddingTop = `${ctx.safeAreaInsets.top}px`;
    mainEl.style.paddingRight = `${ctx.safeAreaInsets.right}px`;
    mainEl.style.paddingBottom = `${ctx.safeAreaInsets.bottom}px`;
    mainEl.style.paddingLeft = `${ctx.safeAreaInsets.left}px`;
  }
}

app.onhostcontextchanged = handleHostContextChanged;

app.connect().then(() => {
  const ctx = app.getHostContext();
  if (ctx) {
    handleHostContextChanged(ctx);
  }
});
