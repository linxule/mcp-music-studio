/**
 * @file Share links get the widget's visuals (0.5.12): a live audio-reactive
 * `a` instead of a silent stand-in, H() that turns notes into numbers, and
 * extra getDrawContext('name') layers.
 *
 * The page's script is an inline string, so it carries copies of the widget's
 * pure helpers. These run each `// x:begin … // x:end` block in node:vm and
 * hold it to the shared module it copies, so the two can't drift.
 */
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { generateStrudelPlayerHtml } from "../src/strudel-browser-fallback";
import { AUDIO_ANALYSER, AUDIO_DEFAULTS, bandLevels, stepBands } from "../src/shared/audio-bands";
import { hapNumber } from "../src/shared/hap-number";
import { drawLayerIds } from "../src/shared/viz-detect";

const html = generateStrudelPlayerHtml({ code: 's("bd sd").pianoroll()' });

function block(name: string): string {
  const start = html.indexOf(`// ${name}:begin`);
  const end = html.indexOf(`// ${name}:end`);
  expect(start, `${name} block`).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

function initData() {
  const m = html.match(/<script type="application\/json" id="init-data">([\s\S]*?)<\/script>/);
  return JSON.parse(m![1]!);
}

/** Run the `a` block with no audio and no animation frames. */
function runAudioBlock() {
  const sandbox: Record<string, unknown> = {
    INIT: initData(),
    document: { body: { classList: { contains: () => false } } },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(block("a"), sandbox);
  return sandbox;
}

describe("share page `a` (audio-reactive)", () => {
  it("ships the widget's analyser settings and defaults", () => {
    const init = initData();
    expect(init.audio).toEqual({ analyser: AUDIO_ANALYSER, defaults: AUDIO_DEFAULTS });
  });

  it("computes the same bands as the widget, frame for frame", () => {
    const sandbox = runAudioBlock();
    const pageLevels = sandbox.bandLevels as typeof bandLevels;
    const pageStep = sandbox.stepBands as typeof stepBands;
    // A fixed pseudo-random spectrum: 1024 bins, as the 2048-point FFT gives.
    const bytes = Array.from({ length: 1024 }, (_, i) => (i * 97 + 13) % 256);
    for (const count of [4, 6]) {
      const want = bandLevels(bytes, 48000, 2048, count);
      const got = Array.from(pageLevels(bytes, 48000, 2048, count, 20, 12000));
      expect(got).toEqual(want);
      const settings = Array.from({ length: count }, () => ({ cutoff: 2, scale: 10, smooth: 0.4 }));
      const prev = Array.from({ length: count }, (_, i) => i * 0.5);
      const [wb, wf, gb, gf] = [[], [], [], []] as number[][];
      const wantVol = stepBands(want, prev, settings, 15, wb, wf);
      const gotVol = pageStep(want, prev, settings, 15, gb, gf);
      expect(gotVol).toBe(wantVol);
      expect(gb).toEqual(wb);
      expect(gf).toEqual(wf);
    }
  });

  it("publishes a live `a` with hydra's API, not the old all-zero stub", () => {
    const sandbox = runAudioBlock();
    const a = sandbox.a as {
      fft: number[];
      setBins(n: number): void;
      setCutoff(v: number): void;
      settings: { cutoff: number }[];
    };
    expect(a.fft).toHaveLength(4);
    a.setBins(6);
    expect(a.fft).toHaveLength(6);
    a.fft[5] = 0.5;
    expect((sandbox.a5 as (s?: number, o?: number) => () => number)(2, 1)()).toBe(2);
    a.setCutoff(3);
    expect(a.settings.every((s) => s.cutoff === 3)).toBe(true);
    a.setBins(2);
    expect(sandbox.a5).toBeUndefined();
  });
});

describe("share page H() values", () => {
  it("turns hap values into numbers exactly as the widget does", () => {
    const sandbox: Record<string, unknown> = {};
    vm.runInNewContext(block("hap"), sandbox);
    const pageHap = sandbox.hapNumber as typeof hapNumber;
    for (const value of [
      0.5, "3", "-1.5", "c3", "e3", "a4", "eb4", "f#2", "cs3", "bf3", "C-1",
      { note: "g3" }, { note: 60 }, { n: 4 }, { freq: 440 }, { freq: 220 },
      "bd", { s: "bd" }, undefined, null, Number.NaN,
      { note: "c3", freq: 440 }, "c-", { freq: Infinity },
    ]) {
      expect(pageHap(value), JSON.stringify(value)).toBe(hapNumber(value));
    }
    expect(html).toContain("return hapNumber(sample());");
  });
});

describe("share page extra layers", () => {
  function pageLayerIds() {
    const stripStart = html.indexOf("function stripComments(code) {");
    const stripEnd = html.indexOf("\n  }\n", stripStart) + "\n  }".length;
    const sandbox: Record<string, unknown> = { document: { body: {} } };
    vm.runInNewContext(html.slice(stripStart, stripEnd) + "\n" + block("layers"), sandbox);
    return sandbox.drawLayerIds as typeof drawLayerIds;
  }

  it("never hides a layer the widget would keep (it may keep more)", () => {
    // The page reads the RAW code: a '//' inside a URL string used to swallow
    // the rest of the line, and with it a call still in use (Codex). So a
    // commented-out call may keep a layer showing — the safe direction.
    const ids = pageLayerIds();
    for (const code of [
      `s("bd")`,
      `getDrawContext()`,
      `x.pianoroll({ ctx: getDrawContext('roll') }); y.spiral({ ctx: getDrawContext("spin", { pixelated: true }) })`,
      `getDrawContext('roll'); getDrawContext('roll')`,
      `getDrawContext(name)`,
      `// getDrawContext(name)\ns("bd")`,
      `samples('https://example.com/x'); note("c3").pianoroll({ ctx: getDrawContext('roll') })`,
    ]) {
      const page = ids(code);
      const widget = drawLayerIds(code);
      if (page === null) continue; // keeps every layer
      expect(widget, code).not.toBeNull();
      for (const id of widget!) expect(page, code).toContain(id);
    }
    expect(ids(`samples('https://example.com/x'); note("c3").pianoroll({ ctx: getDrawContext('roll') })`)).toEqual(["roll"]);
  });

  it("prunes after a successful play and clears on Stop", () => {
    // With the code this Play evaluated, not the buffer as it is afterwards.
    expect(html).toMatch(/const evaluated = getLiveCode\(ed\);/);
    expect(html).toMatch(/applyRuntimeTempo\(ed\);\s*pruneLayers\(evaluated\);/);
    expect(html).toMatch(/ed\.stop\(\);\s*clearLayers\(\);/);
  });
});
