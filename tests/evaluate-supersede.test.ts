// =============================================================================
// A tool cancel that lands WHILE a pattern is evaluating must stay cancelled.
//
// repl.evaluate() transpiles and evaluates asynchronously and starts the
// scheduler only at its END. ontoolcancelled bumps renderGeneration and stops
// the editor — but that stop ran before the start, so the cancelled pattern
// played anyway, the status flipped to "Playing..." and the model was told
// "playing" (reproduced in the dev harness with a Hydra pattern).
//
// String assertions can't prove where a check sits relative to an await, so
// this EXECUTES the widget's own installEvaluateHook + evaluationSuperseded,
// extracted from src/strudel-app.ts and run in a node:vm context over stubs —
// the same approach as recording-mime / strudel-fallback-autoplay. The fake
// editor's evaluate() starts its scheduler only when the test resolves it,
// which is exactly the ordering repl.evaluate() has.
// =============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { transformWithOxc } from "vite";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(
  fileURLToPath(new URL("../src/strudel-app.ts", import.meta.url)),
  "utf8",
);

function extract(signature: string): string {
  const start = SRC.indexOf(signature);
  expect(start, `${signature} not found in strudel-app.ts`).toBeGreaterThanOrEqual(0);
  return SRC.slice(start, SRC.indexOf("\n}\n", start) + 2);
}

const SEQ_DECL = /^let evaluationSeq = 0;$/m.exec(SRC)?.[0] ?? "";

const HOOK_TS = [
  SEQ_DECL,
  extract("function evaluationSuperseded("),
  extract("function installEvaluateHook("),
].join("\n");

it("found the evaluation counter (a rename must fail here, not silently pass)", () => {
  expect(SEQ_DECL).toBe("let evaluationSeq = 0;");
});

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function loadHook() {
  const js = (await transformWithOxc(HOOK_TS, "hook.ts")).code;
  const log = {
    reports: [] as string[],
    stops: 0,
    hydraStruck: 0,
    stateReports: 0,
  };
  const scheduler = { started: false };
  const pending: Deferred[] = [];
  let settle: Deferred | null = null;

  // What the extracted functions read and write as free identifiers.
  const ctx = vm.createContext({
    log,
    scheduler,
    pending,
    getSettle: () => settle,
    Error,
    Promise,
  });
  vm.runInContext(
    `
    let renderGeneration = 0;
    let isPlaying = false;
    let audioBlocked = false;
    let audibleStatus = null;
    let currentCode = "";
    let missingSoundReported = false;
    let missingSoundTimer = null;
    const missingSounds = new Set();
    const AUDIO_SETTLE_MS = 300;
    const installEvalScopeHooks = () => {};
    const snapshotStrudelGlobals = () => {};
    const stageVisuals = () => {};
    const applyRuntimeTempo = () => false;
    const isSchedulerStarted = () => scheduler.started;
    const ensureAudioRunning = () => getSettle()?.promise ?? Promise.resolve(true);
    const reportEvaluation = (code, err) => { log.reports.push(err ? "error" : "ok:" + code); };
    const setHydraActive = (on) => { if (!on) log.hydraStruck++; };
    const renderPlayButton = () => {};
    const scheduleStateReport = () => { log.stateReports++; };
    ${js}
    globalThis.api = {
      installEvaluateHook,
      cancel: () => { renderGeneration++; },
      isPlaying: () => isPlaying,
    };
    `,
    ctx,
  );
  const api = (ctx as any).api;

  // A StrudelMirror stand-in: evaluate() resolves when the test says so, and
  // only THEN starts the scheduler — repl.evaluate()'s real ordering.
  const editor: any = {
    code: "s(\"bd\")",
    evaluate(shouldPlay: boolean) {
      const d = deferred();
      pending.push(d);
      return d.promise.then(() => {
        if (shouldPlay) scheduler.started = true;
      });
    },
    stop() {
      log.stops++;
      scheduler.started = false;
    },
  };
  api.installEvaluateHook(editor);
  const holdSettle = () => {
    settle = deferred();
    return settle;
  };
  return { api, editor, log, scheduler, pending, holdSettle };
}

describe("an evaluation superseded while in flight", () => {
  it("control: an evaluation nobody cancelled plays and reports once", async () => {
    const { editor, log, scheduler, pending } = await loadHook();
    const run = editor.evaluate(true);
    pending[0].resolve();
    await run;
    expect(scheduler.started).toBe(true);
    expect(log.reports).toEqual(['ok:s("bd")']);
    expect(log.stops).toBe(0);
  });

  it("a cancel during evaluation keeps the pattern stopped and reports nothing", async () => {
    const { api, editor, log, scheduler, pending } = await loadHook();
    const run = editor.evaluate(true);
    // ontoolcancelled: bump the generation, stop — BEFORE the scheduler starts.
    api.cancel();
    editor.stop();
    pending[0].resolve(); // repl.evaluate() finishes and starts the scheduler
    await run;
    expect(scheduler.started).toBe(false);
    expect(api.isPlaying()).toBe(false);
    expect(log.reports).toEqual([]); // no "playing" for a cancelled call
    expect(log.hydraStruck).toBe(1);
  });

  it("a cancel during the audio settle is caught too", async () => {
    const { api, editor, log, scheduler, pending, holdSettle } = await loadHook();
    const settle = holdSettle();
    const run = editor.evaluate(true);
    pending[0].resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduler.started).toBe(true); // now waiting on ensureAudioRunning
    api.cancel();
    settle.resolve();
    await run;
    expect(scheduler.started).toBe(false);
    expect(log.reports).toEqual([]);
  });

  it("leaves a NEWER evaluation's scheduler alone", async () => {
    const { api, editor, log, scheduler, pending } = await loadHook();
    const stale = editor.evaluate(true);
    api.cancel();
    editor.code = 'note("c e g")';
    const fresh = editor.evaluate(true); // e.g. the user pressed Play after the cancel
    pending[1].resolve();
    await fresh;
    pending[0].resolve();
    await stale;
    expect(scheduler.started).toBe(true);
    expect(log.stops).toBe(0);
    expect(log.reports).toEqual(['ok:note("c e g")']);
  });
});
