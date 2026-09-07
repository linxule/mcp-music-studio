/**
 * @file Proves the soundfont-switching bug and the invalidation that fixes it,
 *       against the REAL abcjs loader (`src/synth/load-note.js`).
 *
 * The bug: `soundsCache[instrument][note]` has no bank URL in the key, so the
 * second bank is never fetched. The fix: empty that singleton on a bank change.
 * The load path is stubbed only at the two edges abcjs cannot have in node —
 * `XMLHttpRequest` and `AudioContext.decodeAudioData`. Everything between them
 * is abcjs's own code.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import getNote from "abcjs/src/synth/load-note.js";
import ABCJS from "abcjs";
import {
  abcjsSoundsCache,
  resetSoundsCache,
  soundsCacheLooksLive,
  soundsCacheSize,
} from "../src/abcjs-sound-cache";

const BANK_A = "https://bank-a.example/";
const BANK_B = "https://bank-b.example/";

let fetched: string[] = [];

/** Minimal XHR that records the URL and hands back eight bytes. */
class RecordingXHR {
  url = "";
  status = 0;
  response: ArrayBuffer = new ArrayBuffer(0);
  responseType = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  open(_method: string, url: string) {
    this.url = url;
  }
  send() {
    fetched.push(this.url);
    this.status = 200;
    this.response = new ArrayBuffer(8);
    this.onload?.();
  }
}

const audioContext = {
  decodeAudioData(_buf: ArrayBuffer, ok: (b: unknown) => void) {
    ok({ marker: fetched[fetched.length - 1] });
    return undefined;
  },
} as unknown as AudioContext;

beforeEach(() => {
  fetched = [];
  resetSoundsCache();
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = RecordingXHR;
});

afterEach(() => {
  resetSoundsCache();
  delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
});

describe("abcjs sample cache — the bank-switch bug", () => {
  it("ignores the soundfont URL in its cache key", async () => {
    await getNote(BANK_A, "flute", "C4", audioContext);
    await getNote(BANK_B, "flute", "C4", audioContext);

    // One request, to bank A. Bank B was never asked for.
    expect(fetched).toEqual([`${BANK_A}flute-mp3/C4.mp3`]);
  });

  it("hands the FIRST bank's sample back for the second bank", async () => {
    const first = (await getNote(BANK_A, "flute", "C4", audioContext)) as {
      audioBuffer: { marker: string };
    };
    const second = (await getNote(BANK_B, "flute", "C4", audioContext)) as {
      audioBuffer: { marker: string };
    };

    expect(second.audioBuffer.marker).toBe(first.audioBuffer.marker);
    expect(second.audioBuffer.marker).toContain("bank-a");
  });

  it("caches per instrument+note, so an untouched note still refetches", async () => {
    await getNote(BANK_A, "flute", "C4", audioContext);
    await getNote(BANK_B, "flute", "D4", audioContext); // not cached yet
    expect(fetched).toEqual([
      `${BANK_A}flute-mp3/C4.mp3`,
      `${BANK_B}flute-mp3/D4.mp3`,
    ]);
  });
});

describe("resetSoundsCache — the invalidation", () => {
  it("makes the second bank actually load", async () => {
    await getNote(BANK_A, "flute", "C4", audioContext);
    expect(resetSoundsCache()).toBe(1); // one instrument dropped

    const second = (await getNote(BANK_B, "flute", "C4", audioContext)) as {
      audioBuffer: { marker: string };
    };

    expect(fetched).toEqual([
      `${BANK_A}flute-mp3/C4.mp3`,
      `${BANK_B}flute-mp3/C4.mp3`,
    ]);
    expect(second.audioBuffer.marker).toContain("bank-b");
  });

  it("clears every instrument, not just the last one", async () => {
    await getNote(BANK_A, "flute", "C4", audioContext);
    await getNote(BANK_A, "acoustic_grand_piano", "C4", audioContext);
    expect(soundsCacheSize()).toBe(2);

    resetSoundsCache();
    expect(soundsCacheSize()).toBe(0);
  });

  it("mutates in place rather than reassigning the singleton", async () => {
    const identity = abcjsSoundsCache;
    await getNote(BANK_A, "flute", "C4", audioContext);
    resetSoundsCache();
    // Every abcjs module captured this object at import time; swapping it out
    // would leave load-note and place-note writing to an orphan.
    expect(abcjsSoundsCache).toBe(identity);
  });

  it("is a no-op on an already-empty cache", () => {
    expect(resetSoundsCache()).toBe(0);
    expect(soundsCacheSize()).toBe(0);
  });
});

describe("soundsCacheLooksLive — the guard against a silent deep-import miss", () => {
  it("says yes before anything has been primed", () => {
    expect(soundsCacheLooksLive(false)).toBe(true);
  });

  it("says no when audio was primed but our reference stayed empty", () => {
    // The shape of a future abcjs that moved the real cache elsewhere.
    expect(soundsCacheLooksLive(true)).toBe(false);
  });

  it("says yes once the real loader has populated our reference", async () => {
    await getNote(BANK_A, "flute", "C4", audioContext);
    expect(soundsCacheLooksLive(true)).toBe(true);
  });
});

describe("the deep import really is abcjs's live singleton", () => {
  it("still resolves alongside the public entry point", () => {
    // If abcjs ever ships a prebundled main or an `exports` map, `abcjs` and
    // `abcjs/src/...` stop being the same module graph and this whole approach
    // has to become "disable the selector". Guard the assumption it rests on.
    expect(typeof ABCJS.synth.CreateSynth).toBe("function");
    expect(abcjsSoundsCache).toBeTypeOf("object");
  });

  it("abcjs exposes no cache reset of its own", () => {
    expect(
      Object.keys(ABCJS.synth).filter((k) => /cache|reset|clear/i.test(k)),
    ).toEqual([]);
  });
});
