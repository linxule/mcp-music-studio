/**
 * @file MIDI export helpers + a structural smoke test on abcjs's getMidiFile.
 *
 * The widget button itself lives in src/mcp-app.ts (browser-only), but the
 * pieces it depends on — byte→base64, filename sanitising, and the shape of
 * what abcjs returns for `midiOutputType: "binary"` — are all checkable here.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ABCJS from "abcjs";
import { bytesToBase64, sanitizeFileStem } from "../src/bytes-to-base64";
import { audioBufferToWavBase64 } from "../src/wav-encoder";
import { applyStyleToAbc } from "../src/music-logic";

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "abc",
);

describe("bytesToBase64", () => {
  it("encodes an empty buffer to an empty string", () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe("");
  });

  it("matches Buffer's base64 for arbitrary bytes", () => {
    const bytes = new Uint8Array(1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) % 256;
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("survives buffers larger than the 8KB chunk size", () => {
    const bytes = new Uint8Array(70_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const encoded = bytesToBase64(bytes);
    expect(encoded).toBe(Buffer.from(bytes).toString("base64"));
    expect(Buffer.from(encoded, "base64")).toEqual(Buffer.from(bytes));
  });

  it("still backs the WAV encoder", () => {
    // 1-channel, 4-frame buffer of silence — enough to prove the plumbing.
    const fake = {
      numberOfChannels: 1,
      sampleRate: 44100,
      length: 4,
      getChannelData: () => new Float32Array(4),
    } as unknown as AudioBuffer;
    const wav = Buffer.from(audioBufferToWavBase64(fake), "base64");
    expect(wav.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("latin1")).toBe("WAVE");
  });
});

describe("sanitizeFileStem", () => {
  it("keeps safe characters and collapses the rest", () => {
    expect(sanitizeFileStem("Studio fixture 01")).toBe("Studio_fixture_01");
    expect(sanitizeFileStem("my-tune_v2")).toBe("my-tune_v2");
  });

  it("strips path traversal and separators", () => {
    expect(sanitizeFileStem("../../etc/passwd")).toBe("etc_passwd");
    expect(sanitizeFileStem("a/b\\c")).toBe("a_b_c");
  });

  it("falls back when nothing usable is left", () => {
    expect(sanitizeFileStem("   ")).toBe("music");
    expect(sanitizeFileStem("///", "score")).toBe("score");
  });

  it("caps the length", () => {
    expect(sanitizeFileStem("a".repeat(200))).toHaveLength(80);
  });
});

describe("ABCJS.synth.getMidiFile — binary output", () => {
  const abc = readFileSync(
    path.join(FIXTURE_DIR, "06-chords-style.abc"),
    "utf8",
  );

  function midiBytes(source: string, options: Record<string, unknown> = {}) {
    const tune = ABCJS.parseOnly(source)[0];
    return ABCJS.synth.getMidiFile(tune, {
      midiOutputType: "binary",
      ...options,
    }) as Uint8Array;
  }

  it("returns a Uint8Array holding a well-formed SMF header", () => {
    const bytes = midiBytes(abc, { program: 73 });

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);

    const buf = Buffer.from(bytes);
    expect(buf.subarray(0, 4).toString("latin1")).toBe("MThd");
    expect(buf.readUInt32BE(4)).toBe(6); // header chunk length
    expect(buf.readUInt16BE(8)).toBe(1); // format 1 = multi-track
    expect(buf.readUInt16BE(12)).toBeGreaterThan(0); // division / PPQ
  });

  it("puts the accompaniment on separate tracks", () => {
    const styled = applyStyleToAbc(abc, "jazz");
    const buf = Buffer.from(midiBytes(styled, { program: 0 }));

    const declaredTracks = buf.readUInt16BE(10);
    expect(declaredTracks).toBeGreaterThan(1);

    let chunks = 0;
    for (let i = 0; i <= buf.length - 4; i++) {
      if (buf.subarray(i, i + 4).toString("latin1") === "MTrk") chunks++;
    }
    expect(chunks).toBe(declaredTracks);
  });

  it("survives base64 round-tripping intact", () => {
    const bytes = midiBytes(abc);
    const encoded = bytesToBase64(bytes);
    expect(Buffer.from(encoded, "base64")).toEqual(Buffer.from(bytes));
  });

  it("works for every corpus fixture that parses", () => {
    for (const name of [
      "01-simple-melody",
      "02-multiple-voices",
      "03-tuplets",
      "04-repeats-endings",
      "05-lyrics",
      "07-meter-change",
      "08-ties-slurs-accidentals",
      "09-grace-dynamics",
    ]) {
      const source = readFileSync(
        path.join(FIXTURE_DIR, `${name}.abc`),
        "utf8",
      );
      const bytes = midiBytes(source);
      expect(Buffer.from(bytes).subarray(0, 4).toString("latin1")).toBe("MThd");
    }
  });
});
