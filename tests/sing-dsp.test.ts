// sing() signal processing (src/shared/sing-dsp.ts) on synthetic signals:
// pitch of a word, and its start snapped to where the sound begins.
import { describe, expect, it } from "vitest";
import { analyseWords, anchorPitch, detectPitch, findLoop, LOOP_SECONDS, pitchWindows, snapOffset, snapOnset } from "../src/shared/sing-dsp";

/** Seconds of a tone (fundamental + optional harmonics) after `lead` seconds of silence. */
function tone(sampleRate: number, seconds: number, hz: number, { lead = 0, harmonics = 1 } = {}): Float32Array {
  const out = new Float32Array(Math.round((lead + seconds) * sampleRate));
  const from = Math.round(lead * sampleRate);
  for (let i = from; i < out.length; i++) {
    const t = (i - from) / sampleRate;
    let v = 0;
    for (let k = 1; k <= harmonics; k++) v += Math.sin(2 * Math.PI * hz * k * t) / k;
    out[i] = 0.5 * v;
  }
  return out;
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe("detectPitch", () => {
  it.each([24_000, 44_100, 48_000])("a 220 Hz sine at %i Hz → 220 ± 2", (rate) => {
    const hz = detectPitch(tone(rate, 0.5, 220), rate);
    expect(hz).not.toBeNull();
    expect(Math.abs(hz! - 220)).toBeLessThan(2);
  });

  it("finds the fundamental of a harmonic-rich tone (a voice is not a sine)", () => {
    for (const f of [95, 150, 310]) {
      const hz = detectPitch(tone(48_000, 0.4, f, { harmonics: 8 }), 48_000);
      expect(Math.abs(hz! - f) / f).toBeLessThan(0.01);
    }
  });

  it("measures only the slice it is given", () => {
    const rate = 24_000;
    const signal = concat(tone(rate, 0.4, 180), tone(rate, 0.4, 260));
    expect(Math.abs(detectPitch(signal, rate, 0, 0.4)! - 180)).toBeLessThan(2);
    expect(Math.abs(detectPitch(signal, rate, 0.4, 0.8)! - 260)).toBeLessThan(3);
  });

  it("is null for silence and for noise", () => {
    expect(detectPitch(new Float32Array(24_000), 24_000)).toBeNull();
    let seed = 7;
    const noise = Float32Array.from({ length: 24_000 }, () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 30 - 1;
    });
    expect(detectPitch(noise, 24_000)).toBeNull();
  });

  it("is null for a slice too short to hold one window", () => {
    expect(detectPitch(tone(24_000, 0.5, 220), 24_000, 0.1, 0.11)).toBeNull();
  });
});

describe("the pitch a word is heard at", () => {
  const scaled = (x: Float32Array, k: number) => x.map((v) => v * k);
  it("is the LOUD part's pitch when a word jumps (asteria's \"deep.\": 178 Hz quiet, then 266 Hz loud)", () => {
    const rate = 48_000;
    const word = concat(scaled(tone(rate, 0.12, 178, { harmonics: 4 }), 0.45), tone(rate, 0.12, 266, { harmonics: 4 }));
    expect(Math.abs(detectPitch(word, rate)! - 266) / 266).toBeLessThan(0.01);
    // The plain median sits wherever the window count tips — not what is heard.
    expect(anchorPitch(pitchWindows(word, rate), "weighted")).toBeCloseTo(detectPitch(word, rate)!, 5);
  });
  it("measures a word with only 0.08 s of voice", () => {
    const hz = detectPitch(tone(24_000, 0.08, 230, { harmonics: 4 }), 24_000);
    expect(Math.abs(hz! - 230)).toBeLessThan(3);
  });
  it("anchors: weighted = energy-weighted median, loudest = median of the loudest 40%, median = plain", () => {
    const w = [
      { hz: 100, energy: 1 },
      { hz: 110, energy: 1 },
      { hz: 120, energy: 1 },
      { hz: 200, energy: 10 },
      { hz: 210, energy: 2 },
    ];
    expect(anchorPitch(w, "median")).toBe(120);
    expect(anchorPitch(w, "weighted")).toBe(200);
    expect(anchorPitch(w, "loudest")).toBe(205);
    expect(anchorPitch([], "weighted")).toBeNull();
  });
});

describe("snapOnset", () => {
  const rate = 24_000;
  const signal = tone(rate, 0.5, 220, { lead: 0.1 });

  it("moves an early boundary forward to where the sound starts", () => {
    expect(snapOnset(signal, rate, 0, 0.6)).toBeCloseTo(0.1, 2);
  });

  it("moves a late boundary back to it", () => {
    expect(snapOnset(signal, rate, 0.22, 0.6)).toBeCloseTo(0.1, 2);
  });

  it("leaves a boundary alone when no onset is within 150 ms", () => {
    expect(snapOnset(signal, rate, 0.4, 0.6)).toBe(0.4);
    // Continuous sound across the boundary: nothing rises there.
    expect(snapOnset(tone(rate, 1, 220), rate, 0.5, 0.8)).toBe(0.5);
  });
});

// The three ways Whisper's boundaries were off on a real Aura-2 line
// ("still water runs deep", 2026-10-04), rebuilt from tones.
describe("snapOnset — the measured cases", () => {
  const rate = 24_000;
  const scaled = (x: Float32Array, k: number) => x.map((v) => v * k);
  it("a quiet consonant before the vowel belongs to the word (\"Still\": s at 0.15, vowel at 0.32)", () => {
    const signal = concat(new Float32Array(rate * 0.15), scaled(tone(rate, 0.14, 3000), 0.04), new Float32Array(rate * 0.03), tone(rate, 0.3, 250));
    expect(snapOnset(signal, rate, 0, 0.5)).toBeCloseTo(0.15, 2);
  });
  it("a pause the ASR swallowed (\"deep\": Whisper 1.28, silence until 1.53)", () => {
    const signal = concat(tone(rate, 0.3, 170), new Float32Array(rate * 0.25), tone(rate, 0.25, 220));
    // Starts 0.3 into the clip, the word's sound at 0.55: beyond ±150 ms.
    expect(snapOnset(signal, rate, 0.3, 0.7)).toBeCloseTo(0.55, 2);
  });
  it("words running together split at the dip between them (\"water | runs\")", () => {
    const signal = concat(tone(rate, 0.4, 200), scaled(tone(rate, 0.03, 200), 0.08), tone(rate, 0.4, 170));
    expect(snapOnset(signal, rate, 0.32, 0.8)).toBeCloseTo(0.4, 1);
  });
});

describe("snapOffset", () => {
  const rate = 24_000;
  it("keeps a tail the ASR cut off (\"deep.\": Whisper 1.68, vowel to 1.79), never past the limit", () => {
    const signal = concat(tone(rate, 0.5, 220), new Float32Array(rate * 0.3));
    expect(snapOffset(signal, rate, 0, 0.4, 0.8)).toBeCloseTo(0.5, 2);
    expect(snapOffset(signal, rate, 0, 0.4, 0.45)).toBeCloseTo(0.45, 2);
  });
  it("pulls an end back over trailing silence", () => {
    const signal = concat(tone(rate, 0.3, 220), new Float32Array(rate * 0.3));
    expect(snapOffset(signal, rate, 0, 0.5, 0.6)).toBeCloseTo(0.3, 2);
  });
});

describe("analyseWords", () => {
  it("snaps each start and measures each word", () => {
    const rate = 48_000;
    const gap = () => new Float32Array(rate * 0.1);
    // 0.1 s silence, 200 Hz until 0.5, 0.1 s silence, 300 Hz until 1.0.
    const signal = concat(gap(), tone(rate, 0.4, 200, { harmonics: 4 }), gap(), tone(rate, 0.4, 300, { harmonics: 4 }));
    const words = analyseWords(signal, rate, [
      { word: "one", start: 0, end: 0.52 },
      { word: "two", start: 0.52, end: 1 },
    ]);
    expect(words[0].start).toBeCloseTo(0.1, 2);
    expect(words[1].start).toBeCloseTo(0.6, 2);
    expect(Math.abs(words[0].hz! - 200)).toBeLessThan(2);
    expect(Math.abs(words[1].hz! - 300)).toBeLessThan(3);
    expect(words.map((w) => w.word)).toEqual(["one", "two"]);
  });

  it("a word with no gap before it never starts before the previous word's loudest frame (\"the night\")", () => {
    const rate = 48_000;
    // 0.1 s silence, "the" 0.12 s at 200 Hz, then "night" 0.3 s at 210 Hz straight after, louder.
    const the = tone(rate, 0.12, 200, { harmonics: 4 });
    const night = tone(rate, 0.3, 210, { harmonics: 4 }).map((v) => v * 1.5);
    const signal = concat(new Float32Array(rate * 0.1), the, night);
    // Whisper puts "night" a little late, as it does.
    const words = analyseWords(signal, rate, [
      { word: "the", start: 0.08, end: 0.22 },
      { word: "night", start: 0.25, end: 0.52 },
    ]);
    expect(words[0].start).toBeCloseTo(0.1, 2);
    expect(words[1].start).toBeGreaterThan(0.15);
    expect(words[1].start).toBeLessThan(0.3);
  });

  it("keeps every word at least 30 ms long and inside the clip", () => {
    const words = analyseWords(new Float32Array(24_000), 24_000, [{ word: "x", start: 0.99, end: 2 }]);
    expect(words[0].end).toBe(1);
    expect(words[0].end - words[0].start).toBeGreaterThanOrEqual(0.03 - 1e-9);
    expect(words[0].hz).toBeNull();
  });
});

describe("findLoop — the window a held word repeats", () => {
  const rate = 48_000;
  it("is a whole number of periods between rising zero crossings, in the loud part, with a clean seam", () => {
    const signal = tone(rate, 0.4, 200, { harmonics: 4, lead: 0.1 });
    const loop = findLoop(signal, rate, 0.1, 0.5, 200)!;
    expect(loop).not.toBeNull();
    const periods = (loop.end - loop.start) * 200;
    expect(Math.abs(periods - Math.round(periods))).toBeLessThan(0.02);
    expect(Math.abs(loop.end - loop.start - LOOP_SECONDS)).toBeLessThan(1 / 200);
    const at = (t: number) => signal[Math.round(t * rate)];
    expect(at(loop.start)).toBeGreaterThan(0);
    expect(at(loop.start - 1 / rate)).toBeLessThanOrEqual(0);
    expect(Math.abs(at(loop.start) - at(loop.end))).toBeLessThan(0.02);
    expect(loop.start).toBeGreaterThanOrEqual(0.1);
    expect(loop.end).toBeLessThanOrEqual(0.5);
    expect(Math.abs(loop.hz - 200)).toBeLessThan(1);
  });
  it("loops the part of a gliding word that sits at the anchor pitch, and says that part's pitch", () => {
    // 0.2 s at 200 Hz, then 0.2 s at 300 Hz, twice as loud: the anchor is 300 Hz.
    const signal = concat(tone(rate, 0.2, 200, { harmonics: 3 }), tone(rate, 0.2, 300, { harmonics: 3 }).map((v) => v * 2));
    const hz = detectPitch(signal, rate, 0, 0.4)!;
    expect(Math.abs(hz - 300)).toBeLessThan(3);
    const loop = findLoop(signal, rate, 0, 0.4, hz)!;
    expect(loop.start).toBeGreaterThanOrEqual(0.2);
    expect(Math.abs(loop.hz - 300)).toBeLessThan(2);
    // Asked for the quiet part's pitch instead: its windows are a quarter as
    // loud, still above the quieter tier, so that part loops at its own pitch.
    const quiet = findLoop(signal, rate, 0, 0.4, 200)!;
    expect(quiet.end).toBeLessThanOrEqual(0.2 + 1e-3);
    expect(Math.abs(quiet.hz - 200)).toBeLessThan(2);
    // Nothing near the asked pitch at all: no loop.
    expect(findLoop(signal, rate, 0, 0.4, 120)).toBeNull();
  });
  it("loops the flat part of a word, not its decay (a decaying loop stutters at the loop rate)", () => {
    // 0.25 s flat at 220 Hz, then 0.25 s decaying to a tenth: same pitch throughout.
    const flat = tone(rate, 0.25, 220, { harmonics: 3 });
    const decay = tone(rate, 0.25, 220, { harmonics: 3 }).map((v, i, arr) => v * (1 - 0.9 * (i / arr.length)));
    const signal = concat(flat, decay);
    const loop = findLoop(signal, rate, 0, 0.5, 220)!;
    expect(loop.end).toBeLessThanOrEqual(0.25 + 0.05);
    // A word that only decays (9 dB over 0.25 s): a shorter window where it is flat enough, never a stutter.
    const short = findLoop(decay, rate, 0, 0.25, 220)!;
    expect(short).not.toBeNull();
    expect(short.end - short.start).toBeLessThan(LOOP_SECONDS);
    // Falling 20 dB in 60 ms: nothing is flat — the word plays once.
    const cliff = tone(rate, 0.06, 220, { harmonics: 3 }).map((v, i, arr) => v * (1 - 0.9 * (i / arr.length)));
    expect(findLoop(concat(cliff, new Float32Array(rate * 0.1)), rate, 0, 0.16, 220)).toBeNull();
  });
  it("never loops into the silence after a vowel (\"kind\": the n and d closure)", () => {
    const signal = concat(tone(rate, 0.3, 220, { harmonics: 3 }), new Float32Array(rate * 0.2));
    const loop = findLoop(signal, rate, 0, 0.5, 220)!;
    expect(loop.end).toBeLessThanOrEqual(0.3 + 1e-3);
  });
  it("is null for a span too short to loop, for silence, and without a pitch", () => {
    expect(findLoop(tone(rate, 0.03, 200), rate, 0, 0.03, 200)).toBeNull();
    expect(findLoop(new Float32Array(rate), rate, 0, 1, 200)).toBeNull();
    expect(findLoop(tone(rate, 0.4, 200), rate, 0, 0.4, 0)).toBeNull();
  });
  it("analyseWords carries each voiced word's loop; an unvoiced word has none", () => {
    const signal = concat(new Float32Array(rate * 0.1), tone(rate, 0.4, 200, { harmonics: 4 }), new Float32Array(rate * 0.3));
    const words = analyseWords(signal, rate, [
      { word: "one", start: 0, end: 0.5 },
      { word: "two", start: 0.5, end: 0.8 },
    ]);
    expect(words[0].loop).not.toBeNull();
    expect(words[0].loop!.start).toBeGreaterThanOrEqual(words[0].start);
    expect(words[0].loop!.end).toBeLessThanOrEqual(words[0].end);
    expect(words[1].hz).toBeNull();
    expect(words[1].loop).toBeNull();
  });
});
