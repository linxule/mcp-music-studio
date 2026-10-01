// The stage runtime (src/shared/stage-runtime.ts): cycle(), onFrame, onEvent,
// onTap, say() — driven by a fake clock and a fake requestAnimationFrame, with
// real Strudel patterns.
import { note, s } from "@strudel/core";
import { mini } from "@strudel/mini";
import { describe, expect, it, vi } from "vitest";
import { createStage, guardBrowserSpeech, type StageEnv } from "../src/shared/stage-runtime";

function harness(overrides: Partial<StageEnv> = {}) {
  const frames = new Map<number, (ms: number) => void>();
  let nextId = 1;
  let now: number | null = 0;
  let playing = true;
  let ms = 0;
  let deliverTap: ((x: number, y: number) => void) | null = null;
  const errors: Array<[string, unknown]> = [];
  const env: StageEnv = {
    audibleCycle: () => now,
    isPlaying: () => playing,
    requestFrame: (cb) => {
      const id = nextId++;
      frames.set(id, cb);
      return id;
    },
    cancelFrame: (id) => void frames.delete(id),
    listenTaps: (deliver) => {
      deliverTap = deliver;
      return () => {
        deliverTap = null;
      };
    },
    reportError: (api, err) => void errors.push([api, err]),
    ...overrides,
  };
  const stage = createStage(env);
  return {
    stage,
    errors,
    /** Run one animation frame at `cycle`. */
    frame(cycle: number | null, stepMs = 16) {
      now = cycle;
      ms += stepMs;
      const pending = [...frames.values()];
      frames.clear();
      for (const cb of pending) cb(ms);
    },
    framesQueued: () => frames.size,
    tap: (x: number, y: number) => deliverTap?.(x, y),
    listening: () => deliverTap !== null,
    setPlaying: (p: boolean) => {
      playing = p;
    },
  };
}

describe("cycle()", () => {
  it("is the audible cycle, and holds its last value when there is none", () => {
    const h = harness();
    h.frame(2.5);
    expect(h.stage.globals.cycle()).toBe(2.5);
    h.frame(null);
    expect(h.stage.globals.cycle()).toBe(2.5);
  });
});

describe("onFrame", () => {
  it("runs every frame with cycle, dt and playing, and stops when cancelled", () => {
    const h = harness();
    const seen: number[] = [];
    const cancel = h.stage.globals.onFrame((f) => seen.push(f.cycle));
    h.frame(0.1);
    h.frame(0.2);
    expect(seen).toEqual([0.1, 0.2]);
    cancel();
    expect(h.framesQueued()).toBe(0);
    h.frame(0.3);
    expect(seen).toEqual([0.1, 0.2]);
  });

  it("reports a throwing callback once and keeps the loop alive", () => {
    const h = harness();
    let calls = 0;
    h.stage.globals.onFrame(() => {
      calls++;
      throw new Error("boom");
    });
    h.frame(0.1);
    h.frame(0.2);
    h.frame(0.3);
    expect(calls).toBe(3);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0][0]).toBe("onFrame");
  });
});

describe("evaluations own their registrations", () => {
  it("a successful re-evaluation replaces the previous loop — exactly one runs", () => {
    const h = harness();
    const runs: string[] = [];
    h.stage.begin();
    h.stage.globals.onFrame(() => runs.push("old"));
    h.stage.commit();
    h.frame(0.1);
    h.stage.begin();
    h.stage.globals.onFrame(() => runs.push("new"));
    // Not live until the evaluation succeeds.
    h.frame(0.2);
    h.stage.commit();
    h.frame(0.3);
    expect(runs).toEqual(["old", "old", "new"]);
    expect(h.stage.size()).toBe(1);
  });

  it("a failed evaluation keeps the old piece's visuals (its pattern is still playing)", () => {
    const h = harness();
    const runs: string[] = [];
    h.stage.begin();
    h.stage.globals.onFrame(() => runs.push("old"));
    h.stage.commit();
    h.stage.begin();
    h.stage.globals.onFrame(() => runs.push("broken"));
    h.stage.rollback();
    h.frame(0.1);
    expect(runs).toEqual(["old"]);
  });

  it("stop() ends everything, taps included", () => {
    const h = harness();
    h.stage.globals.onFrame(() => {});
    h.stage.globals.onTap(() => {});
    expect(h.listening()).toBe(true);
    h.stage.stop();
    expect(h.framesQueued()).toBe(0);
    expect(h.listening()).toBe(false);
  });
});

describe("onEvent", () => {
  it("fires once per onset as the playhead crosses it, with midi from the note", () => {
    const h = harness();
    const events: Array<{ cycle: number; midi?: number; note?: unknown }> = [];
    h.stage.globals.onEvent(note(mini("c3 e3 g3 c4")), (e) => events.push(e));
    h.frame(0); // first frame: starts the window, fires nothing
    h.frame(0.3); // crosses 0 and 0.25
    h.frame(0.6); // crosses 0.5
    h.frame(0.6); // stopped: nothing
    h.frame(1.0); // crosses 0.75
    expect(events.map((e) => e.cycle)).toEqual([0, 0.25, 0.5, 0.75]);
    expect(events.map((e) => e.midi)).toEqual([48, 52, 55, 60]);
  });

  it("does not replay a backlog after a jump", () => {
    const h = harness();
    const fired: number[] = [];
    h.stage.globals.onEvent(s(mini("bd*8")), (e) => fired.push(e.cycle));
    h.frame(0);
    h.frame(5); // a seek / a stalled tab: skip, don't flood 40 events
    h.frame(5.2);
    expect(fired).toEqual([5, 5.125]);
  });

  it("accepts a single-quoted string through toPattern, and names the problem otherwise", () => {
    const h = harness({ toPattern: (v) => (typeof v === "string" ? s(mini(v)) : undefined) });
    expect(() => h.stage.globals.onEvent("bd sd", () => {})).not.toThrow();
    const bare = harness();
    expect(() => bare.stage.globals.onEvent(42, () => {})).toThrow(/needs a pattern/);
  });
});

describe("onTap", () => {
  it("delivers x, y, the audible cycle, and a slot past the scheduler's horizon", () => {
    let horizon = 1.3;
    const h = harness({ scheduledUntil: () => horizon, cps: () => 0.5 });
    const taps: Array<{ x: number; y: number; cycle: number; slot: number }> = [];
    h.stage.globals.onTap((t) => taps.push({ x: t.x, y: t.y, cycle: t.cycle, slot: t.next(16) }));
    h.frame(1.2);
    h.tap(0.25, 0.75);
    expect(taps[0]).toMatchObject({ x: 0.25, y: 0.75, cycle: 1.2 });
    // Never at or before what the scheduler has already committed.
    expect(taps[0].slot).toBeGreaterThan(horizon);
    expect(taps[0].slot * 16).toBe(Math.round(taps[0].slot * 16));
    // The old "two 16ths ahead of the clock" rule would have landed at 1.3125,
    // barely past this horizon — and behind any later one.
    horizon = 1.45;
    h.tap(0.5, 0.5);
    expect(taps[1].slot).toBeGreaterThan(1.45);
  });

  it("without a known horizon, still lands ahead of the playhead", () => {
    const h = harness();
    let slot = 0;
    h.stage.globals.onTap((t) => {
      slot = t.next(4);
    });
    h.frame(2);
    h.tap(0, 0);
    expect(slot).toBeGreaterThan(2);
    expect(slot * 4).toBe(Math.round(slot * 4));
  });
});

// ---------------------------------------------------------------------------

describe("say() — words as a sample", () => {
  function voiced() {
    const registered: Array<[string, string]> = [];
    const prefetched: string[] = [];
    const h = harness({
      ttsOrigin: "https://music-studio.linxule.com",
      registerSample: (name, url) => void registered.push([name, url]),
      sound: (name) => s(name),
      prefetch: (url) => void prefetched.push(url),
    });
    return { h, registered, prefetched };
  }

  it("registers the server-rendered clip and returns a pattern that plays it", () => {
    const { h, registered, prefetched } = voiced();
    const line = h.stage.globals.say("hi.   it is me.", { voice: "Orion" }) as any;
    const [name, url] = registered[0];
    expect(name).toMatch(/^say_[0-9a-f]{8}$/);
    expect(url).toBe("https://music-studio.linxule.com/tts?voice=orion&text=hi.+it+is+me.");
    expect(prefetched).toEqual([url]);
    // A real pattern: schedulable, maskable, mixable like any other sound.
    const haps = line.queryArc(0, 1);
    expect(haps).toHaveLength(1);
    expect(haps[0].value).toEqual({ s: name });
  });

  it("the same words in the same voice share one sample", () => {
    const { h, registered } = voiced();
    h.stage.globals.say("stay");
    h.stage.globals.say("stay");
    h.stage.globals.say("stay", { voice: "zeus" });
    expect(registered[0][0]).toBe(registered[1][0]);
    expect(registered[2][0]).not.toBe(registered[0][0]);
  });

  it("fails loud on what the server would refuse", () => {
    const { h } = voiced();
    expect(() => h.stage.globals.say("")).toThrow(/needs some words/);
    expect(() => h.stage.globals.say("x".repeat(500))).toThrow(/at most 240/);
    expect(() => h.stage.globals.say("hi", { voice: "morgan-freeman" })).toThrow(/not one of/);
    expect(() => harness().stage.globals.say("hi")).toThrow(/not available/);
  });

  it("a new evaluation and teardown both silence raw browser speech", () => {
    const cancelSpeech = vi.fn();
    const h = harness({ cancelSpeech });
    h.stage.begin();
    h.stage.commit();
    h.stage.stop();
    expect(cancelSpeech).toHaveBeenCalledTimes(2);
  });
});

describe("guardBrowserSpeech", () => {
  it("unlocks once with a silent utterance and cancels only when something is speaking", () => {
    const spoken: any[] = [];
    const synth = { speaking: false, pending: false, cancels: 0, speak: (u: any) => spoken.push(u), cancel() { this.cancels++; } };
    class Utterance { volume = 1; constructor(public text: string) {} }
    const guard = guardBrowserSpeech(synth, Utterance as any);
    guard.unlock();
    guard.unlock();
    expect(spoken).toHaveLength(1);
    expect(spoken[0].volume).toBe(0);
    guard.cancel();
    expect(synth.cancels).toBe(0);
    synth.speaking = true;
    guard.cancel();
    expect(synth.cancels).toBe(1);
    expect(() => guardBrowserSpeech(undefined, undefined).unlock()).not.toThrow();
  });
});

describe("review fixes (0.7.0 gauntlet)", () => {
  it("nothing registers after teardown — an evaluation still in flight can't restart a loop", () => {
    const h = harness();
    h.stage.begin();
    h.stage.stop(); // the host tore the widget down mid-evaluation
    h.stage.globals.onFrame(() => {});
    h.stage.globals.onTap(() => {});
    h.stage.rollback();
    expect(h.stage.size()).toBe(0);
    expect(h.framesQueued()).toBe(0);
    expect(h.listening()).toBe(false);
  });

  it("an unknown horizon (NeoCyclist) still lands past the scheduler's lookahead", () => {
    // Codex measured NeoCyclist committed through 0.60 with the playhead at
    // ~0.45 (cps 0.5): heard + 0.35 s·cps + margin clears it.
    const h = harness({ cps: () => 0.5 });
    let slot = 0;
    h.stage.globals.onTap((t) => {
      slot = t.next(16);
    });
    h.frame(0.45);
    h.tap(0.5, 0.5);
    expect(slot).toBeGreaterThan(0.6);
  });
});
