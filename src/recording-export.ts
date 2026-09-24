// =============================================================================
// Recording export policy (#32) — WAV, or the recorder's own container
//
// The Strudel widget exports a recording as ONE `ui/download-file` request whose
// resource carries the whole file as base64. 16-bit PCM of Strudel's 48 kHz
// stereo output is 192,000 B/s: 11.5 MB of WAV a minute, 15.4 MB once base64'd,
// so the 5-minute recording cap came to a ~77 MB message. Past a size, the
// recorder's native container goes instead — WebM/Opus in Chromium, MP4/AAC in
// WebKit — which is already encoded and a small fraction of the size.
//
// DOM-free, so the policy is unit-tested; src/strudel-app.ts does the I/O.
// =============================================================================

import { wavByteLength } from "./wav-encoder";

/**
 * The largest WAV we send as one base64 message: 32 MiB of base64.
 *
 *   32 MiB of base64 = 33,554,432 chars → × 3/4 = 25,165,824 bytes of WAV
 *   48 kHz × 2 ch × 2 B = 192,000 B/s   → (25,165,824 − 44) / 192,000 ≈ 131 s
 *
 * so about 2 min 11 s of stereo at 48 kHz (2 min 22 s at 44.1 kHz). No host we
 * know of documents a message limit; this is a deliberately conservative
 * ceiling that also bounds what a phone holds while encoding (the decoded
 * float buffer, the WAV bytes and the base64 are all alive at once).
 */
export const MAX_WAV_BASE64_CHARS = 32 * 1024 * 1024;

/** Characters of base64 for `bytes` bytes of input (padded). */
export function base64Length(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}

/** A recorder MIME type reduced to what a download resource needs. */
export interface NativeRecordingType {
  /** type/subtype, lower-case, codec parameters stripped. */
  mimeType: string;
  /** File extension without the dot. */
  extension: string;
}

/** Container subtype → the extension people expect for AUDIO in it. */
const EXTENSIONS: Record<string, string> = {
  webm: "webm",
  ogg: "ogg",
  // An audio-only MP4 is conventionally .m4a.
  mp4: "m4a",
  "x-m4a": "m4a",
  aac: "aac",
  mpeg: "mp3",
  wav: "wav",
  "x-wav": "wav",
  wave: "wav",
  flac: "flac",
};

/**
 * `audio/webm;codecs=opus` → `{ mimeType: "audio/webm", extension: "webm" }`,
 * `audio/mp4;codecs=mp4a.40.2` → `{ mimeType: "audio/mp4", extension: "m4a" }`.
 * An unknown or empty type falls back to WebM, the widget's own default when
 * the recorder reports none.
 */
export function nativeRecordingType(recordedMime: string): NativeRecordingType {
  const base = recordedMime.split(";")[0].trim().toLowerCase();
  const match = /^([a-z]+)\/([a-z0-9.+-]+)$/.exec(base);
  if (!match) return { mimeType: "audio/webm", extension: "webm" };
  const subtype = match[2];
  const extension = EXTENSIONS[subtype] ?? (/^[a-z0-9]+$/.test(subtype) ? subtype : "bin");
  return { mimeType: base, extension };
}

export interface RecordingExportPlan {
  format: "wav" | "native";
  mimeType: string;
  extension: string;
  /** What the WAV would weigh — the reason a native export happened. */
  wavBytes: number;
}

/**
 * WAV when its base64 fits in `maxBase64Chars`, else the native container.
 * `decoded` is the AudioBuffer the recording decodes to (only its length and
 * channel count are read), so the size is known before anything is encoded.
 *
 * The native file is sent whatever its size: it is the smallest form there is,
 * and the recorder's own MAX_RECORDING_BYTES bounds it.
 */
export function planRecordingExport(
  decoded: { length: number; numberOfChannels: number },
  recordedMime: string,
  maxBase64Chars = MAX_WAV_BASE64_CHARS,
): RecordingExportPlan {
  const wavBytes = wavByteLength(decoded.length, decoded.numberOfChannels);
  if (base64Length(wavBytes) <= maxBase64Chars) {
    return { format: "wav", mimeType: "audio/wav", extension: "wav", wavBytes };
  }
  return { format: "native", ...nativeRecordingType(recordedMime), wavBytes };
}

/** The status line after a native export: what was saved, and why. */
export function nativeExportStatus(plan: RecordingExportPlan): string {
  const mb = Math.max(1, Math.round(plan.wavBytes / 1_000_000));
  return `Long recording — saved as .${plan.extension} (WAV would be ~${mb} MB)`;
}
