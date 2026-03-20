import { describe, expect, it } from "vitest";
import { handlePlayLivePattern, handleGetStrudelGuide } from "../server";
import {
  STRUDEL_GUIDE_TOPICS,
  STRUDEL_GUIDES,
} from "../src/strudel-guide";

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
    expect(result.content[0]?.text).toContain("Strudel pattern playing");
  });

  it("returns text result without title", async () => {
    const result = await handlePlayLivePattern({
      code: 's("bd sd")',
    });

    expect(result.content[0]?.text).toBe("Strudel pattern playing.");
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

  it("covers all 7 topics", () => {
    expect(STRUDEL_GUIDE_TOPICS).toHaveLength(7);
  });
});
