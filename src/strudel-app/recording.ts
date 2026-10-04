import type { App } from "@modelcontextprotocol/ext-apps";
import { audioBufferToWavBytesAsync } from "../wav-encoder";
import { bytesToBase64Async } from "../bytes-to-base64";
import { nativeExportStatus, planRecordingExport } from "../recording-export";
import * as widgetState from "./state";
import type { StatusType } from "./state";

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
export const RECORDING_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4;codecs=mp4a.40.2", // Safari / WKWebView
  "audio/mp4",
  "",
];

/** Bounds. A recording is decoded whole into memory, so it cannot be open-ended. */
export const MAX_RECORDING_MINUTES = 5;
export const MAX_RECORDING_MS = MAX_RECORDING_MINUTES * 60_000;
export const MAX_RECORDING_BYTES = 50 * 1024 * 1024;

interface Recording {
  chunks: Blob[];
  mimeType: string;
  bytes: number;
}

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
export function pickRecordingMime(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  const canCheck = typeof MediaRecorder.isTypeSupported === "function";
  for (const mime of RECORDING_MIME_CANDIDATES) {
    if (mime === "") break;
    if (!canCheck || MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return ""; // no named type claimed support — let the UA pick its default
}

interface RecordingHost {
  app: App;
  recordBtn: HTMLButtonElement;
  downloadBtn: HTMLButtonElement;
  setStatus(text: string, type?: StatusType): void;
  showPlayingStatus(text: string, type: StatusType): void;
  replAudioContext(): AudioContext | null;
  ensureLimiter(): void;
  currentLimiter(): DynamicsCompressorNode | null;
  recordingFileStem(): string;
}

/** Own the recorder and its tap; the entry keeps host/event wiring. */
let app: RecordingHost["app"];
let recordBtn: RecordingHost["recordBtn"];
let downloadBtn: RecordingHost["downloadBtn"];
let setStatus: RecordingHost["setStatus"];
let showPlayingStatus: RecordingHost["showPlayingStatus"];
let replAudioContext: RecordingHost["replAudioContext"];
let ensureLimiter: RecordingHost["ensureLimiter"];
let currentLimiter: RecordingHost["currentLimiter"];
let recordingFileStem: RecordingHost["recordingFileStem"];

export function initRecording(host: RecordingHost): void {
  ({
    app, recordBtn, downloadBtn,
    setStatus, showPlayingStatus, replAudioContext,
    ensureLimiter, currentLimiter, recordingFileStem,
  } = host);
}

// Recording state
let mediaRecorder: MediaRecorder | null = null;

let recordingStream: MediaStream | null = null;
// The master-output node the tap is connected to, and the tap destination,
// so teardown can disconnect precisely the tap (not the speakers).
let recordingMasterGain: AudioNode | null = null;
let recordingDest: AudioNode | null = null;

/** The recorder currently filling, and the finished one the ↓ button exports. */
let activeRecording: Recording | null = null;
let lastRecording: Recording | null = null;
let recordingLimitTimer: ReturnType<typeof setTimeout> | null = null;

function setupRecordingTap(): MediaStream | null {
  try {
    // After prebake(), audio functions are on globalThis, NOT window.strudel
    const audioCtx: AudioContext | undefined = (window as any).getAudioContext?.();
    if (!audioCtx) return null;

    const dest = audioCtx.createMediaStreamDestination();
    // Master output: superdough controller's destinationGain node
    const controller = (window as any).getSuperdoughAudioController?.();
    // Record what is HEARD: after the master limiter when there is one
    // (Codex review — the export skipped the limiting playback had).
    ensureLimiter();
    const masterGain: AudioNode | undefined = currentLimiter() ?? controller?.output?.destinationGain;
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

export function startRecording(): void {
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
  widgetState.setIsRecording(true);
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
export function stopRecording(reason?: "time" | "size"): void {
  if (recordingLimitTimer !== null) {
    clearTimeout(recordingLimitTimer);
    recordingLimitTimer = null;
  }
  if (mediaRecorder?.state === "recording") {
    mediaRecorder.stop();
  }
  if (!widgetState.isRecording) return;
  widgetState.setIsRecording(false);
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
  if (widgetState.isPlaying) {
    showPlayingStatus("Playing...", "playing");
  } else {
    setStatus("Ready", "normal");
  }
}

/**
 * Resolve once the browser has had a chance to paint — a frame, then a task —
 * so a "..." set just before heavy work is on screen. Capped, because
 * requestAnimationFrame never fires in a hidden or throttled frame.
 */
function afterNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(() => setTimeout(finish, 0));
    setTimeout(finish, 100);
  });
}

/**
 * Export the last recording through ONE `ui/download-file` message (#32).
 *
 * WAV when it fits under MAX_WAV_BASE64_CHARS (≈ 2 min of 48 kHz stereo),
 * otherwise the recorder's native container as-is (src/recording-export.ts).
 * The size is known from the decoded buffer before anything is encoded, and
 * the encoding yields between time slices, so the frame keeps painting and
 * taking input instead of freezing while minutes of audio are converted.
 */
export async function handleDownload(): Promise<void> {
  const recording = lastRecording;
  if (!recording || recording.chunks.length === 0) return;
  if (!widgetState.canDownload) {
    setStatus("Download not supported on this host", "error");
    return;
  }

  downloadBtn.disabled = true;
  downloadBtn.textContent = "...";
  try {
    await afterNextPaint();
    const blob = new Blob(recording.chunks, { type: recording.mimeType });
    const audioCtx = replAudioContext();
    if (!audioCtx) throw new Error("No audio context");
    // decodeAudioData() detaches the buffer it is handed; the blob keeps the
    // bytes for a native export.
    let decoded: AudioBuffer | null = await audioCtx.decodeAudioData(await blob.arrayBuffer());
    const plan = planRecordingExport(decoded, recording.mimeType);
    let bytes: Uint8Array;
    if (plan.format === "wav") {
      bytes = await audioBufferToWavBytesAsync(decoded);
    } else {
      bytes = new Uint8Array(await blob.arrayBuffer());
    }
    // Let the decoded float samples go before the base64 exists, rather than
    // holding all three at once.
    decoded = null;
    const base64 = await bytesToBase64Async(bytes);

    const result = await app.downloadFile({
      contents: [
        {
          type: "resource",
          resource: {
            uri: `file:///${recordingFileStem()}.${plan.extension}`,
            mimeType: plan.mimeType,
            blob: base64,
          },
        },
      ],
    });
    if (result?.isError) {
      setStatus("Download was cancelled or refused by the host", "normal");
    } else if (plan.format === "native") {
      setStatus(nativeExportStatus(plan), "normal");
    }
  } catch (err) {
    setStatus(`Download failed: ${(err as Error).message}`, "error");
  } finally {
    downloadBtn.textContent = "↓";
    downloadBtn.disabled = !lastRecording;
  }
}

export function teardownRecording(): void {
  if (widgetState.isRecording) stopRecording();
  if (mediaRecorder?.state === "recording") mediaRecorder.stop();
  mediaRecorder = null;
  activeRecording = null;
  if (recordingLimitTimer !== null) {
    clearTimeout(recordingLimitTimer);
    recordingLimitTimer = null;
  }
}

export function disconnectRecordingTap(): void {
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
}
