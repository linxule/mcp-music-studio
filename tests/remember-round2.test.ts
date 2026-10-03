// remember() — Codex's round-2 review of the 0.11 fixes (2026-10-03). The
// per-evaluation preview read view was removed: handles read the store, and an
// evaluation's state lands exactly — at the swap's bar (splice.ts splits the
// crossing query) or when its pattern is installed (scheduler.setPattern →
// stage.activateStateNow). Each test reproduces one finding.
import { describe, expect, it, vi } from "vitest";
import { createStage, type StageEnv } from "../src/shared/stage-runtime";
import { MAX_REMEMBER_PER_EVALUATION } from "../src/shared/remember-store";
import { evalStrudelSandboxed } from "../src/shared/strudel-eval";

function harness() {
  let deliverTap: ((x: number, y: number) => void) | null = null;
  const errors: Array<[string, unknown]> = [];
  const changes: Array<{ name: string; by: string; text: string; cycle: number | null }> = [];
  const stateChanged = vi.fn();
  const env: StageEnv = {
    audibleCycle: () => 2,
    isPlaying: () => true,
    requestFrame: () => 1,
    cancelFrame: () => {},
    listenTaps: (deliver) => {
      deliverTap = deliver;
      return () => {
        deliverTap = null;
      };
    },
    reportError: (api, err) => void errors.push([api, err]),
    now: () => 1000,
    observeRemembered: (c) => void changes.push(c),
    observeRememberedState: stateChanged,
  };
  const stage = createStage(env);
  const g = stage.globals as any;
  return {
    stage,
    g,
    errors,
    changes,
    stateChanged,
    run(piece: () => void, options?: { deferState?: boolean }) {
      const token = stage.begin();
      piece();
      stage.commit(token, options);
      return token;
    },
    tap: (x = 0.5, y = 0.5) => deliverTap?.(x, y),
    json: (name: string) => stage.remembered().find((e) => e.name === name)?.json,
  };
}

describe("no preview: reads, writes and merges agree", () => {
  it("B1 a top-level write builds on the stored value and the merge applies on top: n.set(n.value + 1) → 11, not 21", () => {
    const h = harness();
    h.run(() => {
      h.g.remember("n", 0);
    });
    let n: any;
    const token = h.run(() => {
      n = h.g.remember("n", 0, { merge: (v: number) => v + 10 });
      n.set(n.value + 1);
    }, { deferState: true });
    h.stage.activateState(token);
    expect(n.value).toBe(11);
  });

  it("B2 nothing a failed transaction would have stored is ever visible", () => {
    const h = harness();
    let a: any;
    h.run(() => {
      a = h.g.remember("a", 0);
      h.g.remember("b", 0);
    });
    const token = h.run(() => {
      a = h.g.remember("a", 0, { merge: () => 10 });
      h.g.remember("b", 0, {
        merge: () => {
          throw new Error("bad merge");
        },
      });
    }, { deferState: true });
    expect(a.value).toBe(0); // before the bar
    h.stage.activateState(token);
    expect(a.value).toBe(0); // the whole evaluation's state was discarded
    expect(h.errors.some(([api]) => api === "remember")).toBe(true);
  });

  it("B3 a merge runs exactly once — at activation — however often the value is read or the store changes", () => {
    const h = harness();
    let calls = 0;
    let other: any;
    h.run(() => {
      h.g.remember("n", 0);
      other = h.g.remember("o", 0);
    });
    let n: any;
    const token = h.run(() => {
      n = h.g.remember("n", 0, { merge: () => ++calls });
      other = h.g.remember("o", 0);
      h.g.onTap(() => other.set(1));
    }, { deferState: true });
    for (let i = 0; i < 5; i++) void n.value;
    h.tap(); // an unrelated write before the bar
    expect(h.json("o")).toBe("1");
    void n.value;
    expect(calls).toBe(0);
    h.stage.activateState(token);
    expect(calls).toBe(1);
    expect(n.value).toBe(1);
  });
});

describe("write authority", () => {
  it("B4 a rollback never hands writing back to an evaluation whose state was discarded", () => {
    const h = harness();
    let one: any;
    let two: any;
    h.run(() => {
      one = h.g.remember("n", 0);
    });
    h.run(() => {
      two = h.g.remember("n", 0);
    }, { deferState: true });
    const three = h.run(() => {
      h.g.remember("n", 0);
    }); // applies now: 2's swap never plays
    h.stage.rollback(three);
    two.set(22);
    expect(h.json("n")).toBe("0");
    one.set(11);
    expect(h.json("n")).toBe("11");
  });

  it("B4 a newer run that fails does not cancel a swap still waiting for its bar — its state lands with its pattern", () => {
    const h = harness();
    h.run(() => {
      h.g.remember("n", 0);
    });
    let two: any;
    const token = h.run(() => {
      two = h.g.remember("n", 0, { merge: () => 5 });
    }, { deferState: true });
    const three = h.stage.begin();
    h.g.remember("n", 0, { merge: () => 9 });
    h.stage.rollback(three); // the newer run failed
    h.stage.activateState(token); // 2's bar
    expect(two.value).toBe(5);
    two.set(6); // 2's callbacks are the live ones
    expect(two.value).toBe(6);
  });

  it("B4 of two swaps waiting, a newer one whose bar comes first drops the older", () => {
    const h = harness();
    h.run(() => {
      h.g.remember("n", 0);
    });
    let two: any;
    const t2 = h.run(() => {
      two = h.g.remember("n", 0, { merge: () => 2 });
    }, { deferState: true });
    const t3 = h.run(() => {
      h.g.remember("n", 0, { merge: () => 3 });
    }, { deferState: true });
    h.stage.activateState(t3);
    h.stage.activateState(t2); // superseded: never plays
    expect(two.value).toBe(3);
    two.set(4); // and its handles no longer write
    expect(h.json("n")).toBe("3");
  });

  it("#7 a merge can't declare remembered state: the whole transaction is discarded", () => {
    const h = harness();
    h.run(() => {
      h.g.remember("n", 0, {
        merge: () => {
          h.g.remember("leaked", 7);
          return 1;
        },
      });
    });
    expect(h.stage.remembered().map((e) => e.name)).toEqual([]);
    expect(h.errors.some(([api, err]) => api === "remember" && /can't declare/.test(String((err as Error)?.message)))).toBe(true);
  });
});

describe("names declared in callbacks of a swap still waiting for its bar", () => {
  it(`B5 count toward THAT piece's ${MAX_REMEMBER_PER_EVALUATION} names, wait for its bar, and are its own names after it`, () => {
    const h = harness();
    h.run(() => {
      h.g.remember("old", 0);
    });
    const token = h.run(() => {
      for (let i = 0; i < MAX_REMEMBER_PER_EVALUATION - 1; i++) h.g.remember(`top${i}`, i);
      h.g.onTap(() => {
        h.g.remember("late", 1);
        h.g.remember("late2", 2);
      });
    }, { deferState: true });
    h.tap();
    expect(h.errors.some(([, err]) => err instanceof RangeError)).toBe(true); // the 9th name
    expect(h.stage.remembered().map((e) => e.name)).toEqual(["old"]); // nothing before the bar
    h.stage.activateState(token);
    expect(h.stage.remembered().find((e) => e.name === "late")?.declared).toBe(true); // not "kept from earlier code"
    expect(h.stage.remembered().find((e) => e.name === "late2")).toBeUndefined();
    expect(h.stage.remembered().find((e) => e.name === "old")?.declared).toBe(false);
  });
});

describe("the snapshot hears every change", () => {
  it("B7 a name the piece stopped declaring notifies the snapshot (declared: true → false)", () => {
    const h = harness();
    h.run(() => {
      h.g.remember("a", 1);
      h.g.remember("b", 2);
    });
    h.stateChanged.mockClear();
    h.run(() => {
      h.g.remember("a", 1); // unchanged
    });
    expect(h.stage.remembered().find((e) => e.name === "b")?.declared).toBe(false);
    expect(h.stateChanged).toHaveBeenCalled();
  });
});

describe("the validator's ceiling covers merges", () => {
  it("B6 a merge that loops is cut off by the vm timeout, not run to completion", async () => {
    const code =
      "remember('n', 0, { merge: () => { const t = Date.now(); while (Date.now() - t < 600) {} return 1 } })\n" +
      's("bd")';
    const started = Date.now();
    const { error } = await evalStrudelSandboxed(code, { timeoutMs: 80 });
    expect(Date.now() - started).toBeLessThan(500);
    expect(String((error as Error)?.message ?? error)).toMatch(/timed out/i);
  });
});
