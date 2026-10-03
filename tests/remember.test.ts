// remember() — named state that survives re-runs (src/shared/remember-store.ts,
// wired into src/shared/stage-runtime.ts and the validator in strudel-eval.ts).
// Contract: .claude/designs/remember.md (BUILD CONTRACT). Every rule below came
// from the Codex + Kimi design review (2026-10-03).
import { describe, expect, it, vi } from "vitest";
import { createStage, type StageEnv } from "../src/shared/stage-runtime";
import {
  freezeJson,
  MAX_REMEMBER_JSON,
  MAX_REMEMBER_NAMES,
  MAX_REMEMBER_PER_EVALUATION,
} from "../src/shared/remember-store";
import { evalStrudelSandboxed, queryHaps } from "../src/shared/strudel-eval";
import { validateStrudelInProcess } from "../src/shared/strudel-validate-core";

function harness(overrides: Partial<StageEnv> = {}) {
  const frames = new Map<number, (ms: number) => void>();
  let nextId = 1;
  let ms = 0;
  let clock = 1000;
  let deliverTap: ((x: number, y: number) => void) | null = null;
  const errors: Array<[string, unknown]> = [];
  const changes: Array<{ name: string; by: string; text: string; cycle: number | null }> = [];
  const taps: Array<{ changedState: boolean | undefined }> = [];
  const order: string[] = [];
  const stateChanged = vi.fn();
  const requestStage = vi.fn();
  const env: StageEnv = {
    audibleCycle: () => 2,
    isPlaying: () => true,
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
    now: () => clock,
    observeRemembered: (c) => {
      order.push("remembered");
      changes.push(c);
    },
    observeRememberedState: stateChanged,
    observeTap: (_t, info) => {
      order.push("tap");
      taps.push({ changedState: info?.changedState });
    },
    requestStage,
    ...overrides,
  };
  const stage = createStage(env);
  const g = stage.globals;
  return {
    stage,
    g,
    errors,
    changes,
    taps,
    order,
    stateChanged,
    requestStage,
    /** Run a piece as the widget's evaluate hook does: begin → top level → commit. */
    run(piece: () => void, options?: { deferState?: boolean }) {
      const token = stage.begin();
      piece();
      stage.commit(token, options);
      return token;
    },
    frame() {
      ms += 16;
      const pending = [...frames.values()];
      frames.clear();
      for (const cb of pending) cb(ms);
    },
    tap: (x = 0.5, y = 0.5) => deliverTap?.(x, y),
    tick: (n: number) => {
      clock += n;
    },
  };
}

const GRID = { kick: [1, 0, 0, 0], snare: [0, 0, 1, 0] };

describe("remember() — persistence across evaluations", () => {
  it("keeps the stored value when the same piece runs again", () => {
    const h = harness();
    let d: any;
    h.run(() => {
      d = h.g.remember("drums", GRID);
      h.g.onTap(() => d.update((v: any) => { v.kick[1] = 1 }, "kick on step 2"));
    });
    expect(d.value).toEqual(GRID);
    h.tap();
    expect(d.value.kick).toEqual([1, 1, 0, 0]);
    let d2: any;
    h.run(() => {
      d2 = h.g.remember("drums", GRID);
    });
    expect(d2.value.kick).toEqual([1, 1, 0, 0]); // the listener's step survived the re-run
  });

  it("resets to init when the version changes, or the top-level type does", () => {
    const h = harness();
    let d: any;
    h.run(() => {
      d = h.g.remember("drums", GRID, { version: 1 });
      d.set({ kick: [0, 0, 0, 1], snare: [0, 0, 0, 0] });
    });
    expect(d.value.kick).toEqual([0, 0, 0, 1]);
    h.run(() => {
      d = h.g.remember("drums", GRID, { version: 2 });
    });
    expect(d.value).toEqual(GRID);
    h.run(() => {
      d = h.g.remember("drums", [1, 2, 3], { version: 2 });
    });
    expect(d.value).toEqual([1, 2, 3]);
  });

  it("a failed (rolled back) evaluation changes nothing — not a reset, not a top-level write, not a new name", () => {
    const h = harness();
    let d: any;
    h.run(() => {
      d = h.g.remember("drums", GRID, { version: 1 });
    });
    const token = h.stage.begin();
    h.g.remember("drums", { other: true }, { version: 9 }).set({ other: false });
    h.g.remember("fresh", 1);
    h.stage.rollback(token);
    expect(d.value).toEqual(GRID);
    expect(h.stage.remembered().map((e) => e.name)).toEqual(["drums"]);
  });

  it("stop() clears the store, and later writes are dropped", () => {
    const h = harness();
    let d: any;
    h.run(() => {
      d = h.g.remember("drums", GRID);
    });
    h.stage.stop();
    expect(h.stage.remembered()).toEqual([]);
    d.set({ kick: [0], snare: [0] });
    expect(h.stage.remembered()).toEqual([]);
  });
});

describe("remember() — merges: the AI's targeted edit, once", () => {
  const mergeHat = { merge: (v: any) => { v.snare[3] = 1 }, label: "snare on step 4" };

  it("applies a merge once per (source, label, version): the same code re-run does not re-apply it", () => {
    const h = harness();
    let d: any;
    h.run(() => {
      d = h.g.remember("drums", GRID, mergeHat);
    });
    expect(d.value.snare).toEqual([0, 0, 1, 1]);
    // The listener takes the AI's snare away again…
    d.set({ ...d.value, snare: [0, 0, 1, 0] });
    // …and re-runs the same code: the merge is not applied a second time.
    h.run(() => {
      d = h.g.remember("drums", GRID, mergeHat);
    });
    expect(d.value.snare).toEqual([0, 0, 1, 0]);
    // A NEW merge applies.
    h.run(() => {
      d = h.g.remember("drums", GRID, { merge: (v: any) => { v.kick[2] = 1 }, label: "kick on step 3" });
    });
    expect(d.value.kick).toEqual([1, 0, 1, 0]);
    expect(h.changes.filter((c) => c.by === "ai").map((c) => c.text)).toEqual(["snare on step 4", "kick on step 3"]);
  });

  it("a merge may return a new value instead of mutating the draft", () => {
    const h = harness();
    let d: any;
    h.run(() => {
      d = h.g.remember("n", 1, { merge: (v: number) => v + 1 });
    });
    expect(d.value).toBe(2);
  });

  it("a merge that throws, returns bad JSON or changes the type discards ALL of the evaluation's state ops", () => {
    const h = harness();
    let a: any;
    let b: any;
    h.run(() => {
      a = h.g.remember("a", { x: 1 });
      b = h.g.remember("b", { y: 1 });
    });
    for (const bad of [
      () => { throw new Error("boom") },
      () => Number.NaN,
      () => [1, 2],
      async (v: any) => v,
    ]) {
      h.run(() => {
        a = h.g.remember("a", { x: 1 }, { merge: (v: any) => { v.x = 2 } });
        b = h.g.remember("b", { y: 1 }, { merge: bad as any });
      });
      expect(a.value).toEqual({ x: 1 }); // a's merge was discarded too
      expect(b.value).toEqual({ y: 1 });
    }
    expect(h.errors.filter(([api]) => api === "remember")).toHaveLength(4);
  });
});

describe("remember() — transactions at the swap's bar", () => {
  it("deferred state is stored only at activateState: until the bar every handle reads what is playing", () => {
    const h = harness();
    let old: any;
    h.run(() => {
      old = h.g.remember("drums", GRID);
    });
    let next: any;
    const token = h.run(() => {
      next = h.g.remember("drums", GRID, { merge: (v: any) => { v.kick[3] = 1 } });
    }, { deferState: true });
    expect(old.value.kick).toEqual([1, 0, 0, 0]);
    // No preview (Codex review, round 2): the new pattern is first queried at
    // the bar, after activation — splice.ts splits that query.
    expect(next.value.kick).toEqual([1, 0, 0, 0]);
    expect(h.stage.remembered()[0].json).toBe('{"kick":[1,0,0,0],"snare":[0,0,1,0]}');
    h.stage.activateState(token);
    expect(next.value.kick).toEqual([1, 0, 0, 1]);
    expect(old.value.kick).toEqual([1, 0, 0, 1]); // one store: everyone hears the bar's state
  });

  it("a merge applied at the swap's bar reports that bar, not the clock's lookahead", () => {
    const h = harness();
    h.run(() => {
      h.g.remember("drums", GRID);
    });
    const token = h.run(() => {
      h.g.remember("drums", GRID, { merge: (v: any) => { v.kick[3] = 1 }, label: "kick on 4" });
    }, { deferState: true });
    h.stage.activateState(token, 8);
    const ai = h.changes.filter((c) => c.by === "ai");
    expect(ai).toHaveLength(1);
    expect(ai[0]).toMatchObject({ text: "kick on 4", cycle: 8 });
  });

  it("listener writes between commit and activation survive the merge (it applies to the latest value)", () => {
    const h = harness();
    let d: any;
    h.run(() => {
      d = h.g.remember("drums", GRID);
    });
    const token = h.run(() => {
      d = h.g.remember("drums", GRID, { merge: (v: any) => { v.snare[0] = 1 } });
      h.g.onTap(() => d.update((v: any) => { v.kick[2] = 1 }, "kick on step 3"));
    }, { deferState: true });
    h.tap(); // the swap's bar hasn't come yet
    h.stage.activateState(token);
    expect(d.value).toEqual({ kick: [1, 0, 1, 0], snare: [1, 0, 1, 0] });
  });

  it("a newer evaluation supersedes one whose state never reached its bar", () => {
    const h = harness();
    let d: any;
    h.run(() => {
      d = h.g.remember("drums", GRID);
    });
    const stale = h.run(() => {
      d = h.g.remember("drums", GRID, { merge: (v: any) => { v.kick[3] = 1 } });
    }, { deferState: true });
    h.run(() => {
      d = h.g.remember("drums", GRID);
    });
    h.stage.activateState(stale);
    expect(d.value.kick).toEqual([1, 0, 0, 0]);
  });

  it("rollback of a committed-but-deferred evaluation drops its staged state", () => {
    const h = harness();
    let d: any;
    const token = h.run(() => {
      d = h.g.remember("drums", GRID, { merge: (v: any) => { v.kick[3] = 1 } });
    }, { deferState: true });
    h.stage.rollback(token);
    h.stage.activateState(token);
    expect(d.value.kick).toEqual([1, 0, 0, 0]);
    expect(h.stage.remembered()).toEqual([]);
  });

  it("top-level writes are staged with their evaluation; its merge applies on top of them, at the bar", () => {
    const h = harness();
    let d: any;
    const token = h.run(() => {
      d = h.g.remember("n", { v: 1 }, { merge: (x: any) => { x.v += 10 } });
      d.update((x: any) => { x.v += 1 });
      expect(d.value).toEqual({ v: 1 }); // reads what is stored (nothing yet: init) — no preview
    }, { deferState: true });
    expect(h.stage.remembered()).toEqual([]); // nothing stored before the bar
    h.stage.activateState(token);
    expect(d.value).toEqual({ v: 12 }); // init 1 → the piece's write 2 → the merge +10
  });

  it("a retired evaluation's leftover callback cannot write into its replacement's state", () => {
    const h = harness();
    let old: any;
    h.run(() => {
      old = h.g.remember("drums", GRID);
    });
    let d: any;
    h.run(() => {
      d = h.g.remember("drums", GRID);
    });
    old.set({ kick: [0, 0, 0, 0], snare: [0, 0, 0, 0] });
    expect(d.value).toEqual(GRID);
  });
});

describe("remember() — who changed it", () => {
  it("a write inside a tap is the listener's: one event with its label, and the tap is marked changedState (observed AFTER the callback)", () => {
    const h = harness();
    let d: any;
    h.run(() => {
      d = h.g.remember("drums", GRID, { describe: (v: any) => `kicks: ${v.kick.join("")}` });
      h.g.onTap(() => d.update((v: any) => { v.kick[1] = 1 }, (v: any) => `kick ${v.kick[1] ? "on" : "off"} step 2`));
    });
    h.tap();
    expect(h.changes).toEqual([{ name: "drums", by: "listener", text: "kick on step 2", cycle: 2 }]);
    expect(h.taps).toEqual([{ changedState: true }]);
    expect(h.order).toEqual(["remembered", "tap"]);
    // Without a label, the describe() text stands in.
    h.run(() => {
      d = h.g.remember("drums", GRID, { describe: (v: any) => `kicks: ${v.kick.join("")}` });
      h.g.onTap(() => d.update((v: any) => { v.kick[2] = 1 }));
    });
    h.tap();
    expect(h.changes.at(-1)?.text).toBe("kicks: 1110");
  });

  it("a tap that writes nothing is a plain tap", () => {
    const h = harness();
    h.run(() => {
      h.g.remember("drums", GRID);
      h.g.onTap(() => undefined);
    });
    h.tap();
    expect(h.taps).toEqual([{ changedState: false }]);
    expect(h.changes).toEqual([]);
  });

  it("writes from onFrame and from an async continuation of a tap are the piece's: no event, only the snapshot moves", async () => {
    const h = harness();
    let d: any;
    h.run(() => {
      d = h.g.remember("n", 0);
      h.g.onFrame(() => d.set(d.value + 1));
      h.g.onTap(async () => {
        await Promise.resolve();
        d.set(100);
      });
    });
    h.stateChanged.mockClear();
    h.frame();
    h.tap();
    await Promise.resolve();
    await Promise.resolve();
    expect(d.value).toBe(100);
    expect(h.changes).toEqual([]);
    expect(h.taps).toEqual([{ changedState: false }]);
    expect(h.stateChanged).toHaveBeenCalledTimes(2);
  });

  it("remembered() lists json, describe text and a per-name revision", () => {
    const h = harness();
    let d: any;
    h.run(() => {
      d = h.g.remember("drums", [0, 0], { describe: (v: number[]) => `${v.filter(Boolean).length} on` });
    });
    h.tick(500);
    d.set([1, 0]);
    expect(h.stage.remembered()).toEqual([{ name: "drums", json: "[1,0]", text: "1 on", rev: 2, at: 1500, declared: true }]);
  });
});

describe("remember() — values are frozen JSON", () => {
  it("throws on a write to .value (strict mode), and reads return the same object until it changes", () => {
    const h = harness();
    let d: any;
    h.run(() => {
      d = h.g.remember("drums", GRID);
    });
    expect(() => {
      d.value.kick[0] = 0;
    }).toThrow(TypeError);
    expect(() => {
      d.value.extra = 1;
    }).toThrow(TypeError);
    expect(d.value).toBe(d.value);
    // The caller's object is copied, never adopted.
    const mine = { kick: [1] };
    h.run(() => {
      d = h.g.remember("mine", mine);
    });
    mine.kick[0] = 9;
    expect(d.value.kick[0]).toBe(1);
  });

  it("refuses what isn't JSON, and what is too deep or too big", () => {
    expect(() => freezeJson(Number.NaN, "t")).toThrow(TypeError);
    expect(() => freezeJson(Infinity, "t")).toThrow(TypeError);
    expect(() => freezeJson({ f: () => 1 }, "t")).toThrow(TypeError);
    expect(() => freezeJson(undefined, "t")).toThrow(TypeError);
    expect(() => freezeJson(new Map(), "t")).toThrow(TypeError);
    expect(() => freezeJson(new Date(), "t")).toThrow(TypeError);
    expect(() => freezeJson(new (class Point { x = 1 })(), "t")).toThrow(TypeError);
    expect(() => freezeJson([1, , 3], "t")).toThrow(TypeError); // eslint-disable-line no-sparse-arrays
    expect(() => freezeJson(1n, "t")).toThrow(TypeError);
    let deep: unknown = 1;
    for (let i = 0; i < 9; i++) deep = [deep];
    expect(() => freezeJson(deep, "t")).toThrow(RangeError);
    const circular: any = { a: 1 };
    circular.self = circular;
    expect(() => freezeJson(circular, "t")).toThrow(RangeError);
    expect(() => freezeJson("x".repeat(MAX_REMEMBER_JSON + 1), "t")).toThrow(RangeError);
    expect(() => freezeJson(Array(3000).fill(1), "t")).toThrow(RangeError);
    expect(freezeJson({ __proto__x: 1, n: null, ok: [true, "s", 1.5] }, "t").json).toBe('{"__proto__x":1,"n":null,"ok":[true,"s",1.5]}');
    // A key named __proto__ (as JSON.parse makes it) stays a key.
    const v = freezeJson(JSON.parse('{"__proto__": {"x": 1}}'), "t");
    expect(v.json).toBe('{"__proto__":{"x":1}}');
    expect(Object.getPrototypeOf(v.value)).toBe(Object.prototype);
  });

  it("set/update must keep the init's top-level type, and update must be synchronous", () => {
    const h = harness();
    let d: any;
    h.run(() => {
      d = h.g.remember("drums", GRID);
      h.g.onTap(() => undefined);
    });
    expect(() => d.set([1])).toThrow(TypeError);
    expect(() => d.update(async (v: any) => v)).toThrow(TypeError);
    expect(() => d.update("nope")).toThrow(TypeError);
    expect(d.value).toEqual(GRID);
  });
});

describe("remember() — names and bounds", () => {
  it(`at most ${MAX_REMEMBER_PER_EVALUATION} names per piece, each declared once`, () => {
    const h = harness();
    const token = h.stage.begin();
    for (let i = 0; i < MAX_REMEMBER_PER_EVALUATION; i++) h.g.remember(`s${i}`, i);
    expect(() => h.g.remember("one-more", 0)).toThrow(RangeError);
    expect(() => h.g.remember("s0", 0)).toThrow(/declared twice/);
    h.stage.rollback(token);
  });

  it(`keeps at most ${MAX_REMEMBER_NAMES} names, evicting ones the piece no longer declares`, () => {
    const h = harness();
    for (let round = 0; round < 5; round++) {
      h.run(() => {
        for (let i = 0; i < 6; i++) h.g.remember(`r${round}-${i}`, i);
      });
    }
    const names = h.stage.remembered().map((e) => e.name);
    expect(names.length).toBeLessThanOrEqual(MAX_REMEMBER_NAMES);
    for (let i = 0; i < 6; i++) expect(names).toContain(`r4-${i}`); // the committed piece's own names stay
  });

  it("shares one namespace with the controls: the same name in one piece is an error, either way round", () => {
    const h = harness();
    let token = h.stage.begin();
    h.g.fader("rain");
    expect(() => h.g.remember("rain", 0)).toThrow(/already a control/);
    h.stage.rollback(token);
    token = h.stage.begin();
    h.g.remember("rain", 0);
    expect(() => h.g.fader("rain")).toThrow(/already a remember\(\) name/);
    h.stage.rollback(token);
  });

  it("needs a name, and an options object with function describe/merge and a string or number version", () => {
    const h = harness();
    const token = h.stage.begin();
    expect(() => h.g.remember("", 1)).toThrow(TypeError);
    expect(() => h.g.remember("a", 1, "x" as any)).toThrow(TypeError);
    expect(() => h.g.remember("b", 1, { describe: "x" as any })).toThrow(TypeError);
    expect(() => h.g.remember("c", 1, { merge: 1 as any })).toThrow(TypeError);
    expect(() => h.g.remember("d", 1, { version: {} as any })).toThrow(TypeError);
    h.stage.rollback(token);
  });
});

describe("openStage()", () => {
  it("asks once per committed evaluation, never for a failed one", () => {
    const h = harness();
    h.run(() => {
      h.g.openStage();
      h.g.openStage();
    });
    expect(h.requestStage).toHaveBeenCalledTimes(1);
    h.g.openStage(); // from a callback of the same piece: already asked
    expect(h.requestStage).toHaveBeenCalledTimes(1);
    const token = h.stage.begin();
    h.g.openStage();
    h.stage.rollback(token);
    expect(h.requestStage).toHaveBeenCalledTimes(1);
    h.run(() => h.g.openStage());
    expect(h.requestStage).toHaveBeenCalledTimes(2);
    h.run(() => undefined);
    h.g.openStage(); // a piece that asks from a tap, after its run
    expect(h.requestStage).toHaveBeenCalledTimes(3);
  });
});

describe("remember() through the real transpiler and the validator", () => {
  it("evaluates with Strudel's transpiler untouched: double-quoted name and one-word value, merge applied before the pattern is queried", async () => {
    const { pattern, error } = await evalStrudelSandboxed(`
      const d = remember("notes", { n: 60, mode: "up" }, { merge: v => { v.n = 64 }, label: 'up a third' })
      note(signal(() => d.value.mode === 'up' ? d.value.n : 0).segment(1))
    `);
    expect(error).toBeUndefined();
    const { haps } = queryHaps(pattern, 1);
    expect(haps.map((h: any) => h.value.note)).toEqual([64]);
  });

  it("validates like the widget: bad JSON, a name clash and a duplicate are errors; a failing merge is a warning", async () => {
    const validate = (code: string) => validateStrudelInProcess(code, { timeoutMs: 8000 });
    expect((await validate(`remember('x', { f: () => 1 })\ns("bd")`)).error?.message).toMatch(/isn't JSON/);
    expect((await validate(`fader('x')\nremember('x', 0)\ns("bd")`)).error?.message).toMatch(/already a control/);
    expect((await validate(`remember('x', 0)\nremember('x', 1)\ns("bd")`)).error?.message).toMatch(/declared twice/);
    expect((await validate(`remember('x', { a: "two words" })\ns("bd")`)).error?.message).toMatch(/single quotes/);
    const merged = await validate(`
      openStage()
      const d = remember('x', { n: 1 }, { merge: v => { throw new Error('nope') } })
      s("bd")
    `);
    expect(merged.ok).toBe(true);
    expect(merged.warnings?.join(" ")).toMatch(/remember: a merge failed/);
    // A frozen value written to in a test frame is a warning (the widget reports it once).
    const frozen = await validate(`
      const d = remember('grid', [0, 0])
      onFrame(() => { d.value[0] = 1 })
      s("bd")
    `);
    expect(frozen.ok).toBe(true);
    expect(frozen.warnings?.join(" ")).toMatch(/onFrame callback threw/);
  });

  it("a fresh store per validation run", async () => {
    const code = `
      const d = remember('count', 0)
      onFrame(() => d.set(d.value + 1))
      note(signal(() => 60 + d.value).segment(1))
    `;
    const a = await evalStrudelSandboxed(code);
    const b = await evalStrudelSandboxed(code);
    expect(queryHaps(a.pattern, 1).haps[0].value.note).toBe(61);
    expect(queryHaps(b.pattern, 1).haps[0].value.note).toBe(61);
  });
});
