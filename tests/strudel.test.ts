import { describe, expect, it } from "vitest";
import { handlePlayLivePattern, handleGetStrudelGuide } from "../server";
import {
  STRUDEL_GUIDE_TOPICS,
  STRUDEL_GUIDES,
} from "../src/strudel-guide";
import {
  GET_STRUDEL_GUIDE_DESCRIPTION,
  PLAY_LIVE_BASE_DESCRIPTION,
  PLAY_LIVE_EXT_APPS_SUFFIX,
} from "../src/shared/tool-defs";
import { EDITOR_THEMES, VISUAL_PRESETS } from "../src/shared/visual-presets";

describe("play-live-pattern handler", () => {
  it("returns text result with title", async () => {
    const result = await handlePlayLivePattern({
      code: 's("bd sd")',
      title: "Test Beat",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain('"Test Beat"');
    expect(result.content[0]?.text).toContain("Strudel pattern ready");
  });

  it("reports what the pattern actually does", async () => {
    const result = await handlePlayLivePattern({ code: 's("bd sd")' });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe(
      "Strudel pattern ready — parses OK: 2 events/cycle, sounds: bd sd (all registered).\n" +
        "It plays in an editable REPL widget in MCP-app hosts " +
        "(e.g. Claude Desktop, claude.ai). The server cannot tell whether a player rendered: if the user " +
        "reports no player, this client can't play it inline and nothing has played yet.",
    );
  });

  it("falls back to the neutral receipt when validation is skipped", async () => {
    const result = await handlePlayLivePattern({ code: 's("bd sd")' }, false);

    expect(result.content[0]?.text).toBe(
      "Strudel pattern ready. It plays in an editable REPL widget in MCP-app hosts " +
        "(e.g. Claude Desktop, claude.ai). The server cannot tell whether a player rendered: if the user " +
        "reports no player, this client can't play it inline and nothing has played yet.",
    );
    expect(result.content[0]?.text).not.toContain('"');
  });

  it("marks code that does not evaluate as an error", async () => {
    const result = await handlePlayLivePattern({ code: 's("bd sd"]' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("failed to evaluate");
    // Still honest about playback, so attachPlayLink can swap that sentence
    // for the click-to-play link.
    expect(result.content[0]?.text).toContain("nothing has played yet");
  });
});

describe("get-strudel-guide handler", () => {
  it("returns content for every topic", async () => {
    for (const topic of STRUDEL_GUIDE_TOPICS) {
      const result = await handleGetStrudelGuide({ topic });

      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0]?.type).toBe("text");
      expect(result.content[0]?.text).toBe(STRUDEL_GUIDES[topic]);
      expect(result.content[0]?.text.length).toBeGreaterThan(0);
    }
  });

  it("covers all 8 topics", () => {
    expect(STRUDEL_GUIDE_TOPICS).toHaveLength(8);
    expect(STRUDEL_GUIDE_TOPICS).toContain("visuals");
  });
});

describe("strudel visualization guidance (v0.4.1, moved to 'visuals' in v0.5)", () => {
  const visuals = STRUDEL_GUIDES.visuals;

  it("encourages visualization with concrete methods", () => {
    expect(visuals).toContain(".pianoroll()");
    expect(visuals).toContain(".punchcard()");
    expect(visuals).toContain(".scope()");
    expect(visuals).toContain(".spectrum()");
  });

  it("no longer claims visuals are suppressed/hidden in ext-apps", () => {
    for (const text of [visuals, STRUDEL_GUIDES.advanced]) {
      const lower = text.toLowerCase();
      expect(lower).not.toContain("suppress");
      expect(lower).not.toContain("canvas is hidden");
      expect(lower).not.toContain("open in browser");
    }
  });

  it("documents the one-draw-method-per-pattern rule", () => {
    expect(visuals.toLowerCase()).toContain("one draw method");
  });

  it("nudges visualization + Hydra from the play-live tool description", () => {
    expect(PLAY_LIVE_BASE_DESCRIPTION).toContain("pianoroll");
    expect(PLAY_LIVE_BASE_DESCRIPTION).toContain("initHydra");
    expect(PLAY_LIVE_BASE_DESCRIPTION).toContain("'visuals'");
  });

  it("advertises the visuals + theme parameters and the audio-reactive path", () => {
    expect(PLAY_LIVE_BASE_DESCRIPTION).toContain("`visuals`");
    expect(PLAY_LIVE_BASE_DESCRIPTION).toContain("`theme`");
    expect(PLAY_LIVE_BASE_DESCRIPTION).toContain("a.fft[0]");
    // Claude Code truncates a tool description at 2KB, and the widget variant
    // is the longest one actually registered.
    expect((PLAY_LIVE_BASE_DESCRIPTION + PLAY_LIVE_EXT_APPS_SUFFIX).length).toBeLessThan(2048);
  });

  it("says the visuals topic covers audio-reactive shaders", () => {
    expect(GET_STRUDEL_GUIDE_DESCRIPTION).toContain("audio-reactive shaders");
  });
});

describe("visuals guide topic", () => {
  const text = STRUDEL_GUIDES.visuals;

  it("teaches both layers: draw methods and Hydra", () => {
    expect(text).toContain(".pianoroll()");
    expect(text).toContain("await initHydra()");
    expect(text).toContain("feedStrudel");
    expect(text).toContain("H(");
  });

  it("still tells the agent not to reach for the microphone", () => {
    expect(text.toLowerCase()).toContain("microphone");
    expect(text).toContain("detectAudio: true");
    // ...but the mic is no longer the topic's answer to "how do I react to
    // audio" — `a` is, and it is wired to Strudel's own output bus.
    expect(text).toContain("never the microphone");
  });

  it("every Hydra recipe starts with initHydra and ends a chain with .out(o0)", () => {
    const recipes = text.split("### Recipe:").slice(1);
    expect(recipes.length).toBeGreaterThanOrEqual(4);
    for (const r of recipes) {
      expect(r).toMatch(/await initHydra\(/);
      expect(r).toContain(".out(o0)");
    }
  });

  it("documents the audio-reactive `a` object the widget installs", () => {
    for (const member of [
      "a.fft[0..3]",
      "a.bins",
      "a.vol",
      "a.setSmooth(x)",
      "a.setCutoff(x)",
      "a.setScale(x)",
      "a.setBins(n)",
      "a.show()",
      "a.hide()",
      "a0(scale, off)",
      "a3(scale, off)",
    ]) {
      expect(text, member).toContain(member);
    }
    // The value semantics have to match src/strudel-app.ts, or tuning advice
    // ported from hydra docs stops applying.
    expect(text).toContain("fft[i] = max(0, (bins[i] - cutoff) / scale)");
    expect(text).toContain("(default 0.4)");
    expect(text).toContain("(default 2)");
    expect(text).toContain("(default 10)");
    expect(text).toContain("(default 4)");
  });

  it("insists the audio value is passed as a function, not read once", () => {
    expect(text).toContain("() => a.fft[0]");
    expect(text).toContain("PASS IT AS A FUNCTION");
  });

  it("carries the kick-driven shader recipe and its modulateScale variation", () => {
    const recipe = text.split("### Recipe: kick-driven kaleidoscope")[1] ?? "";
    expect(recipe).toContain("await initHydra()");
    expect(recipe).toContain("osc(10, 0, () => a.fft[0] * 4)");
    expect(recipe).toContain(".kaleid(3)");
    expect(recipe).toContain(".out(o0)");
    // a TR808 kick is what fft[0] is listening to
    expect(recipe).toContain('s("bd*4").bank("RolandTR808")');
    expect(recipe).toContain(".modulateScale(osc(2), () => a.fft[1])");
  });

  it("documents every value of the visuals enum", () => {
    for (const preset of VISUAL_PRESETS) expect(text, preset).toContain(preset);
    expect(text).toContain("prefers-reduced-motion");
    // the preset is a floor: hand-written visuals stay the recommended path
    expect(text).toContain("a floor, not a ceiling");
  });

  it("lists every editor theme the widget accepts, and pairs some with moods", () => {
    const block = text.split("## The \`theme\` parameter")[1]?.split("## Stage mode")[0] ?? "";
    expect(block.length).toBeGreaterThan(0);
    for (const theme of EDITOR_THEMES) expect(block, theme).toContain(theme);
    for (const pairing of ["teletext", "sonicPink", "nord", "gruvboxDark"]) {
      expect(block, pairing).toMatch(new RegExp(`${pairing}[\\s\\S]{0,80}(chiptune|synthwave|ambient|lofi)`));
    }
  });

  it("mentions stage mode so visuals are written to stand alone", () => {
    expect(text).toContain("## Stage mode");
    expect(text).toContain("fullscreen");
  });

  it("warns that plain strings need single quotes (mini-notation gotcha)", () => {
    for (const topic of [text, STRUDEL_GUIDES.tips]) {
      expect(topic).toContain("[mini] parse error");
      expect(topic).toContain("await initHydra({ src: 'https://unpkg.com/hydra-synth@1.4.0' })");
    }
  });

  it("advanced topic points at visuals instead of duplicating it", () => {
    expect(STRUDEL_GUIDES.advanced).toContain('"visuals" topic');
    expect(STRUDEL_GUIDES.advanced).not.toContain("### pianoroll options");
  });
});
