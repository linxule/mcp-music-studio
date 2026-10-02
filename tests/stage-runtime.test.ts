// The stage runtime (src/shared/stage-runtime.ts): cycle(), onFrame, onEvent,
// onTap, say() — driven by a fake clock and a fake requestAnimationFrame, with
// real Strudel patterns.
import { note, s, signal } from "@strudel/core";
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

describe("async callbacks and event duration (Kimi, 0.7.0 gauntlet)", () => {
  it("reports an async onFrame's rejection once", async () => {
    const h = harness();
    h.stage.globals.onFrame(async () => {
      throw new Error("later");
    });
    h.frame(0.1);
    h.frame(0.2);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.errors).toHaveLength(1);
  });

  it("duration falls back to whole.end − begin, not the end position", async () => {
    const { stageEvent } = await import("../src/shared/stage-runtime");
    expect(stageEvent({ whole: { begin: 3, end: 3.5 }, value: {} }, 3).duration).toBe(0.5);
  });
});

describe("Opus gauntlet fixes", () => {
  it("a stale evaluation's commit or rollback can't touch a newer one's registrations", () => {
    const h = harness();
    const runs: string[] = [];
    const a = h.stage.begin();
    h.stage.globals.onFrame(() => runs.push("A"));
    const b = h.stage.begin(); // A outlived the queue timeout; B began
    h.stage.globals.onFrame(() => runs.push("B"));
    h.stage.commit(a); // stale: ignored
    h.stage.rollback(a); // stale: ignored
    h.stage.commit(b);
    h.frame(0.1);
    expect(runs).toEqual(["B"]);
  });

  it("a touch that scrolls is not a tap; a touch that stays is, at the press position", async () => {
    const { createBrowserStageEnv } = await import("../src/shared/stage-runtime");
    const listeners = new Map<string, (e: any) => void>();
    const area: any = {
      addEventListener: (type: string, fn: (e: any) => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 200 }),
    };
    const { env } = createBrowserStageEnv({
      getScheduler: () => null,
      isPlaying: () => false,
      tapArea: area,
      reportError: () => {},
      ttsOrigin: "https://music-studio.linxule.com",
    });
    const taps: Array<[number, number]> = [];
    env.listenTaps((x, y) => taps.push([x, y]));
    const ev = (type: string, x: number, y: number, pointerType = "touch") =>
      listeners.get(type)!({ type, clientX: x, clientY: y, pointerId: 1, pointerType, isPrimary: true, target: null });
    ev("pointerdown", 100, 100);
    ev("pointermove", 100, 160); // a scroll
    ev("pointerup", 100, 160);
    expect(taps).toEqual([]);
    ev("pointerdown", 200, 50);
    ev("pointermove", 203, 52);
    ev("pointerup", 203, 52);
    expect(taps).toEqual([[0.5, 0.25]]);
    ev("pointerdown", 0, 0, "mouse"); // a click is immediate
    expect(taps).toHaveLength(2);
  });
});

describe("controls — fader(), pad(), xy()", () => {
  const withControls = () => {
    const rendered: Array<Array<{ name: string; kind: string }>> = [];
    const observed: unknown[] = [];
    let input: ((name: string, value: any, final: boolean) => void) | null = null;
    const h = harness({
      // A real Strudel signal: sampled when queried.
      signal: (read) => signal(() => read()),
      renderControls: (specs, _values, set) => {
        rendered.push(specs.map((sp) => ({ name: sp.name, kind: sp.kind })));
        input = set;
      },
      observeControl: (c) => void observed.push(c),
    });
    return { h, rendered, observed, move: (n: string, v: any, final = true) => input?.(n, v, final) };
  };

  it("a fader is a pattern that reads the performer's value", () => {
    const { h, move } = withControls();
    const t = h.stage.begin();
    const rain = h.stage.globals.fader("rain", { min: 0, max: 2, init: 0.5 });
    h.stage.commit(t);
    const sampled = () => (s(mini("hh*4")).gain(rain as any) as any).queryArc(0, 1).map((x: any) => x.value.gain);
    expect(rain.value).toBe(0.5);
    expect(sampled()).toEqual([0.5, 0.5, 0.5, 0.5]);
    move("rain", 1.5);
    expect(rain.value).toBe(1.5);
    expect(sampled()).toEqual([1.5, 1.5, 1.5, 1.5]);
    move("rain", 9); // clamped to the range
    expect(rain.value).toBe(2);
  });

  it("values survive a re-evaluation; specs belong to it", () => {
    const { h, rendered, move } = withControls();
    let t = h.stage.begin();
    h.stage.globals.fader("rain");
    h.stage.globals.pad("drop", { toggle: true });
    h.stage.commit(t);
    move("rain", 0.8);
    t = h.stage.begin();
    const again = h.stage.globals.fader("rain");
    h.stage.commit(t);
    expect(again.value).toBe(0.8);
    expect(rendered.at(-1)).toEqual([{ name: "rain", kind: "fader" }]);
    // A failed evaluation keeps the strip it had.
    t = h.stage.begin();
    h.stage.globals.xy("space");
    h.stage.rollback(t);
    expect(h.stage.controls().map((c) => c.spec.name)).toEqual(["rain"]);
  });

  it("reports final moves with the cycle, not every drag step", () => {
    const { h, observed, move } = withControls();
    const t = h.stage.begin();
    h.stage.globals.fader("rain");
    h.stage.commit(t);
    h.frame(3.25);
    move("rain", 0.2, false);
    move("rain", 0.4, false);
    move("rain", 0.6, true);
    expect(observed).toEqual([{ name: "rain", kind: "fader", value: 0.6, cycle: 3.25 }]);
  });

  it("an xy pad has x and y patterns and clamps to 0..1", () => {
    const { h, move } = withControls();
    const t = h.stage.begin();
    const space = h.stage.globals.xy("space");
    h.stage.commit(t);
    expect(space.value).toEqual([0.5, 0.5]);
    move("space", [1.4, -0.2]);
    expect(space.value).toEqual([1, 0]);
    expect(space.x.value).toBe(1);
    expect(space.y.value).toBe(0);
  });

  it("refuses a nameless control and an empty range, and caps the strip", () => {
    const { h } = withControls();
    const t = h.stage.begin();
    expect(() => h.stage.globals.fader("")).toThrow(/needs a name/);
    expect(() => h.stage.globals.fader("x", { min: 1, max: 1 })).toThrow(/max must be greater/);
    for (let i = 0; i < 12; i++) h.stage.globals.pad(`p${i}`);
    expect(() => h.stage.globals.pad("one-too-many")).toThrow(/At most 12/);
    h.stage.rollback(t);
  });

  it("teardown clears the strip", () => {
    const { h, rendered } = withControls();
    const t = h.stage.begin();
    h.stage.globals.pad("drop");
    h.stage.commit(t);
    h.stage.stop();
    expect(rendered.at(-1)).toEqual([]);
  });
});

it("a double-quoted control name (a mini-notation pattern) still names the control", () => {
  const h = harness({ signal: (read) => signal(() => read()) });
  const t = h.stage.begin();
  const rain = h.stage.globals.fader(mini("rain") as any, { init: 0.4 });
  h.stage.commit(t);
  expect(h.stage.controls().map((c) => c.spec.name)).toEqual(["rain"]);
  expect(rain.value).toBe(0.4);
});

describe("sensors — tilt() and mic()", () => {
  const withSensors = () => {
    let feed: ((s: "tilt" | "mic", v: any) => void) | null = null;
    let status: ((s: "tilt" | "mic", st: any) => void) | null = null;
    const wants: Array<Record<string, boolean>> = [];
    const rendered: any[][] = [];
    const observed: any[] = [];
    const shown: Array<[string, unknown]> = [];
    let clock = 0;
    let input: any = null;
    const h = harness({
      signal: (read) => signal(() => read()),
      renderControls: (specs, _v, set) => {
        rendered.push(specs.map((sp) => ({ name: sp.name, sensor: sp.sensor, source: sp.source })));
        input = set;
      },
      observeControl: (c) => void observed.push(c),
      showControlValue: (n, v) => void shown.push([n, v]),
      now: () => clock,
      sensors: (want, f, st) => {
        wants.push({ ...want });
        feed = f;
        status = st;
      },
    });
    return {
      h, wants, rendered, observed, shown,
      feed: (s: "tilt" | "mic", v: any) => feed?.(s, v),
      status: (s: "tilt" | "mic", st: any) => status?.(s, st),
      tick: (ms: number) => (clock += ms),
      move: (n: string, v: any) => input?.(n, v, true),
    };
  };

  it("asks the env only for the sensors the committed piece declares", () => {
    const t = withSensors();
    let tok = t.h.stage.begin();
    t.h.stage.globals.tilt();
    t.h.stage.globals.fader("x");
    t.h.stage.commit(tok);
    expect(t.wants.at(-1)).toEqual({ tilt: true, mic: false });
    tok = t.h.stage.begin();
    t.h.stage.globals.mic();
    t.h.stage.commit(tok);
    expect(t.wants.at(-1)).toEqual({ tilt: false, mic: true });
    t.h.stage.stop();
    expect(t.wants.at(-1)).toEqual({ tilt: false, mic: false });
  });

  it("is played by hand until the sensor is live, then the sensor takes it", () => {
    const t = withSensors();
    const tok = t.h.stage.begin();
    const lean = t.h.stage.globals.tilt();
    const room = t.h.stage.globals.mic("room");
    t.h.stage.commit(tok);
    expect(t.rendered.at(-1)).toEqual([
      { name: "tilt", sensor: "tilt", source: "manual" },
      { name: "room", sensor: "mic", source: "manual" },
    ]);
    // By hand: the strip moves it, readings are ignored.
    t.move("tilt", [0.2, 0.9]);
    t.feed("tilt", [0.8, 0.1]);
    expect(lean.value).toEqual([0.2, 0.9]);
    // Live: readings move it, the hand doesn't.
    t.status("tilt", { state: "live" });
    expect(t.rendered.at(-1)?.[0]).toEqual({ name: "tilt", sensor: "tilt", source: "sensor" });
    t.feed("tilt", [0.7, 0.3]);
    expect(lean.value).toEqual([0.7, 0.3]);
    t.move("tilt", [0, 0]);
    expect(lean.value).toEqual([0.7, 0.3]);
    expect(t.shown.at(-1)).toEqual(["tilt", [0.7, 0.3]]);
    // The mic is still by hand.
    expect(room.value).toBe(0);
    expect(t.h.stage.sensorStates().tilt.state).toBe("live");
  });

  it("logs sensor moves at most twice a second, and only real changes", () => {
    const t = withSensors();
    const tok = t.h.stage.begin();
    t.h.stage.globals.mic();
    t.h.stage.commit(tok);
    t.status("mic", { state: "live" });
    for (let i = 0; i < 30; i++) {
      t.tick(50);
      t.feed("mic", 0.5 + (i % 2) * 0.001); // noise, then held
    }
    expect(t.observed).toHaveLength(1);
    expect(t.observed[0]).toMatchObject({ name: "mic", kind: "fader", value: 0.5, source: "sensor" });
    t.tick(600);
    t.feed("mic", 0.9);
    expect(t.observed).toHaveLength(2);
  });

  it("keeps its value across re-evaluation, like any control", () => {
    const t = withSensors();
    let tok = t.h.stage.begin();
    t.h.stage.globals.tilt("lean");
    t.h.stage.commit(tok);
    t.move("lean", [0.1, 0.1]);
    tok = t.h.stage.begin();
    const again = t.h.stage.globals.tilt("lean");
    t.h.stage.commit(tok);
    expect(again.value).toEqual([0.1, 0.1]);
  });
});

describe("createBrowserSensors (fake window)", () => {
  const fakeWindow = (opts: { gum?: "ok" | "deny" | "none"; iosTilt?: "granted" | "denied" | null } = {}) => {
    const listeners = new Map<string, Set<(e: any) => void>>();
    const intervals: Array<() => void> = [];
    const stopped: string[] = [];
    const w: any = {
      addEventListener: (type: string, fn: any) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: any) => listeners.get(type)?.delete(fn),
      setInterval: (fn: () => void) => (intervals.push(fn), intervals.length),
      clearInterval: () => undefined,
      DeviceOrientationEvent: opts.iosTilt === undefined ? function () {} : Object.assign(function () {}, {
        requestPermission: () => Promise.resolve(opts.iosTilt ?? "denied"),
      }),
      navigator: {
        mediaDevices:
          opts.gum === "none"
            ? undefined
            : {
                getUserMedia: () =>
                  opts.gum === "deny"
                    ? Promise.reject(Object.assign(new Error("no"), { name: "NotAllowedError" }))
                    : Promise.resolve({ getTracks: () => [{ stop: () => stopped.push("track") }] }),
              },
      },
      AudioContext: function () {
        return {
          createMediaStreamSource: () => ({ connect: () => undefined, disconnect: () => undefined }),
          createAnalyser: () => ({
            fftSize: 1024,
            disconnect: () => undefined,
            getFloatTimeDomainData: (buf: Float32Array) => buf.fill(0.1),
          }),
        };
      },
    };
    const fire = (type: string, e: any = {}) => listeners.get(type)?.forEach((fn) => fn(e));
    return { w, fire, intervals, stopped, listeners };
  };

  it("never opens the mic before a tap, then reads its loudness", async () => {
    const { createBrowserSensors } = await import("../src/shared/stage-runtime");
    const f = fakeWindow();
    const states: any[] = [];
    const fed: any[] = [];
    const sensors = createBrowserSensors(f.w);
    sensors.sync({ tilt: false, mic: true }, (s, v) => fed.push([s, v]), (s, st) => states.push([s, st.state]));
    expect(states).toEqual([["mic", "waiting"]]);
    f.fire("pointerup");
    await new Promise((r) => setTimeout(r, 0));
    expect(states.at(-1)).toEqual(["mic", "live"]);
    f.intervals[0]();
    expect(fed.at(-1)[0]).toBe("mic");
    expect(fed.at(-1)[1]).toBeGreaterThan(0);
    sensors.sync({ tilt: false, mic: false }, () => undefined, () => undefined);
    expect(f.stopped).toEqual(["track"]);
  });

  it("reports a refused mic and doesn't ask again on every tap", async () => {
    const { createBrowserSensors } = await import("../src/shared/stage-runtime");
    const f = fakeWindow({ gum: "deny" });
    const states: any[] = [];
    const sensors = createBrowserSensors(f.w);
    let asks = 0;
    const gum = f.w.navigator.mediaDevices.getUserMedia;
    f.w.navigator.mediaDevices.getUserMedia = (...a: any[]) => (asks++, gum(...a));
    sensors.sync({ tilt: false, mic: true }, () => undefined, (s, st) => states.push([s, st.state, st.detail]));
    f.fire("pointerup");
    await new Promise((r) => setTimeout(r, 0));
    f.fire("pointerup");
    await new Promise((r) => setTimeout(r, 0));
    expect(states.at(-1)).toEqual(["mic", "denied", "NotAllowedError"]);
    expect(asks).toBe(1);
  });

  it("tilt: iOS asks inside the tap; readings go live, relative to how it was first held", async () => {
    const { createBrowserSensors } = await import("../src/shared/stage-runtime");
    const f = fakeWindow({ iosTilt: "granted" });
    const states: any[] = [];
    const fed: any[] = [];
    const sensors = createBrowserSensors(f.w);
    sensors.sync({ tilt: true, mic: false }, (s, v) => fed.push(v), (s, st) => states.push(st.state));
    expect(states).toEqual(["waiting"]);
    expect(f.listeners.get("deviceorientation")?.size ?? 0).toBe(0);
    f.fire("touchend");
    await new Promise((r) => setTimeout(r, 0));
    expect(f.listeners.get("deviceorientation")?.size).toBe(1);
    f.fire("deviceorientation", { beta: 40, gamma: 0 });
    expect(states.at(-1)).toBe("live");
    expect(fed.at(-1)).toEqual([0.5, 0.5]);
    f.fire("deviceorientation", { beta: 40, gamma: 35 });
    expect(fed.at(-1)[0]).toBeGreaterThan(0.5);
  });

  it("a desktop's all-null orientation event is not a reading", async () => {
    const { createBrowserSensors } = await import("../src/shared/stage-runtime");
    const f = fakeWindow({});
    const states: any[] = [];
    const sensors = createBrowserSensors(f.w);
    sensors.sync({ tilt: true, mic: false }, () => undefined, (s, st) => states.push(st.state));
    f.fire("deviceorientation", { beta: null, gamma: null });
    expect(states).toEqual(["listening"]);
  });
});
