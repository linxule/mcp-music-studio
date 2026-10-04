import type { App } from "@modelcontextprotocol/ext-apps";
import type { PlaybackState } from "../audio-unlock";
import { detectViz } from "../shared/viz-detect";
import { sourceLineNote } from "../shared/line-map";
import * as widgetState from "./state";
import type { StatusType } from "./state";

interface ReportsHost {
  app: App;
  getEditor(): any;
  currentPlaybackState(): PlaybackState;
  isSchedulerStarted(): boolean;
  audioIsBlockedNow(): boolean;
  renderPlayButton(): void;
  updatePlayState(playing: boolean): void;
  setStatus(text: string, type?: StatusType): void;
  showPlayingStatus(text: string, type: StatusType): void;
  sensorNotes(code: string): string;
}

/** Evaluation reports and debounced transitions share one reporting history. */
let app: ReportsHost["app"];
let getEditor: ReportsHost["getEditor"];
let currentPlaybackState: ReportsHost["currentPlaybackState"];
let isSchedulerStarted: ReportsHost["isSchedulerStarted"];
let audioIsBlockedNow: ReportsHost["audioIsBlockedNow"];
let renderPlayButton: ReportsHost["renderPlayButton"];
let updatePlayState: ReportsHost["updatePlayState"];
let setStatus: ReportsHost["setStatus"];
let showPlayingStatus: ReportsHost["showPlayingStatus"];
let sensorNotes: ReportsHost["sensorNotes"];

export function initReports(host: ReportsHost): void {
  ({
    app, getEditor, currentPlaybackState,
    isSchedulerStarted, audioIsBlockedNow, renderPlayButton,
    updatePlayState, setStatus, showPlayingStatus,
    sensorNotes,
  } = host);
}

/** The Error @strudel/repl parked from the last evaluation, if it failed. */
export function readEvalError(): Error | null {
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

/**
 * Tell the model what the widget is actually doing, without needing a user turn.
 * Exactly one call per evaluation — never per frame.
 */
export function reportToModel(text: string): void {
  // A live session hears every report, whatever the host does with them —
  // claude.ai had no tool to read widget context (2026-10-02 field test).
  widgetState.setLastReportText(text);
  widgetState.session?.log({ t: "report", text }, true);
  if (!widgetState.canUpdateModelContext) return;
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
/** Playback state the model has been told about, so we only send transitions. */
let lastReportedState: PlaybackState | null = null;
/** Error text from the last failed evaluation, carried into stop reports. */
let lastEvalErrorText: string | null = null;

export function cancelStateReport(): void {
  if (modelStateTimer !== null) {
    clearTimeout(modelStateTimer);
    modelStateTimer = null;
  }
}

/** Note a state we have just reported ourselves, so the debounce won't repeat it. */
function markReportedPlaying(state: PlaybackState, errorText: string | null): void {
  cancelStateReport();
  lastReportedState = state;
  lastEvalErrorText = errorText;
}

/** Report a stop/start/unlock that no evaluation announced. Debounced, deduplicated. */
export function scheduleStateReport(): void {
  if (!widgetState.canUpdateModelContext) return;
  cancelStateReport();
  modelStateTimer = setTimeout(() => {
    modelStateTimer = null;
    const state = currentPlaybackState();
    // Nothing reported yet reads as "stopped": the model has heard of no music.
    if (state === (lastReportedState ?? "stopped")) return;
    const previous = lastReportedState;
    lastReportedState = state;
    const errorNote = lastEvalErrorText ? ` (last error: ${lastEvalErrorText})` : "";
    reportToModel(
      state === "playing"
        ? previous === "audio-blocked"
          ? `Strudel widget: audio started — the pattern is audible now${errorNote}`
          : `Strudel widget: playing again${errorNote}`
        : state === "audio-blocked"
          ? `Strudel widget: audio is suspended — the pattern is running but silent until the user taps Play${errorNote}`
          : `Strudel widget: playback stopped — nothing is sounding now${errorNote}`,
    );
  }, MODEL_STATE_DEBOUNCE_MS);
}

/** Status line + model context for one finished evaluation. */
export function reportEvaluation(
  code: string,
  thrown: Error | null,
  tempoAtRuntime = false,
): void {
  const err = thrown ?? readEvalError();
  const soundfontNote = widgetState.soundfontWarning
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
    widgetState.setIsPlaying(playing);
    widgetState.setAudioBlocked(playing && audioIsBlockedNow());
    renderPlayButton();
    const state = currentPlaybackState();
    markReportedPlaying(state, msg);
    // Positions are in the buffer that ran; say where that is in the code the
    // model sent, when bpm/visuals added lines above it.
    const lineNote = widgetState.sentCode ? sourceLineNote(msg, code, widgetState.sentCode) : "";
    reportToModel(
      `Strudel widget: pattern failed to evaluate — ${msg}${lineNote}` +
        (state === "playing"
          ? " (the previous pattern is still playing)"
          : state === "audio-blocked"
            ? " (the previous pattern is still running, but not audible until the user taps Play)"
            : " (nothing is playing)"),
    );
    return;
  }

  updatePlayState(isSchedulerStarted());
  const state = currentPlaybackState();
  markReportedPlaying(state, null);
  if (widgetState.isPlaying && patternIsSilent()) {
    setStatus("Playing — but the pattern produces no events (silent)", "error");
    reportToModel(
      "Strudel widget: the pattern evaluated and the scheduler is running, but it " +
        `produces NO events in the first ${SILENCE_CHECK_CYCLES} cycles — nothing will sound. ` +
        "The REPL plays the LAST expression: make sure the pattern is the final statement " +
        "(all(), setcps() and helpers go before it), and that every layer yields events.",
    );
    return;
  }
  if ((widgetState.soundfontWarning || tempoAtRuntime) && widgetState.isPlaying) {
    showPlayingStatus(`Playing...${soundfontNote}${tempoNote}`, "playing");
  }
  const intent = detectViz(code);
  const layers = [
    intent.hydra ? "hydra shader" : null,
    intent.strudelViz ? "strudel draw canvas" : null,
  ].filter(Boolean);
  const motionNote = widgetState.hydraPresetSkippedForMotion
    ? " — hydra preset skipped: this viewer prefers reduced motion"
    : "";
  // Blocked audio is NOT "playing": the scheduler runs, but nothing can be
  // heard until the user taps Play — the model must not answer as if it could.
  const what =
    state === "playing"
      ? "playing"
      : state === "audio-blocked"
        ? "loaded and running but NOT audible — the browser has not started audio " +
          "(no user gesture in the widget yet); the widget asks the user to tap Play, " +
          "and sound starts on that tap"
        : "loaded, not playing";
  reportToModel(
    `Strudel widget: ${what}` +
      ` (visuals: ${layers.length ? layers.join(" + ") : "none"}${motionNote})${soundfontNote}${tempoNote}` +
      stageCapabilityNote(code),
  );
}

/**
 * For pieces that speak or listen: what this frame can actually do, measured
 * from inside it. The host sets the iframe's sandbox/allow attributes, so this
 * is the only honest source — the 2026-10-01 DUET field test could not tell
 * "speech is blocked" from "speech was never attempted".
 */
function stageCapabilityNote(code: string): string {
  const voiced = /\b(?:say|sing)\s*\(/.test(code);
  const rawSpeech = /speechSynthesis/.test(code);
  const taps = /\bonTap\s*\(|pointerdown|addEventListener\s*\(\s*['"](?:click|touch|pointer)/.test(code);
  const parts: string[] = [];
  if (voiced) {
    parts.push(
      "voice: say() lines are rendered by the server and play as samples (the widget waits " +
        "for them before starting); a line that can't be rendered is reported separately",
    );
  }
  if (rawSpeech) {
    parts.push(
      "browser speechSynthesis: does NOT play in the Claude mobile app's webview and can't be " +
        "put on the beat — use say(text) instead, which returns a pattern",
    );
  }
  const sensorParts = sensorNotes(code);
  if (sensorParts) parts.push(sensorParts);
  if (taps) {
    parts.push(
      widgetState.stageMode
        ? "taps: stage mode, the whole frame is the stage"
        : "taps: the code editor covers the stage — taps on code lines go to the editor; the Stage button hides it",
    );
  }
  return parts.length ? ` — ${parts.join("; ")}` : "";
}
