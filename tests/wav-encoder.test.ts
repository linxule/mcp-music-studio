import { describe, expect, it } from "vitest";
import { audioBufferToWavBase64 } from "../src/wav-encoder";

// Minimal AudioBuffer-shaped stub matching exactly what audioBufferToWavBase64
// reads: numberOfChannels, sampleRate, length, getChannelData(ch).
function makeStubBuffer(
  channels: Float32Array[],
  sampleRate: number,
): AudioBuffer {
  const length = channels[0]?.length ?? 0;
  const stub = {
    numberOfChannels: channels.length,
    sampleRate,
    length,
    getChannelData(ch: number): Float32Array {
      return channels[ch];
    },
  };
  // The encoder only touches the four members above.
  return stub as unknown as AudioBuffer;
}

function decode(b64: string): Buffer {
  return Buffer.from(b64, "base64");
}

const SAMPLE_RATE = 44100;

describe("audioBufferToWavBase64", () => {
  it("produces a canonical 44-byte WAV header (mono)", () => {
    // length 4, includes a negative and a positive sample for clamping path.
    const ch0 = new Float32Array([0, 0.5, -0.5, 1]);
    const buf = makeStubBuffer([ch0], SAMPLE_RATE);

    const bytes = decode(audioBufferToWavBase64(buf));

    const numCh = 1;
    const dataSize = ch0.length * numCh * 2; // length * channels * bytesPerSample

    // RIFF / WAVE / fmt  / data chunk identifiers
    expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
    expect(bytes.toString("ascii", 8, 12)).toBe("WAVE");
    expect(bytes.toString("ascii", 12, 16)).toBe("fmt ");
    expect(bytes.toString("ascii", 36, 40)).toBe("data");

    // fmt chunk fields (little-endian)
    expect(bytes.readUInt16LE(20)).toBe(1); // audio format = PCM
    expect(bytes.readUInt16LE(22)).toBe(numCh); // num channels
    expect(bytes.readUInt32LE(24)).toBe(SAMPLE_RATE); // sample rate
    expect(bytes.readUInt16LE(34)).toBe(16); // bits per sample

    // data size + RIFF chunk size + total byte length
    expect(bytes.readUInt32LE(40)).toBe(dataSize);
    expect(bytes.readUInt32LE(4)).toBe(36 + dataSize);
    expect(bytes.length).toBe(44 + dataSize);
  });

  it("encodes stereo with interleaved 16-bit samples and correct sizes", () => {
    const left = new Float32Array([0, 1, -1, 0.25]);
    const right = new Float32Array([-1, 0, 0.75, -0.25]);
    const buf = makeStubBuffer([left, right], SAMPLE_RATE);

    const bytes = decode(audioBufferToWavBase64(buf));

    const numCh = 2;
    const dataSize = left.length * numCh * 2;

    expect(bytes.readUInt16LE(22)).toBe(numCh);
    expect(bytes.readUInt32LE(40)).toBe(dataSize);
    expect(bytes.length).toBe(44 + dataSize);
    // byte rate = sampleRate * numCh * bytesPerSample
    expect(bytes.readUInt32LE(28)).toBe(SAMPLE_RATE * numCh * 2);
    // block align = numCh * bytesPerSample
    expect(bytes.readUInt16LE(32)).toBe(numCh * 2);

    // First interleaved frame: left[0]=0 -> 0, right[0]=-1 -> -32768 (0x8000).
    expect(bytes.readInt16LE(44)).toBe(0); // left[0]
    expect(bytes.readInt16LE(46)).toBe(-32768); // right[0], full-scale negative
  });

  it("clamps and scales boundary samples (16-bit PCM)", () => {
    // +1 -> 0x7fff (32767), -1 -> -0x8000 (-32768); out-of-range clamps.
    const ch0 = new Float32Array([1, -1, 2, -2]);
    const buf = makeStubBuffer([ch0], SAMPLE_RATE);

    const bytes = decode(audioBufferToWavBase64(buf));

    expect(bytes.readInt16LE(44)).toBe(32767); // +1 => 0x7fff
    expect(bytes.readInt16LE(46)).toBe(-32768); // -1 => -0x8000
    expect(bytes.readInt16LE(48)).toBe(32767); // +2 clamps to +1 => 0x7fff
    expect(bytes.readInt16LE(50)).toBe(-32768); // -2 clamps to -1 => -0x8000
  });
});
