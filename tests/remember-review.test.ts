// remember() — the Codex + Kimi review of the 0.11 branch (2026-10-03). Each
// test reproduces one finding; the numbers are the review's.
import { describe, expect, it, vi } from "vitest";
import { sequence, signal, stack } from "@strudel/core";
import { createStage, type StageEnv } from "../src/shared/stage-runtime";
import { createRememberStore, freezeJson, MAX_REMEMBER_PER_EVALUATION } from "../src/shared/remember-store";
import { spliceAt } from "../src/shared/splice";
import { evalStrudelSandboxed, queryHaps } from "../src/shared/strudel-eval";
import { validateStrudelInProcess } from "../src/shared/strudel-validate-core";
import { STRUDEL_GALLERY } from "../src/strudel-gallery";
import { STAGE_GUIDES } from "../src/strudel-guide-stage";

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

const onsets = (pat: any, b: number, e: number) =>
  pat.queryArc(b, e).filter((h: any) => h.hasOnset()).map((h: any) => `${Number(h.whole.begin)}:${h.value}`);

describe("#1 a pattern hears its own state from its first query", () => {
  it("activateStateNow (the widget calls it from scheduler.setPattern) stores the state before a stopped player's first query", () => {
    const h = harness();
    h.run(() => {
      h.g.remember("n", 60);
    });
    const token = h.stage.begin();
    const d = h.g.remember("n", 60, { merge: () => 72 });
    expect(d.value).toBe(60); // the evaluation reads what is playing — no preview
    // repl.evaluate → scheduler.setPattern(pattern, autostart): the hook runs first…
    h.stage.activateStateNow(token);
    // …then the Cyclist starts and queries, still inside the evaluation:
    const pat = signal(() => d.value).segment(4);
    expect(onsets(pat, 0, 0.5)).toEqual(["0:72", "0.25:72"]);
    h.stage.commit(token); // does not apply it again
    expect(d.value).toBe(72);
    expect(h.changes.filter((c) => c.by === "ai")).toHaveLength(1); // the merge ran and was logged once
  });

  it("a later commit of the same evaluation is a no-op for its state, and its handles keep writing", () => {
    const h = harness();
    let d: any;
    const token = h.stage.begin();
    d = h.g.remember("n", 1);
    h.g.onTap(() => d.update((v: number) => v + 1, "plus one"));
    h.stage.activateStateNow(token);
    h.stage.commit(token);
    h.tap();
    expect(d.value).toBe(2);
    expect(h.stage.remembered().find((e) => e.name === "n")?.json).toBe("2");
  });

  it("activateStateNow is ignored for an evaluation that is no longer the running one", () => {
    const h = harness();
    const stale = h.stage.begin();
    h.g.remember("n", 1, { merge: () => 5 });
    const newer = h.stage.begin();
    h.g.remember("n", 1);
    h.stage.activateStateNow(stale);
    expect(h.stage.remembered()).toEqual([]);
    h.stage.commit(newer);
    expect(h.stage.remembered().find((e) => e.name === "n")?.json).toBe("1");
  });
});

describe("#3 the swap's bar: old notes old state, new notes new state", () => {
  it("a query crossing the bar plays the old value before it and the merged value from it", () => {
    const h = harness();
    let old: any;
    h.run(() => {
      old = h.g.remember("n", 0);
    });
    const oldPat = signal(() => old.value).segment(16);
    let next: any;
    let activate = () => {};
    const token = h.run(() => {
      next = h.g.remember("n", 0, { merge: () => 9 });
    }, { deferState: true });
    activate = () => h.stage.activateState(token, 1);
    const newPat = signal(() => next.value).segment(16);
    const spliced = spliceAt(oldPat, newPat, 1, stack as any, -Infinity, activate);
    const got = onsets(spliced, 0.9, 1.1);
    expect(got).toContain("0.9375:0"); // before the bar: still the old state
    expect(got).toContain("1:9"); // on the bar: the merged state
    expect(old.value).toBe(9); // and it has been stored
  });

  it("the hook fires once, after the first query that reaches past the bar", () => {
    const calls: string[] = [];
    const spliced = spliceAt(sequence("a", "a"), sequence("b", "b"), 1, stack as any, -Infinity, () => calls.push("hook"));
    spliced.queryArc(0, 1);
    expect(calls).toEqual([]);
    spliced.queryArc(0.9, 1.1);
    expect(calls).toEqual(["hook"]);
    spliced.queryArc(1.1, 2);
    expect(calls).toEqual(["hook"]);
  });
});

describe("#2 a write while a reset waits for its bar", () => {
  it("a refused write changes nothing; an accepted one waits with the reset", () => {
    const h = harness();
    let v1: any;
    h.run(() => {
      v1 = h.g.remember("n", 0, { version: 1 });
      h.g.onTap(() => v1.set(7));
    });
    h.tap();
    expect(v1.value).toBe(7);
    let v2: any;
    let next = Number.NaN;
    const token = h.run(() => {
      v2 = h.g.remember("n", 10, { version: 2 });
      h.g.onTap(() => v2.set(next));
    }, { deferState: true });
    h.tap(); // refused (NaN isn't JSON)
    expect(h.stage.remembered().find((e) => e.name === "n")?.json).toBe("7"); // untouched
    expect(v1.value).toBe(7); // the old pattern still reads the stored value
    next = 11;
    h.tap(); // accepted: it waits for the bar with the reset
    expect(v1.value).toBe(7);
    expect(v2.value).toBe(10); // nothing previewed: the stored value isn't v2's, so its init
    expect(h.stage.remembered().find((e) => e.name === "n")?.json).toBe("7");
    h.stage.activateState(token);
    expect(v2.value).toBe(11);
    expect(h.stage.remembered().find((e) => e.name === "n")?.json).toBe("11");
  });
});

describe("#6 a rolled-back deferred evaluation's handles", () => {
  it("cannot write", () => {
    const h = harness();
    let d: any;
    const token = h.run(() => {
      d = h.g.remember("n", 0);
    }, { deferState: true });
    h.stage.rollback(token);
    d.set(99);
    expect(h.stage.remembered()).toEqual([]);
  });
});

describe("#7 a merge can't write through a handle", () => {
  it("h.set inside a failing merge leaves no trace", () => {
    const h = harness();
    let d: any;
    h.run(() => {
      d = h.g.remember("n", 0);
    });
    h.run(() => {
      d = h.g.remember("n", 0, {
        merge: () => {
          d.set(123);
          throw new Error("fail");
        },
      });
    });
    expect(d.value).toBe(0);
    expect(h.stage.remembered().find((e) => e.name === "n")?.json).toBe("0");
    expect(h.errors.some(([api]) => api === "remember")).toBe(true);
  });
});

describe("#8 names declared inside callbacks", () => {
  it(`count toward the ${MAX_REMEMBER_PER_EVALUATION}-name limit and never evict the piece's own state`, () => {
    const h = harness();
    let top: any;
    h.run(() => {
      top = h.g.remember("top", 0);
      h.g.onTap(() => {
        for (let i = 0; i < 17; i++) h.g.remember("cb" + i, i);
      });
    });
    h.run(() => {
      top = h.g.remember("top", 0);
      h.g.onTap(() => {
        for (let i = 0; i < 17; i++) h.g.remember("cb" + i, i);
      });
    });
    top.set(99);
    h.tap();
    expect(top.value).toBe(99);
    expect(h.stage.remembered().length).toBeLessThanOrEqual(MAX_REMEMBER_PER_EVALUATION);
  });
});

describe("#9 a new description of the same value", () => {
  it("notifies the snapshot", () => {
    const h = harness();
    h.run(() => {
      h.g.remember("n", 1, { describe: () => "old" });
    });
    h.stateChanged.mockClear();
    h.run(() => {
      h.g.remember("n", 1, { describe: () => "new" });
    });
    expect(h.stage.remembered()[0].text).toBe("new");
    expect(h.stateChanged).toHaveBeenCalled();
  });
});

describe("K6 names the playing piece no longer declares", () => {
  it("are marked as kept from earlier code", () => {
    const h = harness();
    h.run(() => {
      h.g.remember("a", 1);
      h.g.remember("b", 2);
    });
    h.run(() => {
      h.g.remember("a", 1);
    });
    const byName = Object.fromEntries(h.stage.remembered().map((e) => [e.name, e.declared]));
    expect(byName).toEqual({ a: true, b: false });
  });
});

describe("K7 the size message names what it counts", () => {
  it("says parts, not characters, for a value with too many nodes", () => {
    expect(() => freezeJson(Array(5000).fill(0), "remember('n')")).toThrow(/more than 4096 parts/);
  });
});

describe("#10 the validator agrees with the widget on names first declared in callbacks", () => {
  it("applies them at once (not staged into an evaluation that never commits)", async () => {
    const code = `
      let h = null
      onFrame(() => { h = remember('lazy', 0, { merge: () => 99 }) })
      onEvent(s("bd"), () => { remember('lazy', 0, { merge: () => 99 }) })
      note(signal(() => (h ? h.value : 1)).segment(1))
    `;
    const result = await validateStrudelInProcess(code, { timeoutMs: 8000 });
    expect(result.ok).toBe(true);
    expect(result.warnings?.join(" ") ?? "").not.toMatch(/declared twice/);
    const { pattern } = await evalStrudelSandboxed(code);
    expect(queryHaps(pattern, 1).haps.map((x: any) => x.value.note)).toEqual([99]);
  });
});

describe("#4 every lit cell sounds", () => {
  const rowOnsets = (haps: any[], sound: string) =>
    haps.filter((x: any) => x.value.s === sound && x.hasOnset()).map((x: any) => Number(x.whole.begin)).sort((a, b) => a - b);
  const steps = (row: number[]) => row.flatMap((v, i) => (v ? [i / 8] : []));

  it("Trade a Beat plays each row's remembered steps", async () => {
    const piece = STRUDEL_GALLERY.find((p) => p.id === "trade-a-beat")!;
    const { pattern, error } = await evalStrudelSandboxed(piece.code);
    expect(error).toBeUndefined();
    const { haps } = queryHaps(pattern, 1);
    expect(rowOnsets(haps, "bd")).toEqual(steps([1, 0, 0, 0, 1, 0, 1, 0]));
    expect(rowOnsets(haps, "sd")).toEqual(steps([0, 0, 1, 0, 0, 0, 1, 0]));
    expect(rowOnsets(haps, "hh")).toEqual(steps([1, 1, 1, 1, 1, 1, 1, 1]));
    expect(rowOnsets(haps, "oh")).toEqual([]);
  });

  it("so does the guide's recipe", async () => {
    const text = (STAGE_GUIDES as Record<string, string>).interactive;
    const start = text.indexOf("await initHydra()\nconst ROWS");
    const end = text.indexOf("\n\n", text.indexOf("stack(...ROWS.map", start));
    const { pattern, error } = await evalStrudelSandboxed(text.slice(start, end));
    expect(error).toBeUndefined();
    const { haps } = queryHaps(pattern, 1);
    expect(rowOnsets(haps, "sd")).toEqual(steps([0, 0, 1, 0, 0, 0, 1, 0]));
    expect(rowOnsets(haps, "bd")).toEqual(steps([1, 0, 0, 0, 1, 0, 0, 0]));
  });
});

// The store itself, used directly (no stage): rollback semantics.
describe("createRememberStore", () => {
  it("exists for direct tests", () => {
    expect(typeof createRememberStore).toBe("function");
  });
});
