// A clicked note's sound is one async chain (init → prime → start). The
// generation logic decides whether the chain may still start: a newer audition
// or stopAudition() invalidates it. abcjs's synth is stubbed — only the
// ordering is under test; the browser half is scripts/verify-score-click.mjs.
// The sequence is abcjs's real SynthSequence, so its note timing can be read.
import { beforeEach, describe, expect, it, vi } from "vitest";

interface FakeBuffer {
  init: ReturnType<typeof vi.fn>;
  prime: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

const created: FakeBuffer[] = [];
/** Resolvers for the next buffer's init()/prime(), when a test wants to hold them. */
let holdInit = false;
let holdPrime = false;
const pendingInit: Array<() => void> = [];
const pendingPrime: Array<() => void> = [];

vi.mock("abcjs", async () => {
  const { createRequire } = await import("node:module");
  const SynthSequence = createRequire(import.meta.url)("abcjs/src/synth/synth-sequence.js");
  class CreateSynth {
    constructor() {
      const buffer: FakeBuffer = {
        init: vi.fn(() => (holdInit ? new Promise<void>((r) => pendingInit.push(r)) : Promise.resolve())),
        prime: vi.fn(() => (holdPrime ? new Promise<void>((r) => pendingPrime.push(r)) : Promise.resolve())),
        start: vi.fn(),
        stop: vi.fn(),
      };
      created.push(buffer);
      return buffer as unknown as CreateSynth;
    }
  }
  return { default: { synth: { SynthSequence, CreateSynth } } };
});

const { auditionNote, stopAudition } = await import("../src/note-audition");

const REQUEST = {
  pitches: [{ pitch: 60, duration: 0.25, volume: 80, instrument: 0 }],
  msPerWholeNote: 2000,
  synthOptions: {},
};

/** Let queued promise continuations run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  stopAudition();
  created.length = 0;
  pendingInit.length = 0;
  pendingPrime.length = 0;
  holdInit = false;
  holdPrime = false;
});

describe("auditionNote generations", () => {
  it("sounds a note when nothing intervenes", async () => {
    const route = vi.fn();
    expect(await auditionNote({ ...REQUEST, route })).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0].start).toHaveBeenCalledTimes(1);
    expect(route).toHaveBeenCalledWith(created[0]);
  });

  it("stopAudition during a pending init: the audition never starts and releases its buffer", async () => {
    holdInit = true;
    const route = vi.fn();
    const result = auditionNote({ ...REQUEST, route });
    await settle();
    expect(created).toHaveLength(1);
    stopAudition();
    pendingInit.forEach((resolve) => resolve());
    expect(await result).toBe(false);
    expect(created[0].start).not.toHaveBeenCalled();
    expect(created[0].prime).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
    expect(created[0].stop).toHaveBeenCalled();
  });

  it("stopAudition during a pending prime: the audition never starts and releases its buffer", async () => {
    holdPrime = true;
    const route = vi.fn();
    const result = auditionNote({ ...REQUEST, route });
    await settle();
    stopAudition();
    pendingPrime.forEach((resolve) => resolve());
    expect(await result).toBe(false);
    expect(created[0].start).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
    expect(created[0].stop).toHaveBeenCalled();
  });

  it("a newer audition supersedes one still loading", async () => {
    holdInit = true;
    const first = auditionNote(REQUEST);
    await settle();
    holdInit = false;
    expect(await auditionNote(REQUEST)).toBe(true);
    pendingInit.forEach((resolve) => resolve());
    expect(await first).toBe(false);
    expect(created[0].start).not.toHaveBeenCalled();
    expect(created[1].start).toHaveBeenCalledTimes(1);
  });

  it("stopAudition silences a note that is already ringing", async () => {
    expect(await auditionNote(REQUEST)).toBe(true);
    created[0].stop.mockClear();
    stopAudition();
    expect(created[0].stop).toHaveBeenCalledTimes(1);
  });

  it("an audition after a stop sounds again", async () => {
    stopAudition();
    expect(await auditionNote(REQUEST)).toBe(true);
    expect(created[0].start).toHaveBeenCalledTimes(1);
  });
});

describe("auditionNote grace notes (Kimi review)", () => {
  type Note = { cmd: string; pitch: number; start: number; duration: number };
  const notesOf = () => {
    const { sequence } = created[0].init.mock.calls[0][0] as { sequence: { tracks: Array<Array<{ cmd: string }>> } };
    return sequence.tracks.map((track) => track.filter((e): e is Note => e.cmd === "note"));
  };

  it("a chord with graces: the graces sound once, and every chord tone starts after them", async () => {
    // abcjs halves each chord tone when there are graces, and the graces fill the other half.
    const tone = (pitch: number) => ({ pitch, duration: 0.125, volume: 80, instrument: 0 });
    expect(
      await auditionNote({
        ...REQUEST,
        pitches: [tone(60), tone(64), tone(67)],
        graces: [
          { pitch: 62, durationInMeasures: 0.0625, volume: 53 },
          { pitch: 61, durationInMeasures: 0.0625, volume: 53 },
        ],
      }),
    ).toBe(true);
    const [graces, ...chord] = notesOf();
    expect(graces.map((n) => [n.pitch, n.start, n.duration])).toEqual([[62, 0, 0.0625], [61, 0.0625, 0.0625]]);
    expect(chord.map((track) => track.map((n) => [n.pitch, n.start]))).toEqual([[[60, 0.125]], [[64, 0.125]], [[67, 0.125]]]);
  });

  it("without graces every chord tone starts at once", async () => {
    await auditionNote({ ...REQUEST, pitches: [REQUEST.pitches[0], { ...REQUEST.pitches[0], pitch: 64 }] });
    expect(notesOf().map((track) => track.map((n) => n.start))).toEqual([[0], [0]]);
  });

  it("graces never take more than half of the audition's cap, and the whole stays within it", async () => {
    // 2000 ms per whole note: the 1.5 s cap is 0.75 of a whole note.
    await auditionNote({
      ...REQUEST,
      pitches: [{ pitch: 60, duration: 2, volume: 80, instrument: 0 }],
      graces: [{ pitch: 62, durationInMeasures: 2, volume: 53 }],
    });
    const [[grace], [main]] = notesOf();
    expect(grace.duration).toBeCloseTo(0.375);
    expect(main.start).toBeCloseTo(0.375);
    expect(main.start + main.duration).toBeCloseTo(0.75);
  });
});
