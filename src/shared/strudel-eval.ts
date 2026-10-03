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
import { stageEvent } from "./stage-runtime.js";
import { createRememberStore } from "./remember-store.js";
import { normalizeTts, ttsSampleName } from "./tts.js";

type Any = Record<string, any>;
const C = core as unknown as Any;

/**
 * Draw methods live in @strudel/draw (canvas/WebGL). No-op them onto Pattern.
 *
 * Every name the widget's @strudel/repl@1.3.0 bundle puts on Pattern belongs
 * here, or a pattern that plays in the widget is reported to the model as
 * "failed to evaluate — nothing will play": `tscope`/`fscope` (the scope's
 * time- and frequency-domain forms) and the underscore INLINE widgets
 * (`registerWidget("_pianoroll", …)` etc.), which draw inside the editor and
 * are all over the strudel.cc docs.
 */
export const DRAW_METHODS = [
  "pianoroll",
  "punchcard",
  "scope",
  "tscope",
  "fscope",
  "spectrum",
  "spiral",
  "pitchwheel",
  "wordfall",
  "markcss",
  "draw",
  "onPaint",
  "animate",
  "_pianoroll",
  "_punchcard",
  "_scope",
  "_spectrum",
  "_spiral",
  "_pitchwheel",
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
  /** Stage callbacks that threw on a test frame (see SANDBOX_STAGE). */
  warnings: string[];
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
    warnings: [],
  };
}

/** The trace `runTraced` is currently filling, if any. */
let active: StrudelTrace | undefined;

/** Transforms recorded by all()/each() during the evaluation in progress. */
let pendingAll: Array<(p: Any) => Any> = [];
let pendingEach: ((p: Any) => Any) | undefined;
/**
 * Patterns registered with `.p(id)` — what `$: pattern` transpiles to
 * (`pattern.p('$')`), and `d1`…`d9`/`p1`…`p9`. Ordered as registered.
 */
let pendingP: Array<[string, Any]> = [];
let anonymousIndex = 0;

function resetTransforms(): void {
  pendingAll = [];
  pendingEach = undefined;
  pendingP = [];
  anonymousIndex = 0;
}

/**
 * What @strudel/core's repl() does after `_evaluate` returns: apply each(),
 * then every all(), to the last expression's value. The REPL then substitutes
 * `silence` for a non-Pattern; here that is reported as an error instead,
 * because a pattern that plays silence is exactly what a validator exists to
 * catch — the commonest cause being all()/setcps() written AFTER the pattern.
 */
function finishEvaluation(value: unknown): EvalResult {
  const isPattern = (p: unknown): p is Any =>
    !!p && typeof (p as Any).queryArc === "function";
  const notAPattern = (): EvalResult => ({
    pattern: undefined,
    error: new Error(
      "evaluated to a non-Pattern — the REPL plays the LAST expression, so the pattern must come last (all(), setcps() and the like go before it)",
    ),
  });
  // Checked before the transforms run: `p => p.scope()` on undefined would
  // throw a TypeError that names the symptom, not the cause.
  // `$:` blocks: the REPL plays the stack of registered patterns, whatever the
  // last expression was (often a Hydra `.out()`, i.e. undefined). An `S…` id
  // solos: only soloed patterns play once one is seen.
  if (pendingP.length) {
    let patterns: Any[] = [];
    let soloActive = false;
    for (const [key, pat] of pendingP) {
      const isSolo = key.length > 1 && key.startsWith("S");
      if (isSolo && !soloActive) {
        patterns = [];
        soloActive = true;
      }
      if (!soloActive || isSolo) patterns.push(pat);
    }
    if (pendingEach) patterns = patterns.map((x) => pendingEach!(x));
    if (active) active.stackArity = Math.max(active.stackArity, patterns.length);
    let stacked: Any = C.stack(...patterns);
    for (const transform of pendingAll) stacked = transform(stacked);
    resetTransforms();
    return isPattern(stacked) ? { pattern: stacked, error: undefined } : notAPattern();
  }
  if (!isPattern(value)) {
    resetTransforms();
    return notAPattern();
  }
  let pattern: Any = value;
  if (pendingEach) pattern = pendingEach(pattern);
  for (const transform of pendingAll) pattern = transform(pattern);
  resetTransforms();
  return isPattern(pattern) ? { pattern, error: undefined } : notAPattern();
}

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

/**
 * An inert stand-in for any browser object: every property is another inert
 * value, every call and `new` returns one, assignments are remembered (so
 * `cvs.width = 640; cvs.width / 64` is 10, not NaN), and it converts to 0 / ""
 * in arithmetic and strings. Audiovisual pieces run their draw function once at
 * the top level (`draw()` before handing it to requestAnimationFrame), so the
 * stand-in must survive `kick * 30`, `g.measureText(msg).width`, a spread, and
 * `for…of` — before 0.7 each of those failed validation for code that plays.
 *
 * Never thenable: a chain as the LAST expression (a Hydra `.out()` after `$:`
 * blocks) is returned from an async function, which awaits a thenable — and
 * this one would never resolve.
 */
export function inert(): Any {
  const stored = new Map<PropertyKey, unknown>();
  const self: Any = new Proxy(function () {} as Any, {
    get: (_t, prop) => {
      if (stored.has(prop)) return stored.get(prop);
      if (prop === "then") return undefined;
      if (prop === Symbol.toPrimitive) return (hint: string) => (hint === "string" ? "" : 0);
      if (prop === Symbol.iterator) return function* () {};
      if (prop === "length") return 0;
      const child = inert();
      stored.set(prop, child);
      return child;
    },
    set: (_t, prop, value) => {
      stored.set(prop, value);
      return true;
    },
    has: () => true,
    apply: () => inert(),
    construct: () => inert(),
  });
  return self;
}

/**
 * A `document` for the PATTERN only (the sandbox's own scope, never
 * globalThis): an offscreen canvas fed to Hydra, `s1.init({src:
 * document.createElement('canvas')})`, runs in the widget and must not be
 * reported as failed. Setting a global `document` instead made Strudel's own
 * error path call `document.dispatchEvent` in the server (measured).
 */
const SANDBOX_DOCUMENT = () => {
  const doc = inert();
  doc.createElement = () => inert();
  return doc;
};

/**
 * The rest of the browser a piece reaches for — again on the sandbox only.
 * `requestAnimationFrame` never calls back (the piece's top-level first frame
 * is what gets checked); listeners are dropped; speech is silent. Measured on
 * the 2026-10-01 claude.ai pieces: without these, First Light, DUET and Petri
 * Dish came back "failed to evaluate: window is not defined" — code that plays.
 */
const SANDBOX_BROWSER = () => {
  let timersLeft = 64;
  const window = inert();
  window.innerWidth = 800;
  window.innerHeight = 450;
  window.devicePixelRatio = 1;
  return {
    window,
    self: window,
    innerWidth: 800,
    innerHeight: 450,
    devicePixelRatio: 1,
    navigator: inert(),
    location: inert(),
    localStorage: inert(),
    speechSynthesis: inert(),
    SpeechSynthesisUtterance: function SpeechSynthesisUtterance() {
      return inert();
    },
    Image: function Image() {
      return inert();
    },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => undefined,
    // Real, but short and few: `await new Promise(r => setTimeout(r, 500))` at
    // the top level must resolve (a stub that never calls back made a working
    // piece time out as "may loop forever" — Opus, 0.7.0 gauntlet), while a
    // self-rescheduling timer loop must not run on in the warm child.
    setTimeout: (fn: unknown, ms?: unknown) => {
      if (typeof fn !== "function" || timersLeft-- <= 0) return 0;
      return setTimeout(() => {
        try {
          (fn as () => void)();
        } catch {
          /* a stand-in world; errors here are not the pattern's */
        }
      }, Math.min(Math.max(0, Number(ms) || 0), 50)) as unknown as number;
    },
    clearTimeout: (id: unknown) => clearTimeout(id as never),
    setInterval: () => 0,
    clearInterval: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    performance: { now: () => performance.now() },
  };
};

/**
 * The stage runtime (src/shared/stage-runtime.ts) for the validator: the same
 * names, the same argument checks, and one test call of every onFrame/onEvent
 * callback — queued, and run only after the top level has finished (a draw
 * function may close over a `const` declared further down, which the browser
 * never sees in its temporal dead zone). A callback that throws there is a
 * warning, not a failure: in the widget it is reported and skipped, and the
 * music plays on. onTap callbacks are never called — a tap is the user's.
 *
 * remember() is the REAL store (src/shared/remember-store.ts), one per run:
 * the same validation, freezing and name rules as the widget. Its state is
 * staged while the top level runs and applied (merges once) right after it,
 * before the test frames — as the widget applies it at commit — so a name a
 * callback declares first applies at once there too, and the pattern the
 * validator queries reads what the widget's would. `stageControl.commitState` is
 * how the evaluator applies it (not a name in the piece's scope).
 */
const SANDBOX_STAGE = (
  checks: Array<() => void>,
  settling: Array<Promise<unknown>>,
  stageControl: { commitState: () => void },
) => {
  const requireFunction = (api: string, fn: unknown) => {
    if (typeof fn !== "function") throw new TypeError(`${api} needs a function, got ${typeof fn}`);
  };
  const warn = (api: string, err: unknown) =>
    active?.warnings.push(`${api} callback threw on a test frame: ${(err as Error)?.message ?? String(err)}`);
  const remembering = createRememberStore({
    now: () => Date.now(),
    cycle: () => 0,
    listenerWriting: () => false,
    reportError: (_api, err) =>
      active?.warnings.push(`remember: a merge failed, so this piece's state changes were skipped: ${(err as Error)?.message ?? String(err)}`),
  });
  remembering.begin(1);
  stageControl.commitState = () => remembering.commit(1, false);
  // Names in one namespace with the controls (the widget throws on a clash too).
  const controlNames = new Set<string>();
  const claimControl = (api: string, name: unknown): void => {
    const id = stageName(api, name);
    if (remembering.declaresNow(id)) {
      throw new TypeError(`'${id}' is already a remember() name in this piece — give the control its own name`);
    }
    controlNames.add(id);
  };
  const testCall = (api: string, fn: (arg: unknown) => unknown, arg: () => unknown) =>
    checks.push(() => {
      try {
        const result = fn(arg()) as { then?: unknown } | undefined;
        // An async callback throws by REJECTING: catch that too, or the
        // warning is silently lost (Kimi, 0.7.0 gauntlet).
        if (result && typeof result.then === "function") {
          settling.push(Promise.resolve(result).catch((err) => warn(api, err)));
        }
      } catch (err) {
        warn(api, err);
      }
    });
  return {
    cycle: () => 0,
    onFrame(fn: (frame: unknown) => void) {
      requireFunction("onFrame(fn)", fn);
      testCall("onFrame", fn, () => ({ cycle: 0.5, dt: 1 / 60, time: 1, playing: true }));
      return () => undefined;
    },
    onEvent(pattern: Any, fn: (event: unknown) => void) {
      requireFunction("onEvent(pattern, fn)", fn);
      const pat = pattern?.queryArc ? pattern : C.reify?.(pattern);
      if (!pat || typeof pat.queryArc !== "function") {
        throw new TypeError('onEvent(pattern, fn) needs a pattern — e.g. onEvent(note("c e g"), fn)');
      }
      testCall("onEvent", fn, () => {
        const hap = pat.queryArc(0, 1).find((h: Any) => h?.hasOnset?.() !== false);
        return hap ? stageEvent(hap, Number(hap.whole?.begin ?? 0)) : stageEvent({ value: {} }, 0);
      });
      return () => undefined;
    },
    onTap(fn: unknown) {
      requireFunction("onTap(fn)", fn);
      return () => undefined;
    },
    say(text: unknown, options?: { voice?: unknown }) {
      const request = normalizeTts(text, options?.voice);
      if ("error" in request) throw new TypeError(request.error);
      return C.s(ttsSampleName(request));
    },
    remember(name: unknown, init: unknown, options?: Any) {
      const id = stageName("remember", name);
      if (controlNames.has(id)) {
        throw new TypeError(`remember('${id}'): '${id}' is already a control in this piece — give the state its own name`);
      }
      return remembering.declare(id, init, options);
    },
    openStage() {
      /* the validator has no stage to open */
    },
    // Controls read their initial value here: a signal pattern with .value.
    fader(name: unknown, options: { min?: number; max?: number; init?: number } = {}) {
      requireName("fader", name);
      claimControl("fader", name);
      const min = Number.isFinite(options.min) ? options.min! : 0;
      const max = Number.isFinite(options.max) ? options.max! : 1;
      if (!(max > min)) throw new RangeError(`fader('${name}'): max must be greater than min`);
      const init = Math.min(max, Math.max(min, Number.isFinite(options.init) ? options.init! : min));
      return control(init);
    },
    pad(name: unknown, options: { init?: boolean } = {}) {
      requireName("pad", name);
      claimControl("pad", name);
      return control(options.init ? 1 : 0);
    },
    xy(name: unknown) {
      requireName("xy", name);
      claimControl("xy", name);
      return { x: control(0.5), y: control(0.5), value: [0.5, 0.5] };
    },
    // Sensors start level / silent; the name is optional.
    tilt(name: unknown = "tilt") {
      requireName("tilt", name);
      claimControl("tilt", name);
      return { x: control(0.5), y: control(0.5), value: [0.5, 0.5] };
    },
    mic(name: unknown = "mic") {
      requireName("mic", name);
      claimControl("mic", name);
      return control(0);
    },
  };
};

/** A stage name as the widget reads it (controlName in stage-runtime.ts): trimmed, ≤ 32 characters. */
function stageName(api: string, name: unknown): string {
  if (name && typeof name === "object" && typeof (name as Any).__pure === "string") name = (name as Any).__pure;
  else if (name && typeof name === "object" && typeof (name as Any).queryArc === "function") {
    try {
      const v = (name as Any).queryArc(0, 1)[0]?.value;
      if (typeof v === "string") name = v;
    } catch { /* not a name */ }
  }
  if (typeof name !== "string" || !name.trim()) throw new TypeError(`${api}(name) needs a name, e.g. ${api}('rain')`);
  return name.trim().slice(0, 32);
}

function requireName(api: string, name: unknown): void {
  // A double-quoted name is a one-value mini-notation pattern; the widget accepts it too.
  if (name && typeof name === "object" && typeof (name as Any).queryArc === "function") {
    try {
      name = (name as Any).queryArc(0, 1)[0]?.value;
    } catch { /* not a name */ }
  }
  if (typeof name !== "string" || !name.trim()) throw new TypeError(`${api}(name) needs a name, e.g. ${api}('rain')`);
}

function control(value: number): Any {
  const pattern = C.signal(() => value);
  Object.defineProperty(pattern, "value", { get: () => value, configurable: true });
  return pattern;
}

/** How many a0…aN band globals to stand in for (hydra tutorials go up to ~8). */
const AUDIO_BAND_GLOBALS = 16;

/** Browser-only globals the visuals topic legitimately uses. */
const HYDRA_GLOBALS = () => {
  // inert(): chainable, never thenable, and 0 in arithmetic — `a.fft[0] * 30`
  // in a top-level first frame used to throw "Cannot convert object to
  // primitive value".
  const chain: Any = inert();
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
    a: inert(),
    // The widget publishes a0…aN for however many bins `a.setBins(n)` asked
    // for; a5 after setBins(6) used to fail here as "not defined".
    ...Object.fromEntries(Array.from({ length: AUDIO_BAND_GLOBALS }, (_, i) => [`a${i}`, chain])),
    // Custom drawing: `getDrawContext('layer2')` for an extra canvas layer. A
    // chainable stand-in: painters never run here, only the top level does.
    // (`document` is NOT stubbed here — this map is written onto the real
    // globalThis, and Strudel's own code takes a defined `document` to mean a
    // browser; see SANDBOX_DOCUMENT.)
    getDrawContext: () => chain,
    s0: chain,
    s1: chain,
    s2: chain,
    s3: chain,
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
    // What repl()'s injectPatternMethods() adds: `$: x` is `x.p('$')`, and an
    // id starting or ending in `_` mutes. Without these, every pattern written
    // with `$:` blocks failed validation ("….p is not a function") while it
    // played fine in the widget.
    C.Pattern.prototype.p = function (this: Any, id: unknown) {
      if (typeof id === "string" && (id.startsWith("_") || id.endsWith("_"))) return C.silence;
      let key = String(id);
      if (key.includes("$")) key = `${key}${anonymousIndex++}`;
      pendingP = pendingP.filter(([k]) => k !== key);
      pendingP.push([key, this]);
      return this;
    };
    C.Pattern.prototype.q = function () {
      return C.silence;
    };
    for (let i = 1; i < 10; ++i) {
      for (const name of [`d${i}`, `p${i}`]) {
        Object.defineProperty(C.Pattern.prototype, name, {
          get(this: Any) {
            return this.p(i);
          },
          configurable: true,
        });
      }
      C.Pattern.prototype[`q${i}`] = C.silence;
    }
    await C.evalScope(core, mini, tonal, C.controls ?? {}, {
      // repl()-provided globals, minus the scheduler. Listed last so these win
      // over anything of the same name from the modules above.
      setcps: (v: unknown) => recordCps(v, 1),
      setCps: (v: unknown) => recordCps(v, 1),
      setcpm: (v: unknown) => recordCps(v, 60),
      setCpm: (v: unknown) => recordCps(v, 60),
      hush: () => C.silence,
      // Faithful to the REPL: all()/each() record a transform and return
      // undefined; the transform is applied to the LAST expression's pattern
      // by finishEvaluation(). Stubbing them as `silence` hid the v0.5.0
      // preset bug (a trailing all() evaluates to undefined → silence).
      all: (transform: (p: Any) => Any) => {
        pendingAll.push(transform);
      },
      each: (transform: (p: Any) => Any) => {
        pendingEach = transform;
      },
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
      // slider(value, min, max) is an editor widget: the transpiler rewrites
      // it to sliderWithID(id, value, min, max), which the REPL resolves to a
      // pattern of the slider's live value. Here the value never moves, so its
      // starting value is the faithful stand-in. Without these, every pattern
      // with a slider was reported as "sliderWithID is not defined".
      sliderWithID: (_id: unknown, value: unknown) => C.pure(value),
      slider: (value: unknown) => C.pure(value),
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

/**
 * Evaluate one Strudel snippet inside a `node:vm` context.
 *
 * `@strudel/core`'s own `evaluate()` ends in `Function(body)()` — the model's
 * code, compiled into the REAL global scope, where `process.env`, `fetch` and
 * dynamic `import()` are all in reach. Fine in the browser iframe the widget
 * runs in, where a CSP pins what the page may touch; not fine in a server
 * process. So this reimplements `evaluate()` — same transpiler, same
 * `safeEval` wrapping, verbatim from evaluate.mjs — but runs the result in a
 * context whose global is `Object.create(null)` plus Strudel's own vocabulary.
 *
 * What that buys, verified on Node 20-26 and Bun by
 * tests/strudel-validate-isolation.test.ts: `process`, `require`, `fetch` and
 * `globalThis.process` are all `undefined` inside the pattern, and `import()`
 * throws ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING because no
 * `importModuleDynamically` is supplied.
 *
 * What it does NOT buy:
 *
 *  - Escape-proofing. A vm context is a scope boundary, not a security
 *    boundary — Node says so explicitly, and the Strudel functions the context
 *    is populated with are outer-realm closures, so anything reachable through
 *    THEM is reachable. This is defence in depth; the process boundary in
 *    strudel-validate-host.ts is what actually contains a hostile pattern.
 *  - A hard deadline. `timeout` only interrupts SYNCHRONOUS execution, so
 *    `while(true){}` is caught but `await x; while(true){}` is not. The host's
 *    SIGKILL is the real deadline.
 *
 * The context is fresh per call so one pattern cannot leave state for the next.
 */
export async function evalStrudelSandboxed(
  code: string,
  { timeoutMs = 3000 }: { timeoutMs?: number } = {},
): Promise<EvalResult> {
  await setupStrudel();
  const vm = await import("node:vm");
  try {
    // Parsing (acorn) happens out here, in normal module scope: it only ever
    // reads the source string, and its SyntaxErrors carry the `loc` that
    // strudel-validate turns into a line:column.
    const { output } = transpiler(code);
    // `strudelScope` is the same map `evalScope` fills while writing to
    // globalThis, so it is the exact vocabulary Strudel's own REPL exposes —
    // including everything setupStrudel() stubbed in (setcps, samples, stack,
    // the Hydra no-ops). `console` is not a Strudel name but guide examples
    // use it; route it to the outer one, which runTraced is capturing.
    const stageChecks: Array<() => void> = [];
    const stageSettling: Array<Promise<unknown>> = [];
    const stageControl = { commitState: () => {} };
    const sandbox = Object.assign(Object.create(null), C.strudelScope, {
      console: { log: console.log, info: console.info, warn: console.warn, error: console.error },
      ...SANDBOX_BROWSER(),
      ...SANDBOX_STAGE(stageChecks, stageSettling, stageControl),
      document: SANDBOX_DOCUMENT(),
      __musicStudioStageChecks: () => {
        for (const check of stageChecks.splice(0)) check();
      },
    });
    // codeGeneration only governs THIS context's eval/Function. Every outer-
    // realm function in the sandbox (all of Strudel's, console.log, the inert()
    // stand-ins) still leads to the outer Function via .constructor — measured
    // in 0.7.0. The boundary is the forked env-less child + SIGKILL
    // (strudel-validate-host.ts), never this vm.
    const context = vm.createContext(sandbox, {
      codeGeneration: { strings: false, wasm: false },
    });
    // Verbatim from @strudel/core's safeEval (wrapExpression + wrapAsync),
    // re-nested inside an IIFE because a Script has no `return`.
    const source = `(function(){"use strict";return ((async ()=>{${output}})());})()`;
    resetTransforms();
    const started = Date.now();
    const value = await vm.runInContext(source, context, {
      filename: "strudel-pattern.js",
      timeout: timeoutMs,
    });
    // The stage test frames, under the same vm ceiling (a `while(true)` in a
    // draw loop must not wedge the validator either).
    stageControl.commitState();
    if (stageChecks.length) {
      vm.runInContext("__musicStudioStageChecks()", context, {
        timeout: Math.max(50, timeoutMs - (Date.now() - started)),
      });
      // Async callbacks settle after the checks return; give them a moment.
      if (stageSettling.length) {
        await Promise.race([
          Promise.allSettled(stageSettling),
          new Promise((resolve) => setTimeout(resolve, 250)),
        ]);
      }
    }
    return finishEvaluation(value);
  } catch (err) {
    resetTransforms();
    return { pattern: undefined, error: err as Error };
  }
}

/**
 * Evaluate one Strudel snippet through the real transpiler, in this scope.
 *
 * Unsandboxed: the code runs with the module's own globals in reach. Kept for
 * the guide tests, which evaluate code WE wrote and want the plain thing. The
 * server must not use this — see evalStrudelSandboxed above.
 */
export async function evalStrudel(code: string): Promise<EvalResult> {
  await setupStrudel();
  try {
    resetTransforms();
    const { pattern } = await C.evaluate(code, transpiler);
    return finishEvaluation(pattern);
  } catch (err) {
    resetTransforms();
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
