import { describe, expect, it } from "vitest";
import { handleGetMusicGuide } from "../server";
import { ABC_GUIDE_TOPICS, ABC_GUIDES } from "../src/abc-guide";

describe("get-music-guide handler", () => {
  it("returns content for every ABC topic", async () => {
    for (const topic of ABC_GUIDE_TOPICS) {
      const result = await handleGetMusicGuide({ topic });

      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0]?.type).toBe("text");
      expect(result.content[0]?.text).toBe(ABC_GUIDES[topic]);
      expect(result.content[0]?.text.length).toBeGreaterThan(0);
    }
  });

  it("covers all 7 topics", () => {
    expect(ABC_GUIDE_TOPICS).toHaveLength(7);
  });
});
