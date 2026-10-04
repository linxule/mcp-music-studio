// sing() — the pure half (src/shared/sing.ts) and the runtime global
// (src/shared/stage-runtime.ts), with real Strudel patterns.
import { Pattern, s, silence, stepcat } from "@strudel/core";
import { mini } from "@strudel/mini";
import { describe, expect, it } from "vitest";
import {
  buildPhrase,
  layoutWords,
  midiToHz,
  mp3Info,
  noteSource,
  parseWhisperWords,
  SING_MAX_SPEED,
  ttsWordsUrl,
  wordSpeeds,
  autoOctave,
  describeSung,
  spokenMedianHz,
  type SungReport,
} from "../src/shared/sing";
import { createStage, stageEvent, type StageEnv, type SungClip } from "../src/shared/stage-runtime";
import { ttsSampleName } from "../src/shared/tts";
import { asrChars } from "../src/shared/voice-budget";

const midiOf = (hap: any) => stageEvent(hap, Number(hap.whole.begin)).midi;
const kit = { sound: (name: string) => s(name), timecat: (...pairs: any[]) => stepcat(...pairs), silence };

/** MPEG-2 Layer III frames as Aura-2 sends them: 48 kbps, 24 kHz, 144 bytes, 576 samples. */
function mp3Frames(count: number, id3 = false): Uint8Array {
  const tag = id3 ? [0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 5, 1, 2, 3, 4, 5] : [];
  const out = new Uint8Array(tag.length + count * 144);
  out.set(tag);
  for (let f = 0; f < count; f++) out.set([0xff, 0xf3, 0x64, 0xc4], tag.length + f * 144);
  return out;
}

describe("mp3Info", () => {
  it("counts Layer III frames (Aura-2's MPEG-2, 24 kHz)", () => {
    expect(mp3Info(mp3Frames(81))).toEqual({ sampleRate: 24_000, duration: 1.944, frames: 81 });
  });
  it("skips an ID3 tag and stops at trailing junk", () => {
    const bytes = new Uint8Array([...mp3Frames(10, true), 0x54, 0x41, 0x47, 0, 0, 0]);
    expect(mp3Info(bytes)?.frames).toBe(10);
  });
  it("is null for what isn't MP3", () => {
    expect(mp3Info(new TextEncoder().encode("RIFF....WAVEfmt "))).toBeNull();
    expect(mp3Info(new Uint8Array())).toBeNull();
  });
});

describe("parseWhisperWords", () => {
  it("takes segments[].words, trims the leading space, clamps to the clip", () => {
    const out = {
      text: " Still water runs deep.",
      segments: [
        { words: [{ word: " Still", start: 0, end: 0.5 }, { word: " water", start: 0.5, end: 0.88 }] },
        { words: [{ word: " deep.", start: 1.28, end: 2.5 }, { word: " ", start: 2, end: 2 }, { word: "x", start: "?", end: 1 }] },
      ],
    };
    expect(parseWhisperWords(out, 1.944)).toEqual([
      { word: "Still", start: 0, end: 0.5 },
      { word: "water", start: 0.5, end: 0.88 },
      { word: "deep.", start: 1.28, end: 1.944 },
    ]);
  });
  it("is empty for anything else", () => {
    expect(parseWhisperWords(null, 1)).toEqual([]);
    expect(parseWhisperWords({ words: [{ word: "a", start: 0, end: 1 }] }, 1)).toEqual([]);
  });
});

describe("notes → steps", () => {
  it("a single-quoted string: one even step per token, ~ rests", () => {
    const steps = noteSource("c4 ~ e4 67", midiOf)(0);
    expect(steps).toEqual([
      { begin: 0, end: 0.25, midi: 60 },
      { begin: 0.5, end: 0.75, midi: 64 },
      { begin: 0.75, end: 1, midi: 67 },
    ]);
    expect(noteSource(["c", "eb3"], midiOf)(2).map((x) => x.midi)).toEqual([48, 51]);
  });

  it("a double-quoted string arrives as a mini-notation pattern: its onsets are the steps", () => {
    const steps = noteSource(mini("c4 [d4 e4] ~ g4"), midiOf)(1);
    expect(steps.map((x) => [x.begin, x.midi])).toEqual([[1, 60], [1.25, 62], [1.375, 64], [1.75, 67]]);
    // Single-quoted mini-notation is parsed when the page can.
    expect(noteSource("<c4 e4>", midiOf, (v) => mini(v as string))(1).map((x) => x.midi)).toEqual([64]);
  });

  it("refuses what it can't read, at the call", () => {
    expect(() => noteSource("c4 h9", midiOf)).toThrow(/"h9" is not a note/);
    expect(() => noteSource("", midiOf)).toThrow(/needs notes/);
    expect(() => noteSource("~ ~", midiOf)).toThrow(/all rests/);
    expect(() => noteSource(mini("~"), midiOf)).toThrow(/no notes/);
  });

  it("word i on onset i; the phrase is whole cycles; leftover notes rest", () => {
    const src = noteSource("c4 d4 e4 g4", midiOf);
    expect(layoutWords(4, src).cycles).toBe(1);
    const five = layoutWords(5, src);
    expect(five.cycles).toBe(2);
    expect(five.placed.map((p) => [p.index, p.begin, p.midi])).toEqual([
      [0, 0, 60], [1, 0.25, 62], [2, 0.5, 64], [3, 0.75, 67], [4, 1, 60],
    ]);
    expect(layoutWords(3, src)).toMatchObject({ cycles: 1, placed: [{ index: 0 }, { index: 1 }, { index: 2 }] });
  });
});

describe("wordSpeeds", () => {
  it("target ÷ spoken; an unvoiced word borrows the previous pitch (the median if first)", () => {
    const { speeds, clamped } = wordSpeeds([null, 200, null, 100], [69, 69, 69, 57]);
    expect(clamped).toBe(0);
    expect(speeds[0]).toBeCloseTo(440 / 200); // median of [100, 200] → upper middle = 200
    expect(speeds[1]).toBeCloseTo(440 / 200);
    expect(speeds[2]).toBeCloseTo(440 / 200);
    expect(speeds[3]).toBeCloseTo(midiToHz(57) / 100);
  });
  it("clamps to two octaves and plays as spoken when nothing is voiced", () => {
    expect(wordSpeeds([50], [100])).toEqual({ speeds: [SING_MAX_SPEED], clamped: 1 });
    expect(wordSpeeds([400, 400], [24, 69])).toEqual({ speeds: [0.25, 1.1], clamped: 1 });
    expect(wordSpeeds([null, null], [60, 62])).toEqual({ speeds: [1, 1], clamped: 0 });
  });
});

describe("octave: 'auto' — notes moved by at most one octave to the voice", () => {
  const hz = (midi: number) => midiToHz(midi);
  it("picks the shift in {−1, 0, +1} that brings the notes' median closest to the voice", () => {
    const melody = [60, 64, 67, 72]; // c4 e4 g4 c5, median 65.5
    expect(autoOctave(melody, 121)).toBe(-1); // orion (~46.7): c3–c4, not two octaves down
    expect(autoOctave(melody, 102)).toBe(-1);
    expect(autoOctave(melody, 250)).toBe(-1); // ~b3 (59.2): 53.5 is 5.7 away, 65.5 is 6.3
    expect(autoOctave(melody, 262)).toBe(0); // c4 (60): 5.5 away
    expect(autoOctave([48, 52, 55], hz(64))).toBe(1); // c3 e3 g3 for a voice at e4
  });
  it("never moves more than one octave; ties stay where written", () => {
    for (let voice = 24; voice <= 96; voice += 0.5) {
      const k = autoOctave([60, 62, 64, 65, 67], hz(voice));
      expect(Math.abs(k)).toBeLessThanOrEqual(1);
      // The closest of the three, unless the 80 Hz floor stepped in (lowest note 60 never needs it).
      const d = (s: number) => Math.abs(64 + 12 * s - voice);
      expect(d(k)).toBeLessThanOrEqual(Math.min(d(-1), d(0), d(1)) + 1e-9);
    }
    expect(autoOctave([60], hz(54))).toBe(0);
    expect(autoOctave([60], hz(66))).toBe(0);
    expect(autoOctave([127], 60)).toBe(-1);
  });
  it("never puts the lowest note under 80 Hz when a higher shift avoids it", () => {
    // Lowest g#2 (104 Hz): one octave down is 52 Hz, so it stays.
    expect(autoOctave([44, 60, 62], 70)).toBe(0);
    // Lowest c2 (65 Hz) is already under: +1 (131 Hz) wins over a closer 0.
    expect(autoOctave([36, 40, 43], 70)).toBe(1);
    // Everything far below the floor and nothing better: the floor can't help.
    expect(autoOctave([12, 14], 40)).toBe(1);
  });
  it("leaves the notes alone with nothing to go on", () => {
    expect(autoOctave([60, 64], null)).toBe(0);
    expect(autoOctave([], 200)).toBe(0);
  });
  it("the speaking pitch is the median of the voiced words", () => {
    expect(spokenMedianHz([200, null, 100, 150])).toBe(150);
    expect(spokenMedianHz([null])).toBeNull();
  });
  it("tells the model what each line became, and when words are at the speed limit", () => {
    expect(describeSung([])).toBe("");
    const note = describeSung([
      { line: "still water runs deep", voice: "orion", ready: true, octave: -1, auto: true, spokenHz: 131.4, words: 4, clamped: 0 },
      { line: "low", voice: "luna", ready: true, octave: 0, auto: false, spokenHz: 200, words: 1, clamped: 1 },
      { line: "later", voice: "luna", ready: false },
    ]);
    expect(note).toBe(
      "sing: 'still water runs deep': octave -1 (auto), orion speaks near 131 Hz; " +
        "'low': octave 0, luna speaks near 200 Hz; 1 of 1 words at the speed limit (more than two octaves from the voice) — they play off their note: write the notes nearer the voice; " +
        "'later' still loading",
    );
  });
});

describe("buildPhrase", () => {
  it("one Strudel pattern: each word's slice at its note, silence between", () => {
    const layout = layoutWords(3, noteSource("c4 ~ e4 g4", midiOf));
    const phrase = buildPhrase(kit, "say_x", layout, (p) => ({ begin: p.index / 3, end: (p.index + 1) / 3, speed: 1 + p.index }));
    const haps = phrase.queryArc(0, 1);
    expect(haps.map((h: any) => [Number(h.whole.begin), Number(h.whole.end)])).toEqual([[0, 0.25], [0.5, 0.75], [0.75, 1]]);
    expect(haps[2].value).toEqual({ s: "say_x", begin: 2 / 3, end: 1, speed: 3 });
  });
  it("a two-cycle phrase is slowed to two cycles", () => {
    const layout = layoutWords(5, noteSource("c4 d4 e4 g4", midiOf));
    const phrase = buildPhrase(kit, "say_x", layout, () => ({ begin: 0, end: 1, speed: 1 }));
    expect(phrase.queryArc(0, 2).map((h: any) => Number(h.whole.begin))).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(phrase.queryArc(2, 3)).toHaveLength(4);
  });
});

describe("sing() in the stage runtime", () => {
  const ORIGIN = "https://music-studio.linxule.com";
  /** A fake clip: four words, each a steady tone. */
  function clip(): SungClip {
    const rate = 24_000;
    const pitches = [200, 150, 250, 180];
    const channel = new Float32Array(rate * 2);
    pitches.forEach((hz, w) => {
      for (let i = Math.round((w * 0.5 + 0.05) * rate); i < Math.round((w * 0.5 + 0.45) * rate); i++) {
        channel[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / rate);
      }
    });
    const words = ["still", "water", "runs", "deep"].map((word, w) => ({ word, start: w * 0.5, end: w * 0.5 + 0.5 }));
    return { words, channel, sampleRate: rate, duration: 2 };
  }

  function sung(load: () => Promise<SungClip> = async () => clip()) {
    const errors: Array<[string, unknown]> = [];
    const loads: string[] = [];
    const followUps: SungReport[] = [];
    const env: StageEnv = {
      observeSung: (report) => void followUps.push(report),
      audibleCycle: () => 0,
      isPlaying: () => true,
      requestFrame: () => 1,
      cancelFrame: () => undefined,
      listenTaps: () => () => undefined,
      reportError: (api, err) => void errors.push([api, err]),
      ttsOrigin: ORIGIN,
      sound: (name) => s(name),
      loadSung: (request) => {
        loads.push(`${request.voice}:${request.text}`);
        return load();
      },
      lazyPattern: (get) => new Pattern((state: any) => ((get() as any)?.query(state) ?? [])),
      timecat: (...pairs) => stepcat(...pairs),
    };
    return { stage: createStage(env), errors, loads, followUps };
  }

  it("reports a line again once measured, when the evaluation's report saw it still loading (2026-10-04 field test)", async () => {
    const { stage, followUps } = sung();
    let token = stage.begin();
    stage.globals.sing("still water runs deep", "c4 e4 g4 c5");
    stage.commit(token);
    // The app reports the evaluation before the words arrive (a swap into a running piece).
    expect(stage.sung({ noted: true })[0].ready).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(followUps).toHaveLength(1);
    expect(followUps[0]).toMatchObject({ line: "still water runs deep", ready: true, octave: -1, auto: true, words: 4 });
    // Measured before anyone reported it: the evaluation's own report covers it.
    token = stage.begin();
    stage.globals.sing("the sea is slow", "a3 c4 a3 f3");
    stage.commit(token);
    await new Promise((r) => setTimeout(r, 0));
    expect(stage.sung({ noted: true })).toEqual([expect.objectContaining({ line: "the sea is slow", ready: true })]);
    expect(followUps).toHaveLength(1);
    // Cached line: ready at the call, nothing to follow up.
    token = stage.begin();
    stage.globals.sing("the sea is slow", "a3 c4 a3 f3");
    stage.commit(token);
    stage.sung({ noted: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(followUps).toHaveLength(1);
    // A rolled-back evaluation's line is never followed up.
    stage.begin();
    stage.globals.sing("gone", "c4");
    stage.rollback();
    await new Promise((r) => setTimeout(r, 0));
    expect(followUps).toHaveLength(1);
  });

  it("is silent until the words arrive, then plays each word in tune on its note", async () => {
    const { stage, loads } = sung();
    const pattern = stage.globals.sing("still water runs deep", "c4 e4 g4 c5", { octave: 0 }) as any;
    expect(pattern.queryArc(0, 1)).toEqual([]);
    await new Promise((r) => setTimeout(r, 0));
    const haps = pattern.queryArc(0, 1);
    expect(haps.map((h: any) => Number(h.whole.begin))).toEqual([0, 0.25, 0.5, 0.75]);
    const name = ttsSampleName({ text: "still water runs deep", voice: "luna" });
    for (const [i, [target, spoken]] of [[60, 200], [64, 150], [67, 250], [72, 180]].entries()) {
      const v = haps[i].value;
      expect(v.s).toBe(name);
      expect(v.speed).toBeCloseTo(midiToHz(target) / spoken, 1);
      // Start snapped to the tone (50 ms after the word's ASR start).
      expect(v.begin).toBeCloseTo((i * 0.5 + 0.05) / 2, 2);
      // End pulled back over the trailing silence (the tone stops at +0.45 s).
      expect(v.end).toBeCloseTo((i * 0.5 + 0.45) / 2, 2);
    }
    // Chainable like any pattern.
    expect(pattern.slow(2).queryArc(0, 1)).toHaveLength(2);
    expect(loads).toEqual(["luna:still water runs deep"]);
  });

  it("loads and measures a line once across evaluations; octave shifts the notes", async () => {
    const { stage, loads } = sung();
    stage.globals.sing("still water runs deep", "c4 e4 g4 c5");
    await new Promise((r) => setTimeout(r, 0));
    const low = stage.globals.sing("still water runs deep", "c4 e4 g4 c5", { octave: -1 }) as any;
    // Already measured: plays at once.
    expect(low.queryArc(0, 1)[0].value.speed).toBeCloseTo(midiToHz(48) / 200, 1);
    expect(loads).toHaveLength(1);
  });

  it("octave 'auto' (the default) moves the melody to the voice and reports it per evaluation", async () => {
    const { stage } = sung();
    // The fake voice speaks at 150–250 Hz (median 190 Hz ≈ f#3); c4 e4 g4 c5 sits an octave above.
    const token = stage.begin();
    const pattern = stage.globals.sing("still water runs deep", "c4 e4 g4 c5") as any;
    stage.commit(token);
    expect(stage.sung()).toEqual([{ line: "still water runs deep", voice: "luna", ready: false }]);
    await new Promise((r) => setTimeout(r, 0));
    const haps = pattern.queryArc(0, 1);
    expect(haps[0].value.speed).toBeCloseTo(midiToHz(48) / 200, 1);
    expect(haps[3].value.speed).toBeCloseTo(midiToHz(60) / 180, 1);
    expect(stage.sung()).toEqual([
      { line: "still water runs deep", voice: "luna", ready: true, octave: -1, auto: true, spokenHz: expect.any(Number), words: 4, clamped: 0 },
    ]);
    expect(stage.sung()[0].spokenHz).toBeCloseTo(190, -1);
    // A failed evaluation keeps the committed report; a new one replaces it.
    stage.begin();
    stage.globals.sing("other", "c4");
    stage.rollback();
    expect(stage.sung()).toHaveLength(1);
    expect(stage.sung()[0].line).toBe("still water runs deep");
  });

  it("counts words at the speed limit", async () => {
    const { stage } = sung();
    const token = stage.begin();
    stage.globals.sing("still water runs deep", "c7 c7 c7 c7", { octave: 0 });
    stage.commit(token);
    await new Promise((r) => setTimeout(r, 0));
    expect(stage.sung()[0]).toMatchObject({ octave: 0, auto: false, clamped: 4, words: 4 });
  });

  it("a failed load is forgotten, so the next evaluation retries", async () => {
    let fail = true;
    const { stage, loads } = sung(async () => {
      if (fail) throw new Error("HTTP 429");
      return clip();
    });
    const first = stage.globals.sing("still water runs deep", "c4") as any;
    await new Promise((r) => setTimeout(r, 0));
    expect(first.queryArc(0, 1)).toEqual([]);
    fail = false;
    const second = stage.globals.sing("still water runs deep", "c4") as any;
    await new Promise((r) => setTimeout(r, 0));
    expect(second.queryArc(0, 1)).toHaveLength(1);
    expect(loads).toHaveLength(2);
  });

  it("fails loud at the call on what it can't sing", () => {
    const { stage } = sung();
    expect(() => stage.globals.sing("", "c4")).toThrow(/sing\(\) needs some words/);
    expect(() => stage.globals.sing("hi", "c4", { voice: "morgan" })).toThrow(/not one of/);
    expect(() => stage.globals.sing("hi", "q4")).toThrow(/not a note/);
    expect(() => stage.globals.sing("hi", "c4", { octave: 3 })).toThrow(/octave/);
    expect(() => stage.globals.sing("hi", "c4", { octave: "high" as never })).toThrow(/'auto' or a whole number/);
    const bare = createStage({ ...({} as StageEnv), reportError: () => undefined });
    expect(() => bare.globals.sing("hi", "c4")).toThrow(/not available/);
  });
});

describe("plumbing", () => {
  it("the words URL is the clip URL plus words=1", () => {
    expect(ttsWordsUrl("https://x.test/", { text: "a b", voice: "luna" })).toBe("https://x.test/tts?voice=luna&text=a+b&words=1");
  });
  it("transcription is charged ≈ 17.1 characters per minute, rounded up, at least 1", () => {
    expect(asrChars(0)).toBe(1);
    expect(asrChars(2)).toBe(1);
    expect(asrChars(60)).toBe(18);
    expect(asrChars(120)).toBe(35);
  });
});
