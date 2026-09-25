// =============================================================================
// #30: autoplay ran silently ("Playing…") because the AudioContext was never
// resumed, and the first tap on Play then STOPPED the unheard pattern.
//
// The decision logic lives in src/audio-unlock.ts (DOM-free) and is tested for
// behaviour here; the widget's wiring of it is guarded by source text, like
// widget-transport.test.ts, since src/strudel-app.ts has no importable surface.
// =============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GestureAudioLatch,
  TAP_SLOP_PX,
  listenForAudioGestures,
  playTapAction,
  playbackState,
  resumeAudioContext,
} from "../src/audio-unlock";

/** An AudioContext stand-in whose resume() does whatever the test says. */
function fakeContext(state: string, resume: (ctx: { state: string }) => Promise<void>) {
  const ctx = {
    state,
    calls: 0,
    resume(): Promise<void> {
      ctx.calls++;
      return resume(ctx);
    },
  };
  return ctx;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("resumeAudioContext", () => {
  it("leaves a running context alone", async () => {
    const ctx = fakeContext("running", async () => {});
    await expect(resumeAudioContext(ctx, 100)).resolves.toBe(true);
    expect(ctx.calls).toBe(0);
  });

  it("reports no context, or a closed one, as not running", async () => {
    await expect(resumeAudioContext(null, 100)).resolves.toBe(false);
    const closed = fakeContext("closed", async () => {});
    await expect(resumeAudioContext(closed, 100)).resolves.toBe(false);
    expect(closed.calls).toBe(0);
  });

  it("calls resume() synchronously — before the caller's first await", () => {
    // WebKit honours resume() only inside the gesture's own task.
    const ctx = fakeContext("suspended", async (c) => {
      c.state = "running";
    });
    void resumeAudioContext(ctx, 100);
    expect(ctx.calls).toBe(1);
  });

  it("resolves true once the resume lands", async () => {
    const ctx = fakeContext("suspended", async (c) => {
      c.state = "running";
    });
    await expect(resumeAudioContext(ctx, 100)).resolves.toBe(true);
  });

  it("treats WebKit's 'interrupted' like 'suspended'", async () => {
    const ctx = fakeContext("interrupted", async (c) => {
      c.state = "running";
    });
    await expect(resumeAudioContext(ctx, 100)).resolves.toBe(true);
    expect(ctx.calls).toBe(1);
  });

  it("gives up after the timeout when resume() never settles (no user activation)", async () => {
    vi.useFakeTimers();
    // Measured in WebKit and Chromium: without activation resume() stays pending.
    const ctx = fakeContext("suspended", () => new Promise<void>(() => {}));
    const result = resumeAudioContext(ctx, 300);
    await vi.advanceTimersByTimeAsync(299);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(false);
  });

  it("survives a resume() that rejects or throws", async () => {
    const rejecting = fakeContext("suspended", () => Promise.reject(new Error("NotAllowedError")));
    await expect(resumeAudioContext(rejecting, 100)).resolves.toBe(false);
    const throwing = {
      state: "suspended",
      resume(): Promise<void> {
        throw new Error("sync throw");
      },
    };
    await expect(resumeAudioContext(throwing, 100)).resolves.toBe(false);
  });
});

describe("playbackState", () => {
  it("is 'stopped' whenever the scheduler is, whatever the context says", () => {
    expect(playbackState(false, "running")).toBe("stopped");
    expect(playbackState(false, "suspended")).toBe("stopped");
    expect(playbackState(false, null)).toBe("stopped");
  });

  it("is 'playing' only over a running context", () => {
    expect(playbackState(true, "running")).toBe("playing");
    expect(playbackState(true, "suspended")).toBe("audio-blocked");
    expect(playbackState(true, "interrupted")).toBe("audio-blocked");
    expect(playbackState(true, undefined)).toBe("audio-blocked");
  });
});

describe("playTapAction", () => {
  it("resumes audio instead of stopping a pattern the user has not heard", () => {
    expect(playTapAction(true, true)).toBe("resume-audio");
  });

  it("stops an audible pattern and plays a stopped one", () => {
    expect(playTapAction(true, false)).toBe("stop");
    expect(playTapAction(false, false)).toBe("play");
    expect(playTapAction(false, true)).toBe("play");
  });
});

describe("GestureAudioLatch", () => {
  it("remembers a gesture that began over blocked audio, even after the resume lands", () => {
    // Mouse: pointerdown (blocked) → capture listener resumes → statechange →
    // click. The live state now says "audible", the latch still says the tap
    // was the one that unlocked it.
    const latch = new GestureAudioLatch();
    latch.begin(true);
    expect(playTapAction(true, latch.consume())).toBe("resume-audio");
  });

  it("lets the touch end events add what pointerdown could not unlock", () => {
    // Touch: pointerdown carries no activation, pointerup/touchend do.
    const latch = new GestureAudioLatch();
    latch.begin(true);
    latch.extend(false); // pointerup's resume already landed
    expect(latch.consume()).toBe(true);
  });

  it("does not let an old gesture decide a new one", () => {
    // Ctrl+Enter in the editor while blocked, then a later click on Play once
    // the music is audible: that click must stop it.
    const latch = new GestureAudioLatch();
    latch.begin(true);
    latch.begin(false);
    expect(playTapAction(true, latch.consume())).toBe("stop");
  });

  it("is read once", () => {
    const latch = new GestureAudioLatch();
    latch.begin(true);
    expect(latch.consume()).toBe(true);
    expect(latch.consume()).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Wiring in src/strudel-app.ts
// -----------------------------------------------------------------------------

const STRUDEL = readFileSync(
  fileURLToPath(new URL("../src/strudel-app.ts", import.meta.url)),
  "utf8",
);

const body = (signature: string, end = "\n}\n") => {
  const start = STRUDEL.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThanOrEqual(0);
  return STRUDEL.slice(start, STRUDEL.indexOf(end, start));
};

describe("strudel widget wiring", () => {
  it("the Play handler resumes audio before its first await", () => {
    const handler = body('playBtn.addEventListener("click"', "\n});\n");
    const resume = handler.indexOf("ensureAudioRunning()");
    expect(resume).toBeGreaterThan(0);
    expect(handler.indexOf("await ")).toBeGreaterThan(resume);
    expect(handler).toContain("playTapAction(isPlaying, gestureLatch.consume() || audioBlocked)");
  });

  it("resumes from taps, clicks and keys, but not from a touch press that may still scroll", () => {
    const install = body("const stopGestureUnlock = listenForAudioGestures(document, {", "\n});\n");
    expect(install).toMatch(/press\(kind\) \{\s*gestureLatch\.begin\(isPlaying && audioIsBlockedNow\(\)\);\s*if \(kind !== "touch"\) void ensureAudioRunning\(\);/);
    expect(install).toMatch(/activate\(\) \{\s*gestureLatch\.extend\(isPlaying && audioIsBlockedNow\(\)\);\s*void ensureAudioRunning\(\);/);
  });

  it("an evaluation waits briefly for audio before its one report", () => {
    const hook = body("function installEvaluateHook(");
    const settle = hook.indexOf("await ensureAudioRunning(AUDIO_SETTLE_MS)");
    expect(settle).toBeGreaterThan(0);
    expect(hook.indexOf("reportEvaluation(code, null, tempoAtRuntime)")).toBeGreaterThan(settle);
  });

  it("never tells the model 'playing' over blocked audio", () => {
    const report = body("function reportEvaluation(");
    expect(report).toContain('state === "audio-blocked"');
    expect(report).toMatch(/"loaded and running but NOT audible/);
    // Still exactly one report per evaluation on the success path.
    const success = report.slice(report.indexOf("updatePlayState(isSchedulerStarted())"));
    expect(success.match(/reportToModel\(/g)).toHaveLength(2); // silent branch + normal
  });

  it("follows the context's statechange and lets go of it on teardown", () => {
    expect(body("function watchAudioContext(")).toContain(
      'ctx.addEventListener("statechange", syncAudioState)',
    );
    const teardown = STRUDEL.slice(STRUDEL.indexOf("app.onteardown = "));
    expect(teardown.slice(0, teardown.indexOf("\n};\n"))).toContain("stopGestureUnlock()");
  });

  it("a failed re-evaluation over blocked audio doesn't claim the old pattern is audible", () => {
    // Kimi review: the error report said "still playing" whenever the
    // scheduler ran, even when nothing could be heard.
    const branch = STRUDEL.slice(STRUDEL.indexOf("pattern failed to evaluate"));
    expect(branch.slice(0, 600)).toContain('state === "audio-blocked"');
    expect(branch.slice(0, 600)).toContain("not audible until the user taps Play");
  });
});

// =============================================================================
// Taps, not scrolls. On a phone, the finger that scrolled the conversation past
// a widget ended in a touchend inside the frame, and the resume() it made
// started a parked autoplay (reported from Claude iOS after 0.5.8).
// =============================================================================

describe("listenForAudioGestures", () => {
  /** Dispatch a synthetic event carrying the given fields on `target`. */
  function fire(target: EventTarget, type: string, fields: Record<string, unknown> = {}) {
    const event = new Event(type);
    for (const [key, value] of Object.entries(fields)) {
      Object.defineProperty(event, key, { value });
    }
    target.dispatchEvent(event);
  }
  const touch = (x: number, y: number) => ({ changedTouches: [{ clientX: x, clientY: y }] });
  const pointer = (pointerType: string, x = 0, y = 0) => ({ pointerType, clientX: x, clientY: y });

  function setup() {
    const target = new EventTarget();
    const activate = vi.fn();
    const press = vi.fn();
    const stop = listenForAudioGestures(target, { press, activate });
    return { target, activate, press, stop };
  }

  it("a key press or a mouse press resumes at once", () => {
    const { target, activate, press } = setup();
    fire(target, "keydown");
    fire(target, "pointerdown", pointer("mouse"));
    expect(press.mock.calls).toEqual([["key"], ["mouse"]]);
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it("a touch press alone does not resume — it may still become a scroll", () => {
    const { target, activate, press } = setup();
    fire(target, "pointerdown", pointer("touch", 50, 50));
    fire(target, "touchstart", touch(50, 50));
    expect(press).toHaveBeenCalledWith("touch");
    expect(activate).not.toHaveBeenCalled();
  });

  it("a tap resumes from its end events", () => {
    const { target, activate } = setup();
    fire(target, "pointerdown", pointer("touch", 50, 50));
    fire(target, "touchstart", touch(50, 50));
    fire(target, "touchmove", touch(53, 52)); // finger jitter inside the slop
    fire(target, "pointerup", pointer("touch", 53, 52));
    fire(target, "touchend", touch(53, 52));
    expect(activate).toHaveBeenCalledTimes(2); // resume() is idempotent
  });

  it("a touch that panned never resumes", () => {
    const { target, activate } = setup();
    fire(target, "pointerdown", pointer("touch", 50, 50));
    fire(target, "touchstart", touch(50, 50));
    fire(target, "touchmove", touch(50, 50 + TAP_SLOP_PX + 30));
    fire(target, "touchend", touch(50, 50 + TAP_SLOP_PX + 30));
    expect(activate).not.toHaveBeenCalled();
  });

  it("a pointercancel (the browser took the touch for a pan) never resumes", () => {
    const { target, activate } = setup();
    fire(target, "pointerdown", pointer("touch", 50, 50));
    fire(target, "touchstart", touch(50, 50));
    fire(target, "pointercancel", pointer("touch", 50, 50));
    fire(target, "touchend", touch(50, 50));
    expect(activate).not.toHaveBeenCalled();
  });

  it("works from touch events alone, and each touch starts fresh", () => {
    const { target, activate } = setup();
    fire(target, "touchstart", touch(10, 10));
    fire(target, "touchmove", touch(10, 80));
    fire(target, "touchend", touch(10, 80));
    expect(activate).not.toHaveBeenCalled();
    fire(target, "touchstart", touch(10, 10));
    fire(target, "touchend", touch(10, 10));
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("a second finger does not restart the first one's pan", () => {
    const { target, activate } = setup();
    fire(target, "touchstart", touch(10, 10));
    fire(target, "touchmove", touch(10, 80));
    fire(target, "touchstart", touch(200, 200));
    fire(target, "touchend", touch(200, 200));
    expect(activate).not.toHaveBeenCalled();
  });

  it("a touchcancel ends the touch, so the next tap still counts (Codex review)", () => {
    const { target, activate } = setup();
    fire(target, "touchstart", touch(10, 10));
    fire(target, "touchcancel", touch(10, 10));
    expect(activate).not.toHaveBeenCalled();
    fire(target, "touchstart", touch(10, 10));
    fire(target, "touchend", touch(10, 10));
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("uninstalls cleanly", () => {
    const { target, activate, stop } = setup();
    stop();
    fire(target, "keydown");
    expect(activate).not.toHaveBeenCalled();
  });
});
