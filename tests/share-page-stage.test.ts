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
