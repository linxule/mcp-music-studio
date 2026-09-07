/**
 * A headless Strudel evaluator for the test suite.
 *
 * The guides tell an agent to write Strudel code. Name-level tests (guide-sounds,
 * guide-scales) prove the *identifiers* exist; they cannot see a block that
 * parses, resolves every name, and still produces ZERO events — e.g. passing a
 * Pattern where a transformation function is required. Only running the code and
 * querying it catches that.
 *
 * This is the real @strudel/core + @strudel/mini + @strudel/tonal + the real
 * transpiler, pinned to the versions @strudel/repl@1.3.0 depends on. What we do
 * NOT bring up: the scheduler, superdough/WebAudio, @strudel/draw and
 * @strudel/hydra (WebGL). Those are stubbed as no-ops, so a pattern's *timing and
 * values* are certified here while its *audio* is not.
 */
import * as core from "@strudel/core";
import * as mini from "@strudel/mini";
import * as tonal from "@strudel/tonal";
import { transpiler } from "@strudel/transpiler";

type Any = Record<string, any>;
const C = core as Any;

/** Draw methods live in @strudel/draw (canvas/WebGL). No-op them onto Pattern. */
export const DRAW_METHODS = [
  "pianoroll",
  "punchcard",
  "scope",
  "spectrum",
  "spiral",
  "pitchwheel",
  "wordfall",
  "markcss",
  "draw",
  "onPaint",
  "animate",
] as const;

/** Browser-only globals the visuals topic legitimately uses. */
const HYDRA_GLOBALS = () => {
  const chain: Any = new Proxy(function () {} as Any, {
    get: () => chain,
    apply: () => chain,
  });
  const src = () => chain;
  return {
    initHydra: async () => undefined,
    clearHydra: () => undefined,
    H: () => () => 0,
    P: () => () => 0,
    osc: src,
    noise: src,
    voronoi: src,
    shape: src,
    gradient: src,
    solid: src,
    src,
    a: new Proxy({} as Any, { get: () => chain }),
    a0: chain,
    a1: chain,
    a2: chain,
    a3: chain,
    s0: chain,
    s1: chain,
    o0: chain,
    o1: chain,
    o2: chain,
    o3: chain,
    render: () => chain,
  };
};

let ready: Promise<void> | undefined;

/**
 * Install the guide's vocabulary into the global eval scope. `evalScope`
 * pollutes globalThis by design (that is how Strudel's REPL works); tests are
 * the only consumer, and every name here is a Strudel name.
 */
export function setupStrudel(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    for (const name of DRAW_METHODS) {
      // Chainable no-ops: the pattern must survive `.pianoroll()` unchanged.
      C.Pattern.prototype[name] = function () {
        return this;
      };
    }
    await C.evalScope(core, mini, tonal, C.controls ?? {}, {
      // repl()-provided globals, minus the scheduler.
      setcps: () => C.silence,
      setCps: () => C.silence,
      setcpm: () => C.silence,
      setCpm: () => C.silence,
      hush: () => C.silence,
      all: () => C.silence,
      each: () => C.silence,
      // Sample loading is a network + WebAudio concern.
      samples: async () => undefined,
      registerSound: () => undefined,
      ...HYDRA_GLOBALS(),
    });
  })();
  return ready;
}

export interface EvalResult {
  readonly pattern: Any | undefined;
  readonly error: Error | undefined;
}

/** Evaluate one Strudel snippet through the real transpiler. */
export async function evalStrudel(code: string): Promise<EvalResult> {
  await setupStrudel();
  try {
    const { pattern } = await C.evaluate(code, transpiler);
    if (!pattern || typeof pattern.queryArc !== "function") {
      return { pattern: undefined, error: new Error("evaluated to a non-Pattern") };
    }
    return { pattern, error: undefined };
  } catch (err) {
    return { pattern: undefined, error: err as Error };
  }
}

/** Query a pattern over `cycles` cycles, surfacing query-time errors. */
export function queryHaps(pattern: Any, cycles = 8): { haps: Any[]; error?: Error } {
  try {
    return { haps: pattern.queryArc(0, cycles) };
  } catch (err) {
    return { haps: [], error: err as Error };
  }
}
