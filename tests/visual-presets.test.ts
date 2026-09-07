import { describe, expect, it } from "vitest";
import {
  applyVisualPreset,
  EDITOR_THEMES,
  HYDRA_SYNTH_CDN,
  isHydraPreset,
  isVisualPreset,
  VISUAL_PRESETS,
  VISUAL_PRESET_BLURBS,
} from "../src/shared/visual-presets";
import { detectViz } from "../src/shared/viz-detect";
import { playLiveInputSchema } from "../src/shared/tool-defs";

const PLAIN = 's("bd*2 [~ sd]").bank("RolandTR909")';

describe("applyVisualPreset — draw presets", () => {
  it("appends an all(...) draw call to a pattern with no visual", () => {
    const out = applyVisualPreset(PLAIN, "pianoroll");
    expect(out).toContain(PLAIN);
    expect(out).toContain("all(p => p.pianoroll({ fold: 1 }))");
    // The widget's own detector must see what the preset added, or the backdrop
    // never reveals.
    expect(detectViz(out).strudelViz).toBe(true);
  });

  it("covers every draw preset", () => {
    for (const preset of ["pianoroll", "punchcard", "scope", "spectrum"] as const) {
      const out = applyVisualPreset(PLAIN, preset);
      expect(out).toContain(`p.${preset}(`);
      expect(detectViz(out).strudelViz).toBe(true);
    }
  });

  it("leaves a pattern that already draws alone", () => {
    const own = 'note("c3 e3").pianoroll({ cycles: 4 })';
    expect(applyVisualPreset(own, "punchcard")).toBe(own);
    // Two draw methods share one canvas and fight over clearRect.
    expect(applyVisualPreset(own, "scope")).toBe(own);
  });

  it("ignores a commented-out draw method (that canvas would stay blank)", () => {
    const commented = `${PLAIN}\n// .pianoroll()`;
    expect(applyVisualPreset(commented, "pianoroll")).toContain("all(p => p.pianoroll(");
  });
});

describe("applyVisualPreset — hydra presets", () => {
  it("prepends the recipe with initHydra() on the first line", () => {
    const out = applyVisualPreset(PLAIN, "hydra-kaleid");
    expect(out.split("\n")[0]).toContain("await initHydra(");
    expect(out).toContain(PLAIN);
    expect(detectViz(out).hydra).toBe(true);
  });

  it("pins hydra-synth in every hydra recipe", () => {
    for (const preset of VISUAL_PRESETS.filter(isHydraPreset)) {
      const out = applyVisualPreset(PLAIN, preset);
      expect(out).toContain(HYDRA_SYNTH_CDN);
      // Unversioned specifiers are exactly what the pin exists to avoid.
      expect(out).not.toContain("src: 'https://unpkg.com/hydra-synth'");
    }
  });

  it("SINGLE-quotes the pinned URL", () => {
    // Strudel's transpiler rewrites DOUBLE-quoted strings into mini-notation, so
    // src: "https://…" is parsed as a pattern and kills the whole evaluation:
    //   [mini] parse error at line 1: … but "/" found
    // Caught in the dev harness; this guards the regression.
    for (const preset of VISUAL_PRESETS.filter(isHydraPreset)) {
      const out = applyVisualPreset(PLAIN, preset);
      expect(out).toContain(`src: '${HYDRA_SYNTH_CDN}'`);
      expect(out).not.toContain(`src: "${HYDRA_SYNTH_CDN}"`);
      expect(out).not.toMatch(/"https?:\/\//);
    }
  });

  it("gives hydra-feed something to texture", () => {
    // feedStrudel pipes the STRUDEL DRAW CANVAS into s0 — with no draw method
    // there is nothing to mirror, so the preset supplies a piano roll.
    const out = applyVisualPreset(PLAIN, "hydra-feed");
    expect(out).toContain("feedStrudel: true");
    expect(detectViz(out)).toEqual({ strudelViz: true, hydra: true, any: true });
  });

  it("does not add a second roll when the pattern already draws", () => {
    const own = `${PLAIN}\nnote("c3 e3").pianoroll()`;
    const out = applyVisualPreset(own, "hydra-feed");
    expect(out.match(/pianoroll\(/g)).toHaveLength(1);
  });

  it("uses a collision-resistant variable name in hydra-pulse", () => {
    const out = applyVisualPreset(PLAIN, "hydra-pulse");
    // The preset is prepended to code written without knowledge of it, so the
    // guide's bare `pulse` would be a plausible clash.
    expect(out).toContain("_vizPulse");
    expect(out).not.toMatch(/^const pulse =/m);
  });

  it("leaves a pattern that already drives its own shader alone", () => {
    const own = `await initHydra()\nosc(8).out(o0)\n\n${PLAIN}`;
    expect(applyVisualPreset(own, "hydra-wash")).toBe(own);
  });

  it("skips hydra presets under reduced motion but keeps draw presets", () => {
    expect(applyVisualPreset(PLAIN, "hydra-kaleid", { allowHydra: false })).toBe(PLAIN);
    expect(applyVisualPreset(PLAIN, "pianoroll", { allowHydra: false })).not.toBe(PLAIN);
  });
});

describe("applyVisualPreset — no-ops", () => {
  it("returns the code unchanged for none / undefined / unknown values", () => {
    // An unknown value is a stale enum from an older client: degrade to plain
    // playback rather than throwing.
    for (const preset of ["none", undefined, null, "", "pianoRoll", 42]) {
      expect(applyVisualPreset(PLAIN, preset)).toBe(PLAIN);
    }
  });
});

describe("preset + theme metadata", () => {
  it("has a blurb for every preset", () => {
    for (const preset of VISUAL_PRESETS) {
      expect(VISUAL_PRESET_BLURBS[preset]).toBeTruthy();
    }
  });

  it("isVisualPreset only accepts the enum", () => {
    expect(VISUAL_PRESETS.every(isVisualPreset)).toBe(true);
    expect(isVisualPreset("hydra")).toBe(false);
    expect(isVisualPreset(undefined)).toBe(false);
  });

  it("classifies hydra presets by prefix", () => {
    expect(VISUAL_PRESETS.filter(isHydraPreset)).toEqual([
      "hydra-kaleid",
      "hydra-pulse",
      "hydra-wash",
      "hydra-feed",
    ]);
  });

  it("lists the themes the live @strudel/repl@1.3.0 bundle actually ships", () => {
    // Verified by reading Object.keys(themes) inside the widget iframe in the
    // dev harness — NOT from upstream docs, which also list `duotoneLight`.
    expect(EDITOR_THEMES).toHaveLength(39);
    expect(EDITOR_THEMES).toContain("strudelTheme");
    expect(EDITOR_THEMES).toContain("githubLight");
    expect(EDITOR_THEMES).not.toContain("duotoneLight");
    expect(new Set(EDITOR_THEMES).size).toBe(EDITOR_THEMES.length);
  });
});

describe("play-live-pattern schema", () => {
  it("accepts the new visuals + theme parameters", () => {
    const parsed = playLiveInputSchema.parse({
      code: PLAIN,
      title: "Test",
      visuals: "hydra-kaleid",
      theme: "nord",
    });
    expect(parsed.visuals).toBe("hydra-kaleid");
    expect(parsed.theme).toBe("nord");
  });

  it("both are optional", () => {
    expect(playLiveInputSchema.parse({ code: PLAIN }).visuals).toBeUndefined();
  });

  it("rejects values outside the enums", () => {
    expect(() => playLiveInputSchema.parse({ code: PLAIN, visuals: "sparkles" })).toThrow();
    expect(() => playLiveInputSchema.parse({ code: PLAIN, theme: "duotoneLight" })).toThrow();
  });
});
