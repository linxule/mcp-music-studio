// remember() — Codex's round-3 review of the 0.11 fixes (2026-10-03). Each test
// reproduces one finding: early (setPattern-time) activation is provisional
// until the evaluation commits; replayed updates and staged sets are isolated;
// the splice hook survives query exceptions and settle(); the waiting-swap
// queue is bounded.
import { describe, expect, it, vi } from "vitest";
import { Pattern, State, TimeSpan, signal, stack } from "@strudel/core";
import { createStage, type StageEnv } from "../src/shared/stage-runtime";
import { MAX_REMEMBER_WAITING } from "../src/shared/remember-store";
import { settle, spliceAt } from "../src/shared/splice";

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
  };
}

describe("P1 early activation is provisional until the evaluation commits", () => {
  it("a cancelled evaluation whose pattern was installed leaves no state and logs no merge", () => {
    const h = harness();
    let n: any;
    h.run(() => {
      n = h.g.remember("n", 60);
    });
    const token = h.stage.begin();
    n = h.g.remember("n", 60, { merge: () => 72, label: "up a fifth" });
    h.stage.activateStateNow(token); // setPattern: the new pattern is queried now
    expect(n.value).toBe(72);
    expect(h.changes.filter((c) => c.by === "ai")).toEqual([]); // not before it is confirmed
    h.stage.rollback(token); // cancelled during the rest of original()
    expect(n.value).toBe(60);
    expect(h.changes.filter((c) => c.by === "ai")).toEqual([]);
  });

  it("a committed one announces its merge once, at the commit", () => {
    const h = harness();
    h.run(() => {
      h.g.remember("n", 60);
    });
    const token = h.stage.begin();
    const n = h.g.remember("n", 60, { merge: () => 72, label: "up a fifth" });
    h.stage.activateStateNow(token);
    h.stage.commit(token);
    expect(n.value).toBe(72);
    expect(h.changes.filter((c) => c.by === "ai").map((c) => c.text)).toEqual(["up a fifth"]);
  });

  it("on rollback, a name the activation changed is restored (restore wins); other names keep later writes", () => {
    const h = harness();
    let a: any;
    let b: any;
    h.run(() => {
      a = h.g.remember("a", 1);
      b = h.g.remember("b", 1);
    });
    const token = h.stage.begin();
    const a2 = h.g.remember("a", 1, { merge: () => 5 });
    const b2 = h.g.remember("b", 1);
    h.stage.activateStateNow(token);
    a2.set(6); // same name the activation changed
    b2.set(7); // a name it did not change
    h.stage.rollback(token);
    expect(a.value).toBe(1);
    expect(b.value).toBe(7);
  });
});

describe("P2a replayed updates are isolated", () => {
  it("an update that writes another handle leaves no trace when the transaction fails", () => {
    const h = harness();
    let b: any;
    h.run(() => {
      h.g.remember("a", 0);
      b = h.g.remember("b", 0);
    });
    const token = h.run(() => {
      const a = h.g.remember("a", 0);
      b = h.g.remember("b", 0);
      a.update((v: number) => {
        b.set(99);
        return v + 1;
      });
      h.g.remember("c", 0, {
        merge: () => {
          throw new Error("bad merge");
        },
      });
    }, { deferState: true });
    h.stage.activateState(token);
    expect(b.value).toBe(0);
  });

  it("…and when it succeeds, each staged write lands once", () => {
    const h = harness();
    let a: any;
    let b: any;
    const token = h.run(() => {
      a = h.g.remember("a", 0);
      b = h.g.remember("b", 0);
      a.update((v: number) => {
        b.update((w: number) => w + 1);
        return v + 1;
      });
    }, { deferState: true });
    h.stage.activateState(token);
    expect(a.value).toBe(1);
    expect(b.value).toBe(1); // not 2: the replay of a's update does not write b again
  });
});

describe("P2b a staged set() stores the value it was given", () => {
  it("a caller mutating its object afterwards changes nothing", () => {
    const h = harness();
    let h1: any;
    const obj = { n: 1 };
    const token = h.run(() => {
      h1 = h.g.remember("h", { n: 0 });
      h1.set(obj);
    }, { deferState: true });
    obj.n = 99;
    h.stage.activateState(token);
    expect(h1.value).toEqual({ n: 1 });
  });
});

describe("P2c a query exception never re-runs the arc after the hook fired", () => {
  it("pre-bar notes never hear the new state, and the hook fires once", () => {
    let state = 0;
    let fires = 0;
    let thrown = false;
    const reader = signal(() => state).segment(16);
    const flaky = new (Pattern as any)((st: any) => {
      if (!thrown) {
        thrown = true;
        throw new Error("one-time");
      }
      return reader.query(st);
    });
    const hooked: any = spliceAt(reader, flaky, 1, stack, -Infinity, () => {
      fires++;
      state = 9;
    });
    const seen: string[] = [];
    for (const [b, e] of [[0.9, 1.1], [1.1, 1.3]] as const) {
      try {
        for (const hap of hooked.queryArc(b, e)) seen.push(`${Number(hap.whole.begin)}:${hap.value}`);
      } catch {
        /* the scheduler logs a query error and moves on */
      }
    }
    expect(fires).toBe(1);
    expect(seen.filter((s) => Number(s.split(":")[0]) < 1 && s.endsWith(":9"))).toEqual([]);
  });

  it("an exception in the pre-bar part leaves the hook unfired, and the next crossing query splits again", () => {
    let state = 0;
    let fires = 0;
    let thrown = false;
    const reader = signal(() => state).segment(16);
    const flakyOld = new (Pattern as any)((st: any) => {
      if (!thrown) {
        thrown = true;
        throw new Error("one-time");
      }
      return reader.query(st);
    });
    // Strudel's stack() swallows some child errors; a plain stack that lets
    // them through exercises the wrapper's own rule.
    const plainStack = (...pats: any[]) => new (Pattern as any)((st: any) => pats.flatMap((p) => p.query(st)));
    const hooked: any = spliceAt(flakyOld, reader, 1, plainStack as any, -Infinity, () => {
      fires++;
      state = 9;
    });
    // query(), not queryArc(): queryArc logs and swallows a query error (and
    // so does the scheduler's tick) — the wrapper's own behaviour is what counts.
    const q = (b: number, e: number) => hooked.query(new (State as any)(new (TimeSpan as any)(b, e)));
    expect(() => q(0.9, 1.1)).toThrow();
    expect(fires).toBe(0);
    const values = q(0.9, 1.1).map((hap: any) => `${Number(hap.whole.begin)}:${hap.value}`);
    expect(fires).toBe(1);
    expect(values).toContain("0.9375:0");
    expect(values).toContain("1:9");
  });
});

describe("#3 settle() never drops an unfired boundary hook", () => {
  it("settling past the bar before any crossing query fires the hook once", () => {
    let fires = 0;
    const reader = signal(() => 0).segment(4);
    const hooked: any = spliceAt(reader, reader, 2, stack, -Infinity, () => fires++);
    const settled = settle(hooked, 2.5);
    expect(settled).not.toBe(hooked);
    expect(fires).toBe(1);
    settle(hooked, 3);
    expect(fires).toBe(1);
  });
});

describe("P2d the waiting-swap queue is bounded", () => {
  it(`keeps the newest ${MAX_REMEMBER_WAITING} waiting swaps; an older one never activates or writes`, () => {
    const h = harness();
    let v: any;
    h.run(() => {
      v = h.g.remember("v", 0);
    });
    const tokens: number[] = [];
    const handles: any[] = [];
    for (let i = 1; i <= MAX_REMEMBER_WAITING + 5; i++) {
      tokens.push(
        h.run(() => {
          handles.push(h.g.remember("v", 0, { merge: () => i }));
        }, { deferState: true }),
      );
    }
    h.stage.activateState(tokens[0]); // dropped from the queue
    expect(v.value).toBe(0);
    handles[0].set(42);
    expect(v.value).toBe(0);
    h.stage.activateState(tokens[tokens.length - 1]);
    expect(v.value).toBe(MAX_REMEMBER_WAITING + 5);
  });
});
