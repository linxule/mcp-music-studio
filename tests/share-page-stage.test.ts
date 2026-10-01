// The share page carries the stage runtime as a generated bundle
// (scripts/build-stage-runtime.mjs → src/generated/stage-runtime-js.ts), not a
// hand-kept copy. Hold it to its sources and prove it runs.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { STAGE_RUNTIME_INPUTS_HASH, STAGE_RUNTIME_JS } from "../src/generated/stage-runtime-js";
import { generateStrudelPlayerHtml } from "../src/strudel-browser-fallback";

const INPUTS = [
  "src/shared/stage-runtime.ts",
  "src/shared/stage-runtime-global.ts",
  "src/shared/hap-number.ts",
  "src/shared/tts.ts",
  "src/shared/sample-url-fix.ts",
];

describe("share page stage runtime", () => {
  it("is built from the current sources (run `bun scripts/build-stage-runtime.mjs`)", () => {
    const hash = createHash("sha256");
    for (const file of INPUTS) hash.update(readFileSync(file));
    expect(STAGE_RUNTIME_INPUTS_HASH).toBe(hash.digest("hex").slice(0, 16));
  });

  it("runs, and drives the same frame/event/commit semantics as the widget's", () => {
    const sandbox: Record<string, any> = {};
    vm.runInNewContext(STAGE_RUNTIME_JS, sandbox);
    const { createStage } = sandbox.MusicStudioStage;
    const frames: Array<(ms: number) => void> = [];
    let cycle = 0;
    const stage = createStage({
      audibleCycle: () => cycle,
      isPlaying: () => true,
      requestFrame: (cb: (ms: number) => void) => frames.push(cb),
      cancelFrame: () => {},
      listenTaps: () => () => {},
      reportError: () => {},
    });
    const seen: string[] = [];
    // A pattern stand-in: one onset per quarter cycle.
    const quarters = {
      queryArc: (a: number, b: number) => {
        const out = [];
        for (let q = Math.ceil(a * 4); q / 4 < b; q++) {
          out.push({ whole: { begin: q / 4 }, part: { begin: q / 4 }, hasOnset: () => true, duration: 0.25, value: { note: "c3" } });
        }
        return out;
      },
    };
    stage.begin();
    stage.globals.onEvent(quarters, (e: { cycle: number; midi: number }) => seen.push(`${e.cycle}:${e.midi}`));
    stage.commit();
    for (const c of [0, 0.3, 0.6]) {
      cycle = c;
      frames.shift()?.(c * 1000);
    }
    expect(seen).toEqual(["0:48", "0.25:48", "0.5:48"]);
  });

  it("is inlined into the standalone page, hooked into evaluation, and cannot close its <script>", () => {
    const html = generateStrudelPlayerHtml({ code: 'note("c3 e3")' } as any);
    expect(html).toContain(STAGE_RUNTIME_JS);
    expect(STAGE_RUNTIME_JS).not.toMatch(/<\/script/i);
    expect(html).toContain("hookStage(ed);");
    expect(html).toContain("Object.assign(globalThis, stage.globals);");
  });
});

describe("share page evaluate wrapper (0.7.0 gauntlet)", () => {
  it("serialises evaluations, so one never commits another's registrations", async () => {
    const html = generateStrudelPlayerHtml({ code: 's("bd")' } as any);
    const start = html.indexOf("function hookStage(ed) {");
    const end = html.indexOf("// stage:end");
    const source = html.slice(start, end);
    const log: string[] = [];
    let current = "";
    const stage = {
      begin: () => log.push(`begin`),
      commit: () => log.push(`commit:${current}`),
      rollback: () => log.push(`rollback:${current}`),
    };
    const releases: Array<() => void> = [];
    const ed: any = {
      repl: { state: {} as Record<string, unknown> },
      evaluate: (which: string) =>
        new Promise<void>((resolve) => {
          releases.push(() => {
            current = which;
            ed.repl.state = which === "B" ? { evalError: new Error("broken") } : {};
            resolve();
          });
        }),
    };
    const ctx = vm.createContext({
      stage,
      Promise,
      getLiveCode: () => 's("bd")',
      setStatus: () => {},
      stageBundle: { speechReady: async () => {} },
    });
    vm.runInContext(`${source}; hookStage(ed)`, Object.assign(ctx, { ed }));
    const a = ed.evaluate("A");
    const b = ed.evaluate("B");
    await new Promise((r) => setTimeout(r, 0));
    // Only A has started: B waits its turn instead of sharing A's pending set.
    expect(releases).toHaveLength(1);
    releases[0]();
    await a;
    await new Promise((r) => setTimeout(r, 0));
    releases[1]();
    await b;
    expect(log).toEqual(["begin", "commit:A", "begin", "rollback:B"]);
  });
});

describe("the standalone page's scripts parse", () => {
  // The page script lives inside a TS template literal: a single `\b` in a
  // regex there became a backspace and broke the WHOLE script (0.7.0, caught
  // before release). Parse every inline script of a real generated page.
  it.each([{ code: 's("bd")' }, { code: 'say(\'hi\'); s("bd")', bpm: 120, visuals: "pianoroll" }])(
    "%o",
    (opts) => {
      const html = generateStrudelPlayerHtml(opts as any);
      const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/g)];
      expect(scripts.length).toBeGreaterThanOrEqual(2);
      for (const [, src] of scripts) expect(() => new vm.Script(src)).not.toThrow();
    },
  );
});
