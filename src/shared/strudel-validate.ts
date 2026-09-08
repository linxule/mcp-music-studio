/**
 * Server-side validation of Strudel code.
 *
 * play-live-pattern renders a REPL widget, and in an MCP-app host the widget is
 * the feedback: the user sees the code run. Everywhere else — Claude Code, a
 * CLI, the remote worker reached from a terminal — there is no widget, and the
 * tool result used to be the one honest sentence the server could offer
 * ("...nothing has played yet"). An agent writing Strudel into that void has no
 * way to learn that its pattern threw, resolved to silence, or named a drum
 * machine that does not exist.
 *
 * So run the pattern here. src/shared/strudel-eval.ts brings up the real
 * Strudel (core + mini + tonal + transpiler, no audio, no canvas); this module
 * turns one run of it into a report the result text can quote.
 *
 * What this certifies: the code parses, every name resolves, the pattern
 * produces events, and the sounds it names are ones prebake() registers.
 * What it does NOT: how it sounds.
 */
// The sound inventory is generated from @strudel/repl's prebake() by
// scripts/sync-strudel-sounds.mjs and has always lived with the tests that
// consume it. It is plain data and there is exactly one copy on purpose — a
// second copy under src/ would drift from the one the guide tests assert
// against, which is the whole point of having it.
import strudelSounds from "../../tests/fixtures/strudel-sounds.json" with { type: "json" };

export interface StrudelValidationError {
  message: string;
  line?: number;
  column?: number;
}

export interface StrudelValidation {
  ok: boolean;
  error?: StrudelValidationError;
  /** Number of patterns handed to stack(); absent when stack() was not used. */
  layers?: number;
  eventsPerCycle?: number;
  /** Distinct sound names the pattern actually triggers, sorted. */
  sounds?: string[];
  /** Sounds prebake() does not register. Absent when samples() was called. */
  unregistered?: string[];
  usesNotes?: boolean;
  cps?: number;
  usesHydra?: boolean;
  /** Draw methods the code called (pianoroll, scope, ...). */
  visuals?: string[];
  /** URLs passed to samples() — why `unregistered` may be withheld. */
  sampleUrls?: string[];
}

export interface ValidateOptions {
  /** Cycles to query. Four bars is enough to see a pattern's full shape. */
  cycles?: number;
  /** Wall-clock ceiling for the whole run. */
  timeoutMs?: number;
}

type Evaluator = typeof import("./strudel-eval.js");
type StrudelTrace = import("./strudel-eval.js").StrudelTrace;

let evaluator: Promise<Evaluator> | undefined;

/**
 * Load the evaluator lazily, with console.log muted.
 *
 * `@strudel/core` prints a banner ("🌀 @strudel/core loaded 🌀") the moment it
 * is imported. On a stdio transport stdout IS the JSON-RPC channel — main.ts's
 * standing invariant — so a static import would put a bare emoji line in front
 * of the first response and break the protocol. An import expression is the
 * only place that side effect can be contained, since ES imports are hoisted
 * above anything a module body could do about them.
 *
 * Memoised, so the mute window is one import, once per process. The lazy load
 * also means a server that never plays a Strudel pattern never pays for it.
 */
function loadEvaluator(): Promise<Evaluator> {
  if (!evaluator) {
    evaluator = (async () => {
      const log = console.log;
      const info = console.info;
      const swallow = () => undefined;
      console.log = swallow;
      console.info = swallow;
      try {
        return await import("./strudel-eval.js");
      } finally {
        console.log = log;
        console.info = info;
      }
    })();
  }
  return evaluator;
}

const SAMPLES = new Set(strudelSounds.samples as string[]);
const GM = new Set(strudelSounds.gm as string[]);
const SYNTHS = new Set(strudelSounds.synths as string[]);
const DRUM_BANKS = new Set(strudelSounds.drumBanks as string[]);

/** Sounds prebake() registers by name, with no bank qualifier. */
function isRegistered(name: string): boolean {
  return SAMPLES.has(name) || GM.has(name) || SYNTHS.has(name);
}

/**
 * Pull a source position out of whatever the transpiler threw.
 *
 * Acorn (which @strudel/transpiler parses with) attaches `loc`; other layers
 * only put the position in the message, as the trailing `(line:column)` that
 * V8 prints for a SyntaxError.
 */
function positionOf(err: unknown): { line?: number; column?: number } {
  const loc = (err as { loc?: { line?: number; column?: number } })?.loc;
  if (typeof loc?.line === "number") {
    return { line: loc.line, column: loc.column };
  }
  const message = (err as Error)?.message ?? "";
  const match = /\((\d+):(\d+)\)\s*$/.exec(message);
  if (match) return { line: Number(match[1]), column: Number(match[2]) };
  return {};
}

function describe(err: unknown): string {
  const e = err as Error;
  const name = e?.name;
  const message = e?.message ?? String(err);
  return name && name !== "Error" && !message.startsWith(name)
    ? `${name}: ${message}`
    : message;
}

/** Strudel logs query-time failures instead of rethrowing them out of queryArc. */
const LOGGED_ERROR = /^\[[^\]]+\]\s*error:\s*(.+)$/;

function loggedError(logs: string[]): string | undefined {
  for (const line of logs) {
    const match = LOGGED_ERROR.exec(line.trim());
    if (match) return match[1];
  }
  return undefined;
}

/**
 * Evaluate `code` and report what it does.
 *
 * Never throws: a broken pattern is a result, not an exception. The hard bound
 * on a runaway pattern lives in strudel-eval's span guard (a Promise.race
 * cannot interrupt a synchronous queryArc); the race here is the outer
 * backstop for anything that hangs on the async side of evaluate().
 */
export async function validateStrudelCode(
  code: string,
  { cycles = 4, timeoutMs = 3000 }: ValidateOptions = {},
): Promise<StrudelValidation> {
  const deadline = Date.now() + timeoutMs;
  // Held so the timeout below can abort a query that is already running: the
  // span guard checks `abort` on every splitQueries.
  let started: StrudelTrace | undefined;

  const run = async (): Promise<StrudelValidation> => {
    const { createTrace, evalStrudel, queryHaps, runTraced, setupStrudel } =
      await loadEvaluator();
    const trace = createTrace({ deadline });
    started = trace;
    return runTraced(trace, async () => {
      await setupStrudel();
      const { pattern, error } = await evalStrudel(code);
      if (error || !pattern) {
        return {
          ok: false,
          error: {
            message: describe(error ?? new Error("evaluated to a non-Pattern")),
            ...positionOf(error),
          },
          ...context(trace),
        };
      }

      const { haps, error: queryError } = queryHaps(pattern, cycles);
      // Three ways a query can fail, in order of how loudly it complains:
      // it threw; the span guard aborted it; or Strudel caught something,
      // logged it, and quietly handed back zero events.
      const failure =
        (queryError && describe(queryError)) ??
        trace.abort ??
        loggedError(trace.logs);
      if (failure) {
        return {
          ok: false,
          error: { message: failure },
          ...context(trace),
        };
      }

      const sounds = new Set<string>();
      const unregistered = new Set<string>();
      let onsets = 0;
      let usesNotes = false;
      for (const hap of haps) {
        if (typeof hap?.hasOnset !== "function" || hap.hasOnset()) onsets++;
        const value = hap?.value as
          | { s?: unknown; bank?: unknown; note?: unknown; n?: unknown }
          | undefined;
        if (value?.note !== undefined) usesNotes = true;
        const s = value?.s;
        if (typeof s !== "string") continue;
        const bank = typeof value?.bank === "string" ? value.bank : undefined;
        sounds.add(bank ? `${bank}:${s}` : s);
        // `.bank("RolandTR909")` keeps value.s as the bare "bd" and resolves it
        // against the bank at play time, so the bank is what we can check.
        if (bank) {
          if (!DRUM_BANKS.has(bank)) unregistered.add(`${bank}:${s}`);
        } else if (!isRegistered(s)) {
          unregistered.add(s);
        }
      }

      return {
        ok: true,
        eventsPerCycle: Math.round((onsets / cycles) * 10) / 10,
        sounds: [...sounds].sort(),
        // samples() registers names we cannot see from here, so anything
        // "unknown" may well be one of them: unverifiable, not wrong.
        ...(trace.sampleUrls.length ? {} : { unregistered: [...unregistered].sort() }),
        usesNotes,
        ...context(trace),
      };
    });
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<StrudelValidation>((resolve) => {
        timer = setTimeout(() => {
          if (started) started.abort = "evaluation timed out";
          resolve({
            ok: false,
            error: { message: `evaluation timed out after ${timeoutMs}ms` },
          });
        }, timeoutMs);
      }),
    ]);
  } catch (err) {
    // Defensive: nothing above is expected to throw, but a validator that
    // throws would turn a bad pattern into a failed tool call.
    return { ok: false, error: { message: describe(err) } };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The bits of a trace that are worth reporting whether or not the code ran. */
function context(trace: {
  cps?: number;
  usesHydra: boolean;
  visuals: string[];
  stackArity: number;
  sampleUrls: string[];
}): Partial<StrudelValidation> {
  return {
    ...(trace.stackArity > 0 ? { layers: trace.stackArity } : {}),
    ...(trace.cps !== undefined ? { cps: trace.cps } : {}),
    ...(trace.usesHydra ? { usesHydra: true } : {}),
    ...(trace.visuals.length ? { visuals: [...trace.visuals] } : {}),
    ...(trace.sampleUrls.length ? { sampleUrls: [...trace.sampleUrls] } : {}),
  };
}
