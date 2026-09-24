import { bytesToBase64, timeSlicer } from "./bytes-to-base64";

/** The canonical PCM header: RIFF + fmt + data chunk headers. */
export const WAV_HEADER_BYTES = 44;
/** 16-bit PCM. */
const BYTES_PER_SAMPLE = 2;

/** Size of the WAV these encoders produce, known before encoding anything. */
export function wavByteLength(frames: number, channels: number): number {
  return WAV_HEADER_BYTES + frames * channels * BYTES_PER_SAMPLE;
}

/**
 * Encode an AudioBuffer as a base64 WAV string (16-bit PCM).
 */
export function audioBufferToWavBase64(buffer: AudioBuffer): string {
  return bytesToBase64(audioBufferToWavBytes(buffer));
}

/** Encode an AudioBuffer as WAV bytes (16-bit PCM). */
export function audioBufferToWavBytes(buffer: AudioBuffer): Uint8Array {
  const { view, bytes, channels } = startWav(buffer);
  writeFrames(view, channels, 0, buffer.length);
  return bytes;
}

/** Frames interleaved between checks of the time budget. */
const FRAMES_PER_SLICE = 16384;

/**
 * audioBufferToWavBytes() for long recordings: the interleave loop yields to
 * the event loop between time slices, so the frame keeps painting and taking
 * input while minutes of audio are encoded. Same bytes.
 */
export async function audioBufferToWavBytesAsync(
  buffer: AudioBuffer,
  maybeYield: () => Promise<void> = timeSlicer(),
): Promise<Uint8Array> {
  const { view, bytes, channels } = startWav(buffer);
  for (let from = 0; from < buffer.length; from += FRAMES_PER_SLICE) {
    if (from > 0) await maybeYield();
    writeFrames(view, channels, from, Math.min(buffer.length, from + FRAMES_PER_SLICE));
  }
  return bytes;
}

/** Allocate the whole file and write its header; the frames come after. */
function startWav(buffer: AudioBuffer): {
  view: DataView;
  bytes: Uint8Array;
  channels: Float32Array[];
} {
  const numCh = buffer.numberOfChannels;
  const sr = buffer.sampleRate;
  const dataSize = wavByteLength(buffer.length, numCh) - WAV_HEADER_BYTES;
  const arrayBuf = new ArrayBuffer(WAV_HEADER_BYTES + dataSize);
  const view = new DataView(arrayBuf);

  // RIFF header
  writeStr(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(view, 8, "WAVE");

  // fmt chunk
  writeStr(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * numCh * BYTES_PER_SAMPLE, true);
  view.setUint16(32, numCh * BYTES_PER_SAMPLE, true);
  view.setUint16(34, 16, true);

  // data chunk
  writeStr(view, 36, "data");
  view.setUint32(40, dataSize, true);

  const channels = Array.from({ length: numCh }, (_, i) => buffer.getChannelData(i));
  return { view, bytes: new Uint8Array(arrayBuf), channels };
}

/** Interleave frames [from, to) as clamped 16-bit samples. */
function writeFrames(view: DataView, channels: Float32Array[], from: number, to: number): void {
  const numCh = channels.length;
  let offset = WAV_HEADER_BYTES + from * numCh * BYTES_PER_SAMPLE;
  for (let i = from; i < to; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += BYTES_PER_SAMPLE;
    }
  }
}

function writeStr(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
