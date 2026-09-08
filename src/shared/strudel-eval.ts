/**
 * A headless Strudel evaluator.
 *
 * Originally the test suite's (tests/strudel-eval.ts), promoted to production so
 * the SERVER can tell a text-only client whether the pattern it just wrote
 * actually evaluates. Claude Code, a CLI, or the remote worker hit from a
 * terminal never render the REPL widget, so without this the only honest thing
 * the server could say was "nothing has played yet".
 *
 * This is the real @strudel/core + @strudel/mini + @strudel/tonal + the real
 * transpiler, pinned to the versions @strudel/repl@1.3.0 depends on. What we do
 * NOT bring up: the scheduler, superdough/WebAudio, @strudel/draw and
 * @strudel/hydra (WebGL). Those are stubbed as no-ops, so a pattern's *timing
 * and values* are certified here while its *audio* is not.
 *
 * Two facts about the upstream packages drive the shape of this file:
 *
 *  1. `evalScope` installs the whole Strudel vocabulary onto `globalThis`. That
 *     is how Strudel's REPL works and there is no per-call scope. So setup runs
 *     ONCE per process behind a memoised promise, and anything we want to
 *     observe per-call (setcps, samples(), initHydra, draw methods, stack
 *     arity) is recorded into a module-level "active trace" that `runTraced`
 *     swaps in. Concurrent calls would cross-contaminate that trace, so
 *     `runTraced` serialises them through a promise queue. Validation is
 *     sub-millisecond, so the queue is never the bottleneck.
 *
 *  2. `@strudel/core` calls `console.log` at import time ("🌀 @strudel/core
 *     loaded 🌀") and again for every query-time error. On a stdio transport
 *     stdout is the JSON-RPC channel, so a stray `console.log` corrupts the
 *     protocol. `runTraced` therefore captures console.log/info for the
 *     duration of the run — which conveniently also hands us Strudel's
 *     query-time diagnostics, which `queryArc` swallows rather than rethrows.
 */
// The @strudel packages ship no type declarations (plain .mjs bundles), which
// `strict` turns into TS7016. Suppressed here rather than via an ambient .d.ts
// so both tsconfigs (root and worker/) see the same thing without either having
// to `include` an extra path. Everything from them is `any` and is treated as
// such below.
// @ts-ignore -- no types published
import * as core from "@strudel/core";
// @ts-ignore -- no types published
import * as mini from "@strudel/mini";
// @ts-ignore -- no types published
import * as tonal from "@strudel/tonal";
// @ts-ignore -- no types published
import { transpiler } from "@strudel/transpiler";

type Any = Record<string, any>;
const C = core as unknown as Any;

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

/**
 * Widest query span, in cycles, that any single `splitQueries` is allowed to
 * expand — see `installSpanGuard` for why this is the load-bearing safety net.
 * 20k cycles is orders of magnitude past any real pattern (`.fast(64)` over 4
 * cycles is 256) and still cheap to materialise.
 */
export const DEFAULT_SPAN_CEILING = 20_000;

/** What one traced evaluation observed. Filled by the stubs below. */
export interface StrudelTrace {
  /** From setcps()/setcpm(); cycles per second. */
  cps?: number;
  /** URLs handed to samples(). Their sound names are unverifiable, not unknown. */
  sampleUrls: string[];
  /** Did the code call initHydra()? */
  usesHydra: boolean;
  /** Draw methods the code actually called, in call order. */
  visuals: string[];
  /** Largest arity seen across stack() calls; 0 if stack() was never called. */
  stackArity: number;
  /** console.log/info emitted during the run (Strudel's own diagnostics). */
  logs: string[];
  /** Set when the span guard or the deadline aborted the query. */
  abort?: string;
  /** Epoch ms after which the query is aborted. */
  deadline: number;
  /** Per-query span ceiling, in cycles. */
  spanCeiling: number;
}

export function createTrace(opts: {
  deadline: number;
  spanCeiling?: number;
}): StrudelTrace {
  return {
    sampleUrls: [],
    usesHydra: false,
    visuals: [],
    stackArity: 0,
    logs: [],
    deadline: opts.deadline,
    spanCeiling: opts.spanCeiling ?? DEFAULT_SPAN_CEILING,
  };
}

/** The trace `runTraced` is currently filling, if any. */
let active: StrudelTrace | undefined;

// -----------------------------------------------------------------------------
// The interrupt
// -----------------------------------------------------------------------------

/**
 * Make a runaway pattern fail instead of taking the process down.
 *
 * `Promise.race` cannot help here: `queryArc` is synchronous, so a timeout
 * promise never gets a turn. And the failure mode is not a hang, it is an
 * out-of-memory abort — `s("bd").fast(1e9)` querying 4 cycles asks
 * `TimeSpan.spanCycles` for four billion one-cycle spans and V8 dies building
 * the array (measured: FATAL ERROR "Ineffective mark-compacts near heap limit"
 * at ~4 GB, ~11 s). A `worker_threads` Worker with `terminate()` would contain
 * that on Node, but the Cloudflare Worker has no worker_threads at all, and the
 * same isolate would still be killed there.
 *
 * `spanCycles` is the single choke point every blow-up runs through, and it is
 * a real prototype getter, so patching it intercepts calls made from inside the
 * minified bundle too. Checking the span's WIDTH *before* delegating stops the
 * allocation from ever happening; the deadline check rides along because this
 * getter is hit constantly (~70 times for an ordinary four-bar pattern), which
 * makes it the cheapest available interrupt point for slow-but-not-explosive
 * patterns.
 *
 * `queryArc` catches whatever we throw and logs it rather than rethrowing, so
 * the reason is also parked on the trace for the caller to read back.
 */
function installSpanGuard(): void {
  const proto = C.TimeSpan?.prototype;
  const desc = proto && Object.getOwnPropertyDescriptor(proto, "spanCycles");
  const original = desc?.get;
  // Upstream could reasonably turn this into a plain method or a field. If the
  // shape ever changes, validation keeps working — it just loses the guard, so
  // fail loudly here rather than silently shipping an unbounded query.
  if (!original) {
    throw new Error(
      "@strudel/core: TimeSpan.prototype.spanCycles is no longer a getter — " +
        "the runaway-pattern guard in src/shared/strudel-eval.ts needs updating",
    );
  }
  Object.defineProperty(proto, "spanCycles", {
    configurable: true,
    get(this: Any) {
      const trace = active;
      if (trace?.abort) throw new Error(trace.abort);
      if (trace && Date.now() > trace.deadline) {
        trace.abort = "evaluation timed out";
        throw new Error(trace.abort);
      }
      const width = Number(this.end) - Number(this.begin);
      const ceiling = trace?.spanCeiling ?? DEFAULT_SPAN_CEILING;
      if (width > ceiling) {
        const reason =
          `pattern expands to ${Math.round(width).toLocaleString("en-US")} cycles in one query ` +
          `(limit ${ceiling.toLocaleString("en-US")}) — check .fast()/*N factors`;
        if (trace) trace.abort = reason;
        throw new Error(reason);
      }
      return original.call(this);
    },
  });
}

// -----------------------------------------------------------------------------
// Eval scope
// -----------------------------------------------------------------------------

/** Browser-only globals the visuals topic legitimately uses. */
const HYDRA_GLOBALS = () => {
  const chain: Any = new Proxy(function () {} as Any, {
    get: () => chain,
    apply: () => chain,
  });
  const src = () => chain;
  return {
    initHydra: async () => {
      if (active) active.usesHydra = true;
      return undefined;
    },
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

const recordCps = (value: unknown, divisor: number) => {
  const n = Number(value);
  if (active && Number.isFinite(n)) active.cps = n / divisor;
  return C.silence;
};

let ready: Promise<void> | undefined;

/**
 * Install the Strudel vocabulary into the global eval scope.
 *
 * `evalScope` pollutes globalThis by design — that is how Strudel's REPL works,
 * and there is no per-call alternative. Memoised so it happens once per process
 * (see the file header); every name it installs is a Strudel name.
 */
export function setupStrudel(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    installSpanGuard();
    for (const name of DRAW_METHODS) {
      // Chainable no-ops: the pattern must survive `.pianoroll()` unchanged.
      C.Pattern.prototype[name] = function (this: Any) {
        if (active && !active.visuals.includes(name)) active.visuals.push(name);
        return this;
      };
    }
    await C.evalScope(core, mini, tonal, C.controls ?? {}, {
      // repl()-provided globals, minus the scheduler. Listed last so these win
      // over anything of the same name from the modules above.
      setcps: (v: unknown) => recordCps(v, 1),
      setCps: (v: unknown) => recordCps(v, 1),
      setcpm: (v: unknown) => recordCps(v, 60),
      setCpm: (v: unknown) => recordCps(v, 60),
      hush: () => C.silence,
      all: () => C.silence,
      each: () => C.silence,
      // Sample loading is a network + WebAudio concern. The URL is worth
      // recording though: it means unknown sound names are unverifiable rather
      // than wrong.
      samples: async (arg: unknown) => {
        if (active) {
          active.sampleUrls.push(typeof arg === "string" ? arg : "<inline map>");
        }
        return undefined;
      },
      registerSound: () => undefined,
      // Same function, wrapped only to count how many layers were stacked.
      stack: (...pats: unknown[]) => {
        if (active) active.stackArity = Math.max(active.stackArity, pats.length);
        return C.stack(...pats);
      },
      ...HYDRA_GLOBALS(),
    });
  })();
  return ready;
}

// -----------------------------------------------------------------------------
// Tracing
// -----------------------------------------------------------------------------

/** Serialises traced runs — see fact (1) in the file header. */
let queue: Promise<unknown> = Promise.resolve();

const noop = () => undefined;

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(noop, noop);
  return run;
}

/** Strudel logs through `console.log("%c" + msg, css)`; keep just the message. */
function formatLogArgs(args: unknown[]): string {
  const first = typeof args[0] === "string" ? args[0] : String(args[0] ?? "");
  return first.startsWith("%c") ? first.slice(2) : first;
}

/**
 * Run `fn` with `trace` recording, console.log captured, and no other traced
 * run interleaved. See the file header for why all three are one function.
 */
export function runTraced<T>(
  trace: StrudelTrace,
  fn: () => Promise<T>,
): Promise<T> {
  return enqueue(async () => {
    const log = console.log;
    const info = console.info;
    const capture = (...args: unknown[]) => {
      trace.logs.push(formatLogArgs(args));
    };
    console.log = capture;
    console.info = capture;
    active = trace;
    try {
      return await fn();
    } finally {
      active = undefined;
      console.log = log;
      console.info = info;
    }
  });
}

// -----------------------------------------------------------------------------
// Evaluate / query
// -----------------------------------------------------------------------------

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
export function queryHaps(
  pattern: Any,
  cycles = 8,
): { haps: Any[]; error?: Error } {
  try {
    return { haps: pattern.queryArc(0, cycles) };
  } catch (err) {
    return { haps: [], error: err as Error };
  }
}
