import { describe, expect, it } from "vitest";
import { handlePlayLivePattern, handleGetStrudelGuide } from "../server";
import {
  STRUDEL_GUIDE_TOPICS,
  STRUDEL_GUIDES,
} from "../src/strudel-guide";
import { PLAY_LIVE_BASE_DESCRIPTION } from "../src/shared/tool-defs";

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

  it("returns text result without title", async () => {
    const result = await handlePlayLivePattern({
      code: 's("bd sd")',
    });

    expect(result.content[0]?.text).toBe(
      "Strudel pattern ready. It plays in an editable REPL widget in MCP-app hosts " +
        "(e.g. Claude Desktop, claude.ai). If you don't see a player here, this client can't play it " +
        "inline, so nothing has played yet.",
    );
    expect(result.content[0]?.text).not.toContain('"');
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
});

describe("visuals guide topic", () => {
  const text = STRUDEL_GUIDES.visuals;

  it("teaches both layers: draw methods and Hydra", () => {
    expect(text).toContain(".pianoroll()");
    expect(text).toContain("await initHydra()");
    expect(text).toContain("feedStrudel");
    expect(text).toContain("H(");
  });

  it("warns that detectAudio uses the microphone", () => {
    expect(text.toLowerCase()).toContain("microphone");
  });

  it("every Hydra recipe starts with initHydra and ends a chain with .out(o0)", () => {
    const recipes = text.split("### Recipe:").slice(1);
    expect(recipes.length).toBeGreaterThanOrEqual(4);
    for (const r of recipes) {
      expect(r).toMatch(/await initHydra\(/);
      expect(r).toContain(".out(o0)");
    }
  });

  it("advanced topic points at visuals instead of duplicating it", () => {
    expect(STRUDEL_GUIDES.advanced).toContain('"visuals" topic');
    expect(STRUDEL_GUIDES.advanced).not.toContain("### pianoroll options");
  });
});
