// Practice mode's pure half (src/score-practice.ts): voice numbering as abcjs's
// sequencer counts it, the mute state behind `voicesOff`, and the timeline
// range a selection loops over. The browser half is scripts/verify-score-click.mjs.
import ABCJS from "abcjs";
import { describe, expect, it } from "vitest";
import {
  VoiceMutes,
  loopRange,
  loopWrapTarget,
  tuneVoices,
  type TimingEventLike,
  type TuneLineLike,
} from "../src/score-practice";

const TWO_VOICES = `X:1
T:Two
M:4/4
L:1/8
K:C
V:1 clef=treble name="Right hand"
V:2 clef=bass
[V:1] c2 e2 g2 e2 | f2 a2 g2 f2 |]
[V:2] C,2 G,2 E,2 G,2 | F,2 C2 G,2 B,2 |]`;

/** The voice of the note whose span (abcjs counts the space before it) covers `text`. */
function voiceAt(voiceOf: Map<number, number>, text: string): number | undefined {
  const at = TWO_VOICES.indexOf(text);
  const start = Math.max(...[...voiceOf.keys()].filter((c) => c <= at));
  return voiceOf.get(start);
}

describe("tuneVoices", () => {
  it("numbers voices as abcjs's sequencer does and names them", () => {
    const tune = ABCJS.parseOnly(TWO_VOICES)[0];
    const { voiceOf, names } = tuneVoices(tune.lines as unknown as TuneLineLike[]);
    expect(names).toEqual(["Right hand", "Voice 2"]);
    expect(voiceAt(voiceOf, "c2 e2")).toBe(0);
    expect(voiceAt(voiceOf, "C,2 G,2")).toBe(1);
  });

  it("is the numbering voicesOff mutes: the flattener silences exactly that voice", () => {
    const tune = ABCJS.parseOnly(TWO_VOICES)[0];
    const { voiceOf } = tuneVoices(tune.lines as unknown as TuneLineLike[]);
    const bass = voiceAt(voiceOf, "C,2 G,2");
    expect(bass).toBe(1);
    const flat = tune.setUpAudio({ voicesOff: [bass!] }) as unknown as {
      tracks: Array<Array<{ cmd: string; pitch?: number; volume?: number }>>;
    };
    const volumes = flat.tracks.map((track) =>
      track.filter((e) => e.cmd === "note").map((e) => e.volume ?? 0),
    );
    expect(volumes[0].every((v) => v > 0)).toBe(true);
    expect(volumes[1].length).toBeGreaterThan(0);
    expect(volumes[1].every((v) => v === 0)).toBe(true);
  });

  it("a single-voice tune has one voice", () => {
    const tune = ABCJS.parseOnly("X:1\nK:C\nCDEF|]")[0];
    expect(tuneVoices(tune.lines as unknown as TuneLineLike[]).names).toEqual(["Voice 1"]);
  });
});

describe("VoiceMutes", () => {
  it("toggles, reports voicesOff sorted, undefined when all play", () => {
    const mutes = new VoiceMutes();
    mutes.setVoiceCount(3);
    expect(mutes.voicesOff()).toBeUndefined();
    mutes.toggle(2);
    mutes.toggle(0);
    expect(mutes.voicesOff()).toEqual([0, 2]);
    mutes.toggle(2);
    expect(mutes.voicesOff()).toEqual([0]);
    expect(mutes.isMuted(0)).toBe(true);
  });

  it("ignores voices the score doesn't have; a new voice count starts unmuted", () => {
    const mutes = new VoiceMutes();
    mutes.setVoiceCount(2);
    mutes.toggle(5);
    expect(mutes.voicesOff()).toBeUndefined();
    mutes.toggle(1);
    mutes.setVoiceCount(2); // an edit that kept the voices
    expect(mutes.voicesOff()).toEqual([1]);
    mutes.setVoiceCount(3);
    expect(mutes.voicesOff()).toBeUndefined();
  });
});

/** An abcjs timing event: notes starting at `ms`, as [startChar, endChar, voice]. */
type Note = [number, number, number];
function events(list: Array<[number, Note[]]>, endMs: number) {
  const voiceOf = new Map<number, number>();
  const timeline: TimingEventLike[] = list.map(([ms, notes]) => {
    for (const [start, , voice] of notes) voiceOf.set(start, voice);
    return {
      type: "event",
      milliseconds: ms,
      startCharArray: notes.map((n) => n[0]),
      endCharArray: notes.map((n) => n[1]),
    };
  });
  timeline.push({ type: "end", milliseconds: endMs });
  return { timeline, voiceOf };
}

describe("loopRange", () => {
  // One voice, four quarter notes at 0/500/1000/1500, chars 10,13,16,19.
  const melody = events(
    [
      [0, [[10, 13, 0]]],
      [500, [[13, 16, 0]]],
      [1000, [[16, 19, 0]]],
      [1500, [[19, 22, 0]]],
    ],
    2000,
  );

  it("runs from the first selected note to where the next one begins", () => {
    expect(loopRange(melody.timeline, { from: 13, to: 18 }, melody.voiceOf)).toEqual({ startMs: 500, endMs: 1500 });
  });

  it("a selection touching part of a note's text selects the note", () => {
    expect(loopRange(melody.timeline, { from: 14, to: 15 }, melody.voiceOf)).toEqual({ startMs: 500, endMs: 1000 });
  });

  it("through the last note ends at the tune's end", () => {
    expect(loopRange(melody.timeline, { from: 16, to: 22 }, melody.voiceOf)).toEqual({ startMs: 1000, endMs: 2000 });
  });

  it("nothing selected, or no note in it, is no loop", () => {
    expect(loopRange(melody.timeline, { from: 13, to: 13 }, melody.voiceOf)).toBeNull();
    expect(loopRange(melody.timeline, { from: 0, to: 9 }, melody.voiceOf)).toBeNull();
  });

  it("a held note ends where its OWN voice moves, not where another voice does", () => {
    // Voice 0 holds a half note (chars 10–13) while voice 1 plays two quarters.
    const held = events(
      [
        [0, [[10, 13, 0], [40, 43, 1]]],
        [500, [[43, 46, 1]]],
        [1000, [[13, 16, 0], [46, 49, 1]]],
      ],
      1500,
    );
    expect(loopRange(held.timeline, { from: 10, to: 13 }, held.voiceOf)).toEqual({ startMs: 0, endMs: 1000 });
  });

  it("a selection inside a repeat loops the first pass only", () => {
    // |: a b :| c — the repeat plays chars 10 and 13 twice.
    const repeat = events(
      [
        [0, [[10, 12, 0]]],
        [500, [[13, 15, 0]]],
        [1000, [[10, 12, 0]]],
        [1500, [[13, 15, 0]]],
        [2000, [[18, 20, 0]]],
      ],
      2500,
    );
    expect(loopRange(repeat.timeline, { from: 10, to: 15 }, repeat.voiceOf)).toEqual({ startMs: 0, endMs: 1000 });
  });

  it("selected notes in two voices loop until both have ended", () => {
    // Voice 0 is written at chars 10–19, voice 1 at 20–25 (its own line).
    const two = events(
      [
        [0, [[10, 13, 0], [20, 23, 1]]],
        [500, [[13, 16, 0]]],
        [1000, [[16, 19, 0], [23, 26, 1]]],
      ],
      1500,
    );
    // Voice 1's half note alone: it ends at 1000, though voice 0 moves at 500.
    expect(loopRange(two.timeline, { from: 20, to: 23 }, two.voiceOf)).toEqual({ startMs: 0, endMs: 1000 });
    // Voice 0's last two notes and voice 1's first: from 0 until voice 0 ends.
    expect(loopRange(two.timeline, { from: 13, to: 23 }, two.voiceOf)).toEqual({ startMs: 0, endMs: 1500 });
  });
});

describe("loopRange — a note whose voice is unknown (Kimi review)", () => {
  // Voice 0 holds a half note (chars 10, unknown to voiceOf) while voice 1
  // moves in quarters at 0/500/1000. 4/4 at 2000 ms per measure: a half is 1000 ms.
  const timeline: TimingEventLike[] = [
    {
      type: "event",
      milliseconds: 0,
      millisecondsPerMeasure: 2000,
      startCharArray: [10, 20],
      endCharArray: [12, 22],
      midiPitches: [{ startChar: 10, duration: 0.5 }, { startChar: 20, duration: 0.25 }],
    },
    { type: "event", milliseconds: 500, millisecondsPerMeasure: 2000, startCharArray: [23], endCharArray: [25], midiPitches: [{ startChar: 23, duration: 0.25 }] },
    { type: "event", milliseconds: 1000, millisecondsPerMeasure: 2000, startCharArray: [13, 26], endCharArray: [15, 28] },
    { type: "end", milliseconds: 1500 },
  ];
  const voiceOf = new Map([[20, 1], [23, 1], [26, 1]]); // 10 and 13 missing

  it("lasts its own written length, not until the other voice's next onset", () => {
    expect(loopRange(timeline, { from: 10, to: 12 }, voiceOf, 1)).toEqual({ startMs: 0, endMs: 1000 });
  });

  it("in 3/4 the same length is measured against a 3/4 bar", () => {
    const threeFour = timeline.map((ev) => (ev.type === "event" ? { ...ev, millisecondsPerMeasure: 1500 } : ev));
    expect(loopRange(threeFour, { from: 10, to: 12 }, voiceOf, 0.75)).toEqual({ startMs: 0, endMs: 1000 });
  });

  it("with grace notes abcjs halved the pitch: the whole note still counts", () => {
    const graced = [{ ...timeline[0], midiPitches: [{ startChar: 10, duration: 0.25 }], midiGraceNotePitches: [{}] }, ...timeline.slice(1)];
    expect(loopRange(graced, { from: 10, to: 12 }, voiceOf, 1)).toEqual({ startMs: 0, endMs: 1000 });
  });

  it("with nothing to measure it falls back to the next event of any voice", () => {
    expect(loopRange(timeline, { from: 10, to: 12 }, voiceOf)).toEqual({ startMs: 0, endMs: 500 });
  });
});

describe("loopWrapTarget", () => {
  const range = { startMs: 1500, endMs: 4500 };
  it("past the end, or before the start, goes back to the start", () => {
    expect(loopWrapTarget(range, 4500)).toBe(1500);
    expect(loopWrapTarget(range, 0)).toBe(1500);
  });
  it("inside the range stays put", () => {
    expect(loopWrapTarget(range, 1500)).toBeNull();
    expect(loopWrapTarget(range, 4499)).toBeNull();
  });
});
