/**
 * @file The highlight timer follows abcjs's swung audio (#34).
 *
 * These tests run abcjs's OWN `addSwing()`. It is private to
 * synth/create-synth.js and needs an AudioContext to reach through `prime()`,
 * so the test lifts its source text out of the installed file and evaluates
 * it. A future abcjs that changes its swing rule changes these inputs too.
 * The widget reads the same result at runtime through the public
 * `sequenceCallback` option, so it never carries a copy of the rule.
 *
 * The timer events are synthesised from the straight note map, merging all
 * voices per instant as `tune.setTiming()` does. The real `setTiming()` needs
 * an engraved SVG. The browser harness covers that end to end (see the
 * report for #34).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ABCJS from "abcjs";
import createNoteMap from "abcjs/src/synth/create-note-map.js";
import {
  alignTimerWithSwing,
  applySwingToTimings,
  swingDelaysByChar,
  type NoteMapNote,
  type TimingEventLike,
} from "../src/swing-timing";

type AddSwing = (
  tracks: NoteMapNote[][],
  swing: number,
  meterFraction: { num: number; den: number },
  pickupLength: number,
) => void;

/** abcjs's private addSwing, evaluated from the installed source. */
function loadAbcjsAddSwing(): AddSwing {
  const file = createRequire(import.meta.url).resolve("abcjs/src/synth/create-synth.js");
  const source = readFileSync(file, "utf8");
  const start = source.indexOf("function addSwing(");
  expect(start).toBeGreaterThan(0);
  // Walk braces from the function's opening one to its matching close.
  let depth = 0;
  let end = source.indexOf("{", start);
  for (let i = end; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  return new Function(`${source.slice(start, end)}; return addSwing;`)() as AddSwing;
}

const addSwing = loadAbcjsAddSwing();

interface Primed {
  flattened: { tracks: { cmd: string; start?: number; duration?: number; startChar?: number }[][] };
  swung: NoteMapNote[][];
  timings: TimingEventLike[];
  msPerWholeNote: number;
}

/**
 * What CreateSynth.init() + prime() compute, minus the audio. The timer
 * events are straight and merged across tracks, as `setTiming()` merges voices.
 */
function prime(abc: string, options: { swing: number; drumIntro?: number }): Primed {
  const tune = ABCJS.parseOnly(abc)[0]!;
  const t = tune as unknown as {
    setUpAudio(o: object): Primed["flattened"];
    getMeterFraction(): { num: number; den: number };
    getPickupLength(): number;
    millisecondsPerMeasure(): number;
  };
  const flattened = t.setUpAudio(options);
  const noteMap = createNoteMap(flattened) as NoteMapNote[][];
  const swung = structuredClone(noteMap);
  addSwing(swung, options.swing, t.getMeterFraction(), options.drumIntro ? 0 : t.getPickupLength());
  const meter = t.getMeterFraction();
  const msPerWholeNote = t.millisecondsPerMeasure() / (meter.num / meter.den);

  const byTime = new Map<number, number[]>();
  for (const track of noteMap) {
    for (const note of track) {
      if (typeof note.startChar !== "number") continue;
      const chars = byTime.get(note.start) ?? [];
      if (!chars.includes(note.startChar)) chars.push(note.startChar);
      byTime.set(note.start, chars);
    }
  }
  const timings: TimingEventLike[] = [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, chars]) => ({ type: "event", milliseconds: start * msPerWholeNote, startCharArray: chars }));
  const last = Math.max(...noteMap.flat().map((n) => (n as unknown as { end: number }).end));
  timings.push({ type: "end", milliseconds: last * msPerWholeNote });
  return { flattened, swung, timings, msPerWholeNote };
}

/** Where abcjs's audio actually places each timer event's first note. */
function swungTimes(primed: Primed): number[] {
  const byChar = new Map<number, number[]>();
  for (const track of primed.swung) {
    for (const note of track) {
      if (typeof note.startChar !== "number") continue;
      const list = byChar.get(note.startChar) ?? [];
      if (!list.some((s) => Math.abs(s - note.start) < 1e-9)) list.push(note.start);
      byChar.set(note.startChar, list.sort((a, b) => a - b));
    }
  }
  const seen = new Map<number, number>();
  return primed.timings
    .filter((e) => e.type === "event")
    .map((e) => {
      const starts = e.startCharArray!.map((c) => {
        const i = seen.get(c!) ?? 0;
        seen.set(c!, i + 1);
        return byChar.get(c!)![i]!;
      });
      return Math.max(...starts) * primed.msPerWholeNote;
    });
}

function align(primed: Primed): number {
  return alignTimerWithSwing({
    timings: primed.timings,
    flattenedTracks: primed.flattened.tracks,
    swungTracks: primed.swung,
    millisecondsPerMeasure: primed.msPerWholeNote, // meterSize 1 below
    meterSize: 1,
  });
}

const eventTimes = (timings: TimingEventLike[]) =>
  timings.filter((e) => e.type === "event").map((e) => Math.round(e.milliseconds * 1000) / 1000);

const EIGHTHS_44 = `X:1
M:4/4
L:1/8
Q:1/4=120
K:C
CDEF GABc | cBAG FEDC |
`;

describe("the swing delay abcjs applies (measured, not assumed)", () => {
  it("delays each swung off-beat by 16% of a beat at swing 66 — 80 ms at ♩=120", () => {
    const primed = prime(EIGHTHS_44, { swing: 66 });
    const before = eventTimes(primed.timings);
    expect(before.slice(0, 4)).toEqual([0, 250, 500, 750]);
    const moved = align(primed);
    expect(moved).toBe(8); // every off-beat of the two bars
    const after = eventTimes(primed.timings);
    expect(after.slice(0, 4)).toEqual([0, 330, 500, 830]);
  });

  it("lands every event exactly where abcjs's audio puts its note", () => {
    const primed = prime(EIGHTHS_44, { swing: 66 });
    const expected = swungTimes(primed).map((ms) => Math.round(ms * 1000) / 1000);
    align(primed);
    expect(eventTimes(primed.timings)).toEqual(expected);
  });

  it("does nothing for straight playback", () => {
    const primed = prime(EIGHTHS_44, { swing: 50 });
    const before = eventTimes(primed.timings);
    expect(align(primed)).toBe(0);
    expect(eventTimes(primed.timings)).toEqual(before);
  });
});

/** Corpus: each case asserts timer == abcjs audio after alignment. */
const CASES: Record<string, { abc: string; swing: number; drumIntro?: number; expectMoved: boolean }> = {
  "swing 75 (maximum)": { abc: EIGHTHS_44, swing: 75, expectMoved: true },
  "swing above 75 clamps like abcjs": { abc: EIGHTHS_44, swing: 90, expectMoved: true },
  "6/8 swings sixteenths": {
    abc: "X:1\nM:6/8\nL:1/16\nQ:3/8=60\nK:C\nCDEFGA BcdefG | CDEFGA BcdefG |\n",
    swing: 66,
    expectMoved: true,
  },
  "6/8 eighths do not swing": {
    abc: "X:1\nM:6/8\nL:1/8\nQ:3/8=60\nK:C\nCDE FGA | Bcd efg |\n",
    swing: 66,
    expectMoved: false,
  },
  "3/2 is never swung": { abc: "X:1\nM:3/2\nL:1/8\nK:C\nCDEFGABcdefg|\n", swing: 66, expectMoved: false },
  "chords on the off-beat are not swung by abcjs": {
    abc: "X:1\nM:4/4\nL:1/8\nQ:1/4=120\nK:C\nC[EG] C[EG] C[EG] C[EG] |\n",
    swing: 66,
    expectMoved: false,
  },
  "dotted rhythms have no half-beat to swing": {
    abc: "X:1\nM:4/4\nL:1/8\nQ:1/4=120\nK:C\nC>D E>F G>A B>c |\n",
    swing: 66,
    expectMoved: false,
  },
  "an eighth pickup is offset like abcjs does": {
    abc: "X:1\nM:4/4\nL:1/8\nQ:1/4=120\nK:C\nG | CDEF GABc | cBAG FEDC |\n",
    swing: 66,
    expectMoved: true,
  },
  "a drum intro shifts nothing but the start": {
    abc: EIGHTHS_44,
    swing: 66,
    drumIntro: 2,
    expectMoved: true,
  },
  "repeats pair the right occurrence": {
    abc: "X:1\nM:4/4\nL:1/8\nQ:1/4=100\nK:C\n|: CDEF GABc :| c2 B2 A2 G2 |\n",
    swing: 66,
    expectMoved: true,
  },
  "rests and ties keep their straight time": {
    abc: "X:1\nM:4/4\nL:1/8\nQ:1/4=120\nK:C\nCz Ez G2- GA | B2 zc d4 |\n",
    swing: 66,
    expectMoved: true,
  },
  "two voices, only the moving one swings": {
    abc: "X:1\nM:4/4\nL:1/8\nQ:1/4=120\nK:C\nV:1\nCDEF GABc |\nV:2 clef=bass\nC,2 E,2 G,2 C2 |\n",
    swing: 66,
    expectMoved: true,
  },
  "a triplet is left alone": {
    abc: "X:1\nM:4/4\nL:1/8\nQ:1/4=120\nK:C\n(3CDE (3FGA B2 c2 |\n",
    swing: 66,
    expectMoved: false,
  },
  // abcjs's trill pieces carry no startChar, so they have no delay to apply;
  // the plain notes around them still line up exactly.
  "trilled notes are left alone, their neighbours still swing": {
    abc: "X:1\nM:4/4\nL:1/8\nQ:1/4=120\nK:C\nC TD E TF GABc |\n",
    swing: 66,
    expectMoved: true,
  },
};

describe("timer events land where abcjs's audio does", () => {
  it.each(Object.entries(CASES))("%s", (_name, { abc, swing, drumIntro, expectMoved }) => {
    const primed = prime(abc, { swing, drumIntro });
    const expected = swungTimes(primed).map((ms) => Math.round(ms * 1000) / 1000);
    const moved = align(primed);
    expect(moved > 0).toBe(expectMoved);
    expect(eventTimes(primed.timings)).toEqual(expected);
    // Still sorted, and the closing event is untouched.
    const all = primed.timings.map((e) => e.milliseconds);
    expect(all).toEqual([...all].sort((a, b) => a - b));
    expect(primed.timings.at(-1)!.type).toBe("end");
  });
});

describe("applySwingToTimings mechanics", () => {
  it("skips a character whose note and timer occurrences disagree", () => {
    const timings: TimingEventLike[] = [
      { type: "event", milliseconds: 0, startCharArray: [10] },
      { type: "event", milliseconds: 250, startCharArray: [11] },
      { type: "event", milliseconds: 1000, startCharArray: [11] }, // timer says twice
    ];
    const delays = new Map([[11, [0.04]]]); // audio says once
    expect(applySwingToTimings(timings, delays, 2000)).toBe(0);
    expect(timings.map((e) => e.milliseconds)).toEqual([0, 250, 1000]);
  });

  it("re-sorts when a moved event passes another, bar before note on a tie", () => {
    const timings: TimingEventLike[] = [
      { type: "event", milliseconds: 250, startCharArray: [1] },
      { type: "event", milliseconds: 300, startCharArray: [2] },
      { type: "bar", milliseconds: 330 },
      { type: "end", milliseconds: 2000 },
    ];
    applySwingToTimings(timings, new Map([[1, [0.04]], [2, [0]]]), 2000);
    expect(timings.map((e) => [e.type, e.milliseconds])).toEqual([
      ["event", 300],
      ["bar", 330],
      ["event", 330],
      ["end", 2000],
    ]);
  });

  it("ignores bar and end events and characterless entries", () => {
    const timings: TimingEventLike[] = [
      { type: "bar", milliseconds: 0, startCharArray: [5] },
      { type: "event", milliseconds: 250, startCharArray: [null, 5] },
      { type: "end", milliseconds: 1000 },
    ];
    expect(applySwingToTimings(timings, new Map([[5, [0.04]]]), 2000)).toBe(1);
    expect(timings[1]!.milliseconds).toBe(330);
    expect(timings[0]!.milliseconds).toBe(0);
  });

  it("refuses a nonsensical tempo instead of moving anything", () => {
    const timings: TimingEventLike[] = [{ type: "event", milliseconds: 250, startCharArray: [1] }];
    expect(applySwingToTimings(timings, new Map([[1, [0.04]]]), 0)).toBe(0);
    expect(applySwingToTimings(timings, new Map([[1, [0.04]]]), Number.NaN)).toBe(0);
  });

  it("swingDelaysByChar skips a track whose note counts disagree", () => {
    const flat = [[{ cmd: "note", start: 0.125, duration: 0.125, startChar: 3 }]];
    expect(swingDelaysByChar(flat, [[]]).size).toBe(0);
    expect(swingDelaysByChar(flat, [[{ start: 0.165, startChar: 3 }]]).get(3)![0]).toBeCloseTo(0.04);
  });

  it("converts with the synth's own measure length and meter size", () => {
    // 6/8 at 1000 ms per measure: meterSize 0.75, so 1333.3 ms per whole note.
    const timings: TimingEventLike[] = [{ type: "event", milliseconds: 83.333, startCharArray: [1] }];
    alignTimerWithSwing({
      timings,
      flattenedTracks: [[{ cmd: "note", start: 0.0625, duration: 0.0625, startChar: 1 }]],
      swungTracks: [[{ start: 0.0625 + 0.02, startChar: 1 }]],
      millisecondsPerMeasure: 1000,
      meterSize: 0.75,
    });
    expect(timings[0]!.milliseconds).toBeCloseTo(83.333 + 0.02 * (1000 / 0.75), 3);
  });
});

// The tests above prove the alignment; these pin that the widget still runs
// it (Codex review of #34: deleting the hookup from src/mcp-app.ts left every
// test green while bringing the early highlight back).
describe("the sheet widget wires the swing capture into its timer", () => {
  const widget = readFileSync(new URL("../src/mcp-app.ts", import.meta.url), "utf8");

  it("captures abcjs's swung note map whenever swing is set", () => {
    expect(widget).toMatch(
      /if \(typeof options\.swing === "number"\) \{\s*options\.sequenceCallback = captureSwungNoteMap;/,
    );
  });

  it("shifts the timer from onReady, which go() calls after every prime", () => {
    expect(widget).toMatch(/onReady\(controller\?: unknown\) \{\s*followSwing\(controller\);/);
    expect(widget).toMatch(/alignTimerWithSwing\(\{/);
  });

  it("keeps the capture out of the MIDI writer", () => {
    expect(widget).toContain("sequenceCallback: _sequenceCallback,");
  });
});
