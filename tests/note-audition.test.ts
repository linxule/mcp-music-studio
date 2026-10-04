// A clicked note's sound is one async chain (init → prime → start). The
// generation logic decides whether the chain may still start: a newer audition
// or stopAudition() invalidates it. abcjs's synth is stubbed — only the
// ordering is under test; the browser half is scripts/verify-score-click.mjs.
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

vi.mock("abcjs", () => {
  class SynthSequence {
    addTrack() {
      return 0;
    }
    setInstrument() {}
    appendNote() {}
  }
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
