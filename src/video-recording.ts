// =============================================================================
// Recording a set as a video — the DOM-free half
//
// The Strudel widget's "Rec video" composites the stage's canvases (Hydra's
// WebGL layer, then the 2D draw layers) onto one canvas every frame, streams
// it with captureStream(30) next to the post-limiter audio tap, and records
// that with MediaRecorder (src/strudel-app/recording.ts does the I/O). What can
// be decided without a browser lives here, so it is unit-tested: the limits,
// the container negotiation, the frame size and letterbox, Chromium's missing
// WebM duration, and the setlist written next to a live session's video.
// =============================================================================

/** Both recording kinds stop at whichever bound they reach first. */
export const RECORD_LIMITS = {
  audio: { minutes: 5, bytes: 50 * 1024 * 1024 },
  video: { minutes: 5, bytes: 80 * 1024 * 1024 },
} as const;

export type RecordKind = keyof typeof RECORD_LIMITS;

/**
 * ~2 Mbit/s of video + 128 kbit/s of audio ≈ 16 MB a minute, so five minutes
 * land near the 80 MB cap rather than tripping it at three.
 */
export const VIDEO_BITS_PER_SECOND = 2_000_000;
export const VIDEO_AUDIO_BITS_PER_SECOND = 128_000;
export const VIDEO_FPS = 30;

/** The recorded frame never exceeds this; the stage's aspect is kept. */
export const VIDEO_MAX = { width: 1280, height: 720 } as const;

/**
 * Tried in order. Measured (scripts/prototype-video.mjs, 2026-10-04): Chromium
 * takes VP9+Opus WebM; WebKit claims no WebM and records H.264+AAC in MP4.
 * "" = let the UA pick.
 */
export const VIDEO_MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/mp4",
  "",
] as const;

/** The first candidate `isTypeSupported` accepts; "" when none is claimed (or it can't be asked). */
export function pickVideoMime(isTypeSupported?: (mime: string) => boolean): string {
  if (!isTypeSupported) return "";
  for (const mime of VIDEO_MIME_CANDIDATES) {
    if (mime === "") break;
    try {
      if (isTypeSupported(mime)) return mime;
    } catch { /* a throwing check is a "no" */ }
  }
  return "";
}

/**
 * The recording canvas: the stage's CSS size × devicePixelRatio, scaled down
 * (never up) to fit VIDEO_MAX with its aspect kept. Even dimensions, because
 * H.264 (WebKit's MP4) encodes 4:2:0 and rejects or crops odd ones.
 */
export function videoFrameSize(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
  max: { width: number; height: number } = VIDEO_MAX,
): { width: number; height: number } {
  const w = Math.max(2, cssWidth * (dpr > 0 ? dpr : 1));
  const h = Math.max(2, cssHeight * (dpr > 0 ? dpr : 1));
  const scale = Math.min(1, max.width / w, max.height / h);
  const even = (n: number) => Math.max(2, 2 * Math.floor(n / 2));
  return { width: even(w * scale), height: even(h * scale) };
}

/**
 * Where a `src` canvas goes inside the `dst` frame: as large as fits, aspect
 * kept, centred — letterboxed, never stretched. The frame size is fixed when
 * recording starts, so a stage resized mid-set (fullscreen, a rotated phone)
 * keeps its shape inside it.
 */
export function letterbox(
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
): { x: number; y: number; width: number; height: number } {
  if (srcWidth <= 0 || srcHeight <= 0) return { x: 0, y: 0, width: dstWidth, height: dstHeight };
  const scale = Math.min(dstWidth / srcWidth, dstHeight / srcHeight);
  const width = srcWidth * scale;
  const height = srcHeight * scale;
  return { x: (dstWidth - width) / 2, y: (dstHeight - height) / 2, width, height };
}

/** `video/webm;codecs=vp9,opus` → `{ mimeType: "video/webm", extension: "webm" }`; MP4 → `.mp4`. */
export function nativeVideoType(recordedMime: string): { mimeType: string; extension: string } {
  const base = recordedMime.split(";")[0].trim().toLowerCase();
  if (/^(video|audio)\/mp4$/.test(base) || base === "video/quicktime") return { mimeType: "video/mp4", extension: "mp4" };
  if (/^(video|audio)\/x-matroska$/.test(base)) return { mimeType: "video/x-matroska", extension: "mkv" };
  return { mimeType: "video/webm", extension: "webm" };
}

// -----------------------------------------------------------------------------
// WebM duration
//
// Chromium's MediaRecorder writes a live WebM: the Segment has an "unknown"
// size, there is no SeekHead or Cues, and Segment ▸ Info carries no Duration —
// so players report Infinity and most can't show or scrub a timeline. The
// recording's length is known when it stops; write it into Info.
//
// Inserting 11 bytes into Info is safe exactly because nothing in such a file
// points at byte offsets: an unknown-size Segment needs no size fix-up, and no
// SeekHead/Cues means no positions to shift. A file that HAS a SeekHead or a
// known-size Segment we cannot re-encode in place is returned unpatched (null).
// -----------------------------------------------------------------------------

const EBML_ID = 0x1a45dfa3;
const SEGMENT_ID = 0x18538067;
const SEEKHEAD_ID = 0x114d9b74;
const INFO_ID = 0x1549a966;
const TIMECODE_SCALE_ID = 0x2ad7b1;
const DURATION_ID = 0x4489;
const CLUSTER_ID = 0x1f43b675;

interface Vint {
  value: number;
  length: number;
  /** All value bits set: EBML's "unknown size". */
  unknown: boolean;
}

function readVint(bytes: Uint8Array, pos: number, keepMarker: boolean): Vint | null {
  if (pos >= bytes.length) return null;
  const first = bytes[pos];
  if (first === 0) return null;
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8 || pos + length > bytes.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = (first & (0xff >> length)) === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[pos + i];
    if (bytes[pos + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

/** An element size as a `length`-byte vint, or null if it doesn't fit. */
function encodeSize(value: number, length: number): Uint8Array | null {
  if (length < 1 || length > 8 || value >= 2 ** (7 * length) - 1) return null;
  const out = new Uint8Array(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (length - 1);
  return out;
}

interface Element {
  id: number;
  /** Offset of the ID. */
  start: number;
  sizeOffset: number;
  sizeLength: number;
  dataStart: number;
  /** Data length; null for an unknown size. */
  size: number | null;
}

function readElement(bytes: Uint8Array, pos: number): Element | null {
  const id = readVint(bytes, pos, true);
  if (!id) return null;
  const size = readVint(bytes, pos + id.length, false);
  if (!size) return null;
  return {
    id: id.value,
    start: pos,
    sizeOffset: pos + id.length,
    sizeLength: size.length,
    dataStart: pos + id.length + size.length,
    size: size.unknown ? null : size.value,
  };
}

function readUint(bytes: Uint8Array, start: number, length: number): number {
  let v = 0;
  for (let i = 0; i < length; i++) v = v * 256 + bytes[start + i];
  return v;
}

/**
 * Write `durationMs` into a WebM's Segment ▸ Info ▸ Duration. Returns the
 * patched bytes (a new array), or null when the file isn't one this can
 * patch safely — the caller then exports the original.
 */
export function fixWebmDuration(bytes: Uint8Array, durationMs: number): Uint8Array | null {
  if (!(durationMs > 0) || !Number.isFinite(durationMs)) return null;
  const header = readElement(bytes, 0);
  if (!header || header.id !== EBML_ID || header.size === null) return null;
  const segment = readElement(bytes, header.dataStart + header.size);
  if (!segment || segment.id !== SEGMENT_ID) return null;
  const segmentEnd = segment.size === null ? bytes.length : Math.min(bytes.length, segment.dataStart + segment.size);

  let info: Element | null = null;
  for (let pos = segment.dataStart; pos < segmentEnd; ) {
    const el = readElement(bytes, pos);
    if (!el) return null;
    if (el.id === SEEKHEAD_ID) return null;
    if (el.id === INFO_ID) {
      info = el;
      break;
    }
    if (el.id === CLUSTER_ID || el.size === null) return null;
    pos = el.dataStart + el.size;
  }
  if (!info || info.size === null) return null;
  const infoEnd = info.dataStart + info.size;
  if (infoEnd > bytes.length) return null;

  let timecodeScale = 1_000_000;
  let duration: Element | null = null;
  for (let pos = info.dataStart; pos < infoEnd; ) {
    const el = readElement(bytes, pos);
    if (!el || el.size === null) return null;
    if (el.id === TIMECODE_SCALE_ID && el.size >= 1 && el.size <= 6) timecodeScale = readUint(bytes, el.dataStart, el.size) || timecodeScale;
    if (el.id === DURATION_ID) duration = el;
    pos = el.dataStart + el.size;
  }
  // Duration is in TimecodeScale units (ns per tick; 1e6 = milliseconds).
  const ticks = (durationMs * 1_000_000) / timecodeScale;

  if (duration) {
    const out = bytes.slice();
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    if (duration.size === 8) view.setFloat64(duration.dataStart, ticks);
    else if (duration.size === 4) view.setFloat32(duration.dataStart, ticks);
    else return null;
    return out;
  }

  // ID 0x4489, size 8, float64 big-endian.
  const element = new Uint8Array(11);
  element.set([0x44, 0x89, 0x88]);
  new DataView(element.buffer).setFloat64(3, ticks);
  const newInfoSize = encodeSize(info.size + element.length, info.sizeLength) ?? encodeSize(info.size + element.length, 8);
  if (!newInfoSize) return null;
  const grow = element.length + newInfoSize.length - info.sizeLength;

  let segmentSize: Uint8Array | null = null;
  if (segment.size !== null) {
    segmentSize = encodeSize(segment.size + grow, segment.sizeLength);
    if (!segmentSize) return null;
  }

  const out = new Uint8Array(bytes.length + grow);
  out.set(bytes.subarray(0, info.sizeOffset), 0);
  if (segmentSize) out.set(segmentSize, segment.sizeOffset);
  let at = info.sizeOffset;
  out.set(newInfoSize, at);
  at += newInfoSize.length;
  out.set(element, at);
  at += element.length;
  out.set(bytes.subarray(info.dataStart), at);
  return out;
}

/** Duration (ms) a WebM's Info declares, or null — for tests and checks. */
export function readWebmDuration(bytes: Uint8Array): number | null {
  const header = readElement(bytes, 0);
  if (!header || header.size === null) return null;
  const segment = readElement(bytes, header.dataStart + header.size);
  if (!segment || segment.id !== SEGMENT_ID) return null;
  for (let pos = segment.dataStart; pos < bytes.length; ) {
    const el = readElement(bytes, pos);
    if (!el || el.size === null) return null;
    if (el.id === INFO_ID) {
      let scale = 1_000_000;
      let ticks: number | null = null;
      for (let p = el.dataStart; p < el.dataStart + el.size; ) {
        const c = readElement(bytes, p);
        if (!c || c.size === null) return null;
        const view = new DataView(bytes.buffer, bytes.byteOffset + c.dataStart, c.size);
        if (c.id === TIMECODE_SCALE_ID) scale = readUint(bytes, c.dataStart, c.size);
        if (c.id === DURATION_ID) ticks = c.size === 8 ? view.getFloat64(0) : c.size === 4 ? view.getFloat32(0) : null;
        p = c.dataStart + c.size;
      }
      return ticks === null ? null : (ticks * scale) / 1_000_000;
    }
    pos = el.dataStart + el.size;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Setlist — what changed during a recorded live set, as plain text
// -----------------------------------------------------------------------------

export interface SetlistEntry {
  /** Milliseconds into the recording. */
  atMs: number;
  /** Strudel cycle the change was heard from (one cycle = one bar), if known. */
  cycle: number | null;
  /** Who changed it. */
  by: "start" | "claude" | "you" | "tool";
  /** update-session revision, for Claude's changes. */
  rev?: number;
  code: string;
}

/**
 * The line that names a pattern: its first `//` comment (Claude tends to head
 * a section with one), else its first line of code. Single-line, ≤ 72 chars.
 */
export function setlistLabel(code: string): string {
  const lines = code.split("\n").map((l) => l.trim()).filter(Boolean);
  const comment = lines.find((l) => l.startsWith("//"));
  const text = comment ? comment.replace(/^\/\/+\s*/, "") : lines[0] ?? "";
  const flat = text.replace(/\s+/g, " ");
  return flat.length > 72 ? `${flat.slice(0, 71)}…` : flat;
}

/** 83.2 s → "1:23.2". */
export function formatClock(ms: number): string {
  const tenths = Math.max(0, Math.round(ms / 100));
  const minutes = Math.floor(tenths / 600);
  const seconds = (tenths % 600) / 10;
  return `${minutes}:${seconds < 10 ? "0" : ""}${seconds.toFixed(1)}`;
}

const BY: Record<SetlistEntry["by"], string> = {
  start: "start",
  claude: "Claude",
  you: "you (edit)",
  tool: "swap-pattern",
};

export function formatSetlist(
  entries: SetlistEntry[],
  meta: { title: string; recordedAt: Date; durationMs: number; file: string },
): string {
  const rows = entries.map((e) => {
    const who = e.by === "claude" && e.rev !== undefined ? `Claude (rev ${e.rev})` : BY[e.by];
    const bar = e.cycle === null ? "—" : String(Math.floor(e.cycle));
    return [formatClock(e.atMs), bar, who, setlistLabel(e.code)];
  });
  const head = ["time", "bar", "by", "pattern"];
  const width = (i: number) => Math.max(head[i].length, ...rows.map((r) => r[i].length));
  const line = (r: string[]) => `${r[0].padEnd(width(0))}  ${r[1].padStart(width(1))}  ${r[2].padEnd(width(2))}  ${r[3]}`.trimEnd();
  return [
    `${meta.title} — setlist`,
    `Recorded ${meta.recordedAt.toISOString().replace("T", " ").slice(0, 16)} UTC, ${formatClock(meta.durationMs)} long — ${meta.file}`,
    "",
    line(head),
    ...rows.map(line),
    "",
  ].join("\n");
}
