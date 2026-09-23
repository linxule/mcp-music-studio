// =============================================================================
// #32: WAV export sent one very large base64 message, built synchronously.
//
// The policy (WAV vs the recorder's native container) is pure and tested here,
// along with the async encoders that keep the frame responsive: they must give
// byte-for-byte the output of the sync ones, and actually yield.
// =============================================================================

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  bytesToBase64,
  bytesToBase64Async,
  timeSlicer,
} from "../src/bytes-to-base64";
import {
  MAX_WAV_BASE64_CHARS,
  base64Length,
  nativeExportStatus,
  nativeRecordingType,
  planRecordingExport,
} from "../src/recording-export";
import {
  audioBufferToWavBase64,
  audioBufferToWavBytes,
  audioBufferToWavBytesAsync,
  wavByteLength,
} from "../src/wav-encoder";

const RATE = 48_000;
const seconds = (s: number, channels = 2) => ({ length: s * RATE, numberOfChannels: channels });

describe("sizes", () => {
  it("base64Length matches a real encoder, padding included", () => {
    for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 1000, 8191]) {
      expect(base64Length(n)).toBe(Buffer.alloc(n).toString("base64").length);
    }
  });

  it("wavByteLength is 44 + frames × channels × 2", () => {
    expect(wavByteLength(0, 2)).toBe(44);
    expect(wavByteLength(RATE, 2)).toBe(192_044); // 1 s of 48 kHz stereo
    expect(wavByteLength(RATE, 1)).toBe(96_044);
  });

  it("the cap is 32 MiB of base64 — about 2 minutes of 48 kHz stereo", () => {
    expect(MAX_WAV_BASE64_CHARS).toBe(33_554_432);
    // The arithmetic in the constant's comment.
    const wavBytes = (MAX_WAV_BASE64_CHARS * 3) / 4;
    expect(wavBytes).toBe(25_165_824);
    expect((wavBytes - 44) / (RATE * 2 * 2)).toBeCloseTo(131.07, 1);
  });
});

describe("planRecordingExport", () => {
  it("keeps short recordings as WAV", () => {
    for (const s of [1, 60, 120, 131]) {
      const plan = planRecordingExport(seconds(s), "audio/webm;codecs=opus");
      expect(plan).toMatchObject({ format: "wav", mimeType: "audio/wav", extension: "wav" });
    }
  });

  it("sends long recordings in the recorder's own container", () => {
    for (const s of [132, 180, 300]) {
      const plan = planRecordingExport(seconds(s), "audio/webm;codecs=opus");
      expect(plan).toMatchObject({ format: "native", mimeType: "audio/webm", extension: "webm" });
      expect(plan.wavBytes).toBe(wavByteLength(s * RATE, 2));
    }
  });

  it("switches at exactly the largest WAV whose base64 fits", () => {
    // The largest frame count whose WAV base64 is <= the cap (stereo: 4 B/frame).
    let frames = Math.floor(((MAX_WAV_BASE64_CHARS / 4) * 3 - 44) / 4);
    while (base64Length(wavByteLength(frames + 1, 2)) <= MAX_WAV_BASE64_CHARS) frames++;
    expect(planRecordingExport({ length: frames, numberOfChannels: 2 }, "audio/webm").format).toBe("wav");
    expect(planRecordingExport({ length: frames + 1, numberOfChannels: 2 }, "audio/webm").format).toBe(
      "native",
    );
  });

  it("gives mono twice the time", () => {
    expect(planRecordingExport(seconds(250, 1), "audio/mp4").format).toBe("wav");
    expect(planRecordingExport(seconds(270, 1), "audio/mp4").format).toBe("native");
  });

  it("names WebKit's MP4/AAC recording .m4a", () => {
    const plan = planRecordingExport(seconds(300), "audio/mp4;codecs=mp4a.40.2");
    expect(plan).toMatchObject({ format: "native", mimeType: "audio/mp4", extension: "m4a" });
  });

  it("honours an explicit cap", () => {
    expect(planRecordingExport(seconds(1), "audio/webm", 1000).format).toBe("native");
  });
});

describe("nativeRecordingType", () => {
  it.each([
    ["audio/webm;codecs=opus", "audio/webm", "webm"],
    ["audio/webm", "audio/webm", "webm"],
    ["AUDIO/WEBM; codecs=opus", "audio/webm", "webm"],
    ["audio/ogg;codecs=opus", "audio/ogg", "ogg"],
    ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "m4a"],
    ["audio/mp4", "audio/mp4", "m4a"],
    ["video/mp4", "video/mp4", "m4a"],
    ["audio/mpeg", "audio/mpeg", "mp3"],
    ["audio/x-custom", "audio/x-custom", "bin"],
    ["audio/aiff", "audio/aiff", "aiff"],
  ])("%s → %s .%s", (recorded, mimeType, extension) => {
    expect(nativeRecordingType(recorded)).toEqual({ mimeType, extension });
  });

  it("falls back to WebM for an empty or malformed type", () => {
    expect(nativeRecordingType("")).toEqual({ mimeType: "audio/webm", extension: "webm" });
    expect(nativeRecordingType("nonsense")).toEqual({ mimeType: "audio/webm", extension: "webm" });
  });
});

describe("nativeExportStatus", () => {
  it("says what was saved and how big the WAV would have been", () => {
    const plan = planRecordingExport(seconds(180), "audio/webm;codecs=opus");
    expect(nativeExportStatus(plan)).toBe("Long recording — saved as .webm (WAV would be ~35 MB)");
  });
});

// -----------------------------------------------------------------------------
// Async encoders
// -----------------------------------------------------------------------------

function counter() {
  let count = 0;
  return {
    get count() {
      return count;
    },
    yieldFn: async () => {
      count++;
    },
  };
}

describe("bytesToBase64Async", () => {
  it("matches the sync encoder at every slice boundary", async () => {
    for (const n of [0, 1, 2, 3, 8189, 8190, 8191, 16380, 16381, 100_003]) {
      const bytes = new Uint8Array(randomBytes(n));
      const expected = Buffer.from(bytes).toString("base64");
      expect(await bytesToBase64Async(bytes)).toBe(expected);
      expect(bytesToBase64(bytes)).toBe(expected);
    }
  });

  it("offers to yield between slices, never before the first", async () => {
    const yields = counter();
    const bytes = new Uint8Array(randomBytes(8190 * 3 + 1)); // 4 slices
    await bytesToBase64Async(bytes, yields.yieldFn);
    expect(yields.count).toBe(3);
  });
});

describe("timeSlicer", () => {
  it("yields only once the budget is spent, then starts a new slice", async () => {
    let now = 0;
    const yields = counter();
    const maybeYield = timeSlicer(12, yields.yieldFn, () => now);
    now = 5;
    await maybeYield();
    expect(yields.count).toBe(0);
    now = 12;
    await maybeYield();
    expect(yields.count).toBe(1);
    now = 20; // 8 ms into the new slice
    await maybeYield();
    expect(yields.count).toBe(1);
    now = 24;
    await maybeYield();
    expect(yields.count).toBe(2);
  });
});

function stubBuffer(frames: number, channels: number): AudioBuffer {
  const data = Array.from({ length: channels }, () => {
    const ch = new Float32Array(frames);
    for (let i = 0; i < frames; i++) ch[i] = Math.sin(i / 7) * 1.2; // exercises clamping
    return ch;
  });
  return {
    numberOfChannels: channels,
    sampleRate: RATE,
    length: frames,
    getChannelData: (c: number) => data[c],
  } as unknown as AudioBuffer;
}

describe("audioBufferToWavBytesAsync", () => {
  it("writes the same bytes as the sync encoder", async () => {
    const buffer = stubBuffer(40_000, 2); // not a multiple of the slice size
    const sync = audioBufferToWavBytes(buffer);
    const yields = counter();
    const async = await audioBufferToWavBytesAsync(buffer, yields.yieldFn);
    expect(Buffer.from(async).equals(Buffer.from(sync))).toBe(true);
    expect(async.length).toBe(wavByteLength(40_000, 2));
    expect(yields.count).toBe(2); // 3 slices of ≤16384 frames
  });

  it("keeps the sync base64 API byte-identical", async () => {
    const buffer = stubBuffer(1234, 1);
    expect(audioBufferToWavBase64(buffer)).toBe(
      await bytesToBase64Async(await audioBufferToWavBytesAsync(buffer)),
    );
  });
});

describe("strudel widget export", () => {
  const STRUDEL = readFileSync(
    fileURLToPath(new URL("../src/strudel-app.ts", import.meta.url)),
    "utf8",
  );
  const start = STRUDEL.indexOf("async function handleDownload()");
  const handler = STRUDEL.slice(start, STRUDEL.indexOf("\n}\n", start));

  it("plans from the decoded buffer, then encodes without blocking", () => {
    expect(start).toBeGreaterThan(0);
    expect(handler).toContain("await afterNextPaint();");
    expect(handler).toContain("planRecordingExport(decoded, recording.mimeType)");
    expect(handler).toContain("await audioBufferToWavBytesAsync(decoded)");
    expect(handler).toContain("await bytesToBase64Async(bytes)");
    expect(handler).toContain("mimeType: plan.mimeType");
    expect(handler).toContain("${plan.extension}");
    // The one-shot synchronous path is gone from the widget.
    expect(STRUDEL).not.toContain("audioBufferToWavBase64(");
  });
});
