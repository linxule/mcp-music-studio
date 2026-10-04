import type { App } from "@modelcontextprotocol/ext-apps";
import { audioBufferToWavBytesAsync } from "../wav-encoder";
import { bytesToBase64Async } from "../bytes-to-base64";
import { nativeExportStatus, planRecordingExport } from "../recording-export";
import {
  RECORD_LIMITS, VIDEO_AUDIO_BITS_PER_SECOND, VIDEO_BITS_PER_SECOND, VIDEO_FPS,
  fixWebmDuration, formatSetlist, letterbox, nativeVideoType, pickVideoMime, videoFrameSize,
  type RecordKind, type SetlistEntry,
} from "../video-recording";
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

/** Bounds. A recording is held whole in memory, so it cannot be open-ended. */
export const MAX_RECORDING_MINUTES = RECORD_LIMITS.audio.minutes;
export const MAX_RECORDING_MS = MAX_RECORDING_MINUTES * 60_000;
export const MAX_RECORDING_BYTES = RECORD_LIMITS.audio.bytes;

interface Recording {
  kind: RecordKind;
  chunks: Blob[];
  mimeType: string;
  bytes: number;
  /** performance.now() at start, and the length once stopped. */
  startedAt: number;
  durationMs: number;
  recordedAt: Date;
  /** Live-session changes heard while it ran (video only); offered as a .txt. */
  setlist: SetlistEntry[] | null;
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
  /** "Rec video"; absent where the widget has none. */
  videoBtn?: HTMLButtonElement | null;
  downloadBtn: HTMLButtonElement;
  setStatus(text: string, type?: StatusType): void;
  showPlayingStatus(text: string, type: StatusType): void;
  replAudioContext(): AudioContext | null;
  ensureLimiter(): void;
  currentLimiter(): DynamicsCompressorNode | null;
  recordingFileStem(): string;
  /** The stage's canvases bottom to top, its CSS size and background. */
  visualLayers?(): HTMLCanvasElement[];
  stageFrame?(): { width: number; height: number; background: string };
  /** True while the widget's own Hydra rAF runs (it paints the video frame then). */
  hydraTicking?(): boolean;
  /** The code playing when a recording starts, and whether a live session is on. */
  currentCode?(): string;
  audibleCycle?(): number | null;
  inSession?(): boolean;
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
let videoBtn: HTMLButtonElement | null = null;
let host: RecordingHost;

export function initRecording(h: RecordingHost): void {
  host = h;
  ({
    app, recordBtn, downloadBtn,
    setStatus, showPlayingStatus, replAudioContext,
    ensureLimiter, currentLimiter, recordingFileStem,
  } = h);
  videoBtn = h.videoBtn ?? null;
}

/** canvas.captureStream + MediaRecorder: what video recording needs. */
export function canRecordVideo(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof HTMLCanvasElement !== "undefined" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function"
  );
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

export function startRecording(kind: RecordKind = "audio"): void {
  if (!recordingStream) {
    recordingStream = setupRecordingTap();
  }
  if (!recordingStream) {
    setStatus("Recording not available", "error");
    return;
  }

  const mime = kind === "video"
    ? (typeof MediaRecorder === "undefined" ? null : pickVideoMime(
      typeof MediaRecorder.isTypeSupported === "function" ? (m) => MediaRecorder.isTypeSupported(m) : undefined,
    ))
    : pickRecordingMime();
  if (mime === null || (kind === "video" && !canRecordVideo())) {
    setStatus(`${kind === "video" ? "Video recording" : "Recording"} not supported on this browser`, "error");
    return;
  }
  let stream: MediaStream = recordingStream;
  if (kind === "video") {
    const video = startVideoFrames();
    if (!video) {
      setStatus("Video recording not supported on this browser", "error");
      return;
    }
    stream = new MediaStream([...video.getVideoTracks(), ...recordingStream.getAudioTracks()]);
  }
  const options: MediaRecorderOptions = kind === "video"
    ? { videoBitsPerSecond: VIDEO_BITS_PER_SECOND, audioBitsPerSecond: VIDEO_AUDIO_BITS_PER_SECOND }
    : {};
  if (mime) options.mimeType = mime;
  try {
    mediaRecorder = new MediaRecorder(stream, options);
  } catch {
    stopVideoFrames();
    setStatus(`${kind === "video" ? "Video recording" : "Recording"} not supported on this browser`, "error");
    return;
  }

  // Closed over, so a late callback from a PREVIOUS recorder fills its own
  // buffer and can never splice itself into this recording.
  const recorder = mediaRecorder;
  const limits = RECORD_LIMITS[kind];
  const recording: Recording = {
    kind,
    chunks: [],
    mimeType: recorder.mimeType || mime || (kind === "video" ? "video/webm" : "audio/webm"),
    bytes: 0,
    startedAt: performance.now(),
    durationMs: 0,
    recordedAt: new Date(),
    setlist: kind === "video" && host.inSession?.()
      ? [{ atMs: 0, cycle: host.audibleCycle?.() ?? null, by: "start", code: host.currentCode?.() ?? "" }]
      : null,
  };
  activeRecording = recording;

  recorder.ondataavailable = (e) => {
    if (e.data.size === 0) return;
    recording.chunks.push(e.data);
    recording.bytes += e.data.size;
    if (recording.bytes >= limits.bytes && activeRecording === recording) {
      stopRecording("size");
    }
  };

  recorder.onstop = () => {
    // The negotiated type is only reliably readable once recording has begun.
    recording.mimeType = recorder.mimeType || recording.mimeType;
    if (recording.chunks.length > 0) lastRecording = recording;
    downloadBtn.disabled = !lastRecording;
  };

  recorder.start(kind === "video" ? 1000 : 100);
  widgetState.setIsRecording(true);
  const button = kind === "video" && videoBtn ? videoBtn : recordBtn;
  button.classList.add("recording");
  button.textContent = "Stop Rec";
  const other = button === recordBtn ? videoBtn : recordBtn;
  if (other) other.disabled = true;
  setStatus(kind === "video" ? "Recording video..." : "Recording...", "playing");

  if (recordingLimitTimer !== null) clearTimeout(recordingLimitTimer);
  recordingLimitTimer = setTimeout(() => {
    recordingLimitTimer = null;
    if (activeRecording === recording) stopRecording("time");
  }, limits.minutes * 60_000);
}

/**
 * A live-session change while a video records: Claude's update, the human's
 * edit, a swap-pattern. Goes into the setlist written next to the video.
 */
export function noteSetlistChange(change: Omit<SetlistEntry, "atMs">): void {
  const recording = activeRecording;
  if (!recording?.setlist) return;
  recording.setlist.push({ ...change, atMs: performance.now() - recording.startedAt });
}

// -----------------------------------------------------------------------------
// Video frames — the stage composited onto one canvas
//
// A WebGL canvas without preserveDrawingBuffer reads back BLACK once its frame
// has been presented (and initHydra() can't ask for preserveDrawingBuffer:
// getDrawContext() creates the context first). So the Hydra layer is drawn in
// the same frame it was rendered: the widget's own Hydra rAF calls
// paintVideoFrameAfterHydraTick() right after instance.tick(dt). Without Hydra
// our own rAF paints the 2D layers over the stage background. Measured in both
// engines by scripts/prototype-video.mjs and scripts/verify-record.mjs.
// -----------------------------------------------------------------------------

let videoCanvas: HTMLCanvasElement | null = null;
let videoCtx: CanvasRenderingContext2D | null = null;
let videoStream: MediaStream | null = null;
let videoRaf: number | null = null;
let videoBackground = "#000";
let videoBackgroundAt = -Infinity;

function startVideoFrames(): MediaStream | null {
  const stage = host.stageFrame?.();
  if (!stage) return null;
  const size = videoFrameSize(stage.width, stage.height, window.devicePixelRatio || 1);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  videoCanvas = canvas;
  videoCtx = ctx;
  videoBackgroundAt = -Infinity;
  paintVideoFrame();
  try {
    videoStream = canvas.captureStream(VIDEO_FPS);
  } catch {
    stopVideoFrames();
    return null;
  }
  const loop = () => {
    if (!videoCanvas) return;
    if (!host.hydraTicking?.()) paintVideoFrame();
    videoRaf = requestAnimationFrame(loop);
  };
  videoRaf = requestAnimationFrame(loop);
  return videoStream;
}

function stopVideoFrames(): void {
  if (videoRaf !== null) cancelAnimationFrame(videoRaf);
  videoRaf = null;
  videoStream?.getTracks().forEach((t) => t.stop());
  videoStream = null;
  videoCanvas = null;
  videoCtx = null;
}

function paintVideoFrame(): void {
  const canvas = videoCanvas;
  const ctx = videoCtx;
  if (!canvas || !ctx) return;
  const now = performance.now();
  // A theme change recolours the stage; reading it every frame would force style.
  if (now - videoBackgroundAt > 1000) {
    videoBackground = host.stageFrame?.().background ?? videoBackground;
    videoBackgroundAt = now;
  }
  ctx.fillStyle = videoBackground;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const layer of host.visualLayers?.() ?? []) {
    if (!layer.width || !layer.height) continue;
    const r = letterbox(layer.width, layer.height, canvas.width, canvas.height);
    try {
      ctx.drawImage(layer, r.x, r.y, r.width, r.height);
    } catch { /* a layer mid-teardown (lost context) — skip it this frame */ }
  }
}

/** Called by the widget's Hydra loop right after `tick(dt)`, while the GL frame is readable. */
export function paintVideoFrameAfterHydraTick(): void {
  if (videoCanvas) paintVideoFrame();
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
  const kind = activeRecording?.kind ?? "audio";
  if (activeRecording) activeRecording.durationMs = performance.now() - activeRecording.startedAt;
  // The recorder has already been told to stop; ending the canvas track now loses nothing.
  if (kind === "video") stopVideoFrames();
  widgetState.setIsRecording(false);
  activeRecording = null;
  for (const [button, label] of [[recordBtn, "Record"], [videoBtn, "Rec video"]] as const) {
    if (!button) continue;
    button.classList.remove("recording");
    button.textContent = label;
    button.disabled = false;
  }
  if (reason === "time") {
    setStatus(
      `Recording stopped at the ${RECORD_LIMITS[kind].minutes}-minute limit — ready to download`,
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
    if (recording.kind === "video") {
      await downloadVideo(recording);
      return;
    }
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

/**
 * The video goes out as recorded (WebM gets its duration written in; MP4 has
 * one), then — in a live session — the setlist as a second, small download, so
 * a host that refuses one file never costs the other.
 */
async function downloadVideo(recording: Recording): Promise<void> {
  const type = nativeVideoType(recording.mimeType);
  let bytes: Uint8Array = new Uint8Array(await new Blob(recording.chunks, { type: recording.mimeType }).arrayBuffer());
  if (type.extension === "webm") bytes = fixWebmDuration(bytes, recording.durationMs) ?? bytes;
  const base64 = await bytesToBase64Async(bytes);
  const stem = recordingFileStem();
  const file = `${stem}.${type.extension}`;
  const result = await app.downloadFile(
    { contents: [{ type: "resource", resource: { uri: `file:///${file}`, mimeType: type.mimeType, blob: base64 } }] },
    // The host may hold the request open behind a save dialog.
    { timeout: 10 * 60_000 },
  );
  if (result?.isError) {
    setStatus("Download was cancelled or refused by the host", "normal");
    return;
  }
  const mb = (bytes.length / 1_000_000).toFixed(1);
  if (!recording.setlist?.some((e) => e.by !== "start")) {
    setStatus(`Saved ${file} (${mb} MB)`, "normal");
    return;
  }
  const text = formatSetlist(recording.setlist, {
    title: stem, recordedAt: recording.recordedAt, durationMs: recording.durationMs, file,
  });
  const list = await app.downloadFile({
    contents: [{ type: "resource", resource: { uri: `file:///${stem}-setlist.txt`, mimeType: "text/plain", text } }],
  }).catch(() => ({ isError: true }));
  setStatus(
    list?.isError ? `Saved ${file} (${mb} MB); the setlist was not saved` : `Saved ${file} (${mb} MB) and its setlist`,
    "normal",
  );
}

export function teardownRecording(): void {
  if (widgetState.isRecording) stopRecording();
  if (mediaRecorder?.state === "recording") mediaRecorder.stop();
  mediaRecorder = null;
  activeRecording = null;
  stopVideoFrames();
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
