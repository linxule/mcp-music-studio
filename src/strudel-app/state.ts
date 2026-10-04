import type { SessionClient } from "../session-client";

export type StatusType = "normal" | "playing" | "error";

/** Cross-module live bindings. Module-private resources stay with their owner.
 * Explicit setters keep writes typed; namespace imports retain live reads and
 * let the bundler shorten bindings without shipping long object-property names. */

/** True while the scheduler runs over a context that is not running. */
export let audioBlocked = false;
// Host capabilities (populated after connect)
export let canDownload = false;
export let canUpdateModelContext = false;

// True while the current pattern uses Hydra (WebGL layer under #test-canvas).
export let hydraActive = false;

/** Set when a hydra `visuals` preset was dropped for prefers-reduced-motion. */
export let hydraPresetSkippedForMotion = false;
export let isPlaying = false;
export let isRecording = false;

/** The last report text, so an "applied" answer can carry this evaluation's. */
export let lastReportText = "";

/** The code exactly as the tool call sent it — before bpm/visuals added lines. */
export let sentCode = "";

// Live session (src/session-client.ts) — set when the tool result names one.
export let session: SessionClient | null = null;

// Set when prebake() soundfont registration fails — audio may be silent/absent.
export let soundfontWarning = false;
export let stageMode = false;

// Visualization panel. The pattern's code decides whether a visual shows: the
// panel auto-reveals when the code contains a viz method or initHydra(), unless
// the user has manually toggled it (vizManual sticks their choice across
// re-renders). Detection lives in src/shared/viz-detect.ts (pure, unit-tested).
export let vizManual = false;
export let vizVisible = false;

export function setAudioBlocked(value: typeof audioBlocked): void {
  audioBlocked = value;
}

export function setCanDownload(value: typeof canDownload): void {
  canDownload = value;
}

export function setCanUpdateModelContext(value: typeof canUpdateModelContext): void {
  canUpdateModelContext = value;
}

export function setHydraActive(value: typeof hydraActive): void {
  hydraActive = value;
}

export function setHydraPresetSkippedForMotion(value: typeof hydraPresetSkippedForMotion): void {
  hydraPresetSkippedForMotion = value;
}

export function setIsPlaying(value: typeof isPlaying): void {
  isPlaying = value;
}

export function setIsRecording(value: typeof isRecording): void {
  isRecording = value;
}

export function setLastReportText(value: typeof lastReportText): void {
  lastReportText = value;
}

export function setSentCode(value: typeof sentCode): void {
  sentCode = value;
}

export function setSession(value: typeof session): void {
  session = value;
}

export function setSoundfontWarning(value: typeof soundfontWarning): void {
  soundfontWarning = value;
}

export function setStageMode(value: typeof stageMode): void {
  stageMode = value;
}

export function setVizManual(value: typeof vizManual): void {
  vizManual = value;
}

export function setVizVisible(value: typeof vizVisible): void {
  vizVisible = value;
}
