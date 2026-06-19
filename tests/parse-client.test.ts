import { describe, expect, it } from "vitest";
import { parseClient } from "../src/shared/parse-client";

describe("parseClient", () => {
  it("classifies known clients", () => {
    expect(parseClient("claude-user")).toBe("claude-ai");
    expect(parseClient("Claude-AI/1.0")).toBe("claude-ai");
    expect(parseClient("something claude.ai something")).toBe("claude-ai");
    expect(parseClient("claude-code/1.2")).toBe("claude-code");
    expect(parseClient("Cursor/0.4")).toBe("cursor");
    expect(parseClient("node gemini-cli")).toBe("gemini");
    expect(parseClient("Windsurf")).toBe("windsurf");
    expect(parseClient("cline-bot")).toBe("cline");
    expect(parseClient("smithery-runner")).toBe("smithery");
    expect(parseClient("mcp-remote/0.1")).toBe("mcp-remote");
  });

  it("returns unknown for unrecognized or empty UA", () => {
    expect(parseClient("")).toBe("unknown");
    expect(parseClient("RandomBot/9")).toBe("unknown");
  });

  it("is case-insensitive", () => {
    expect(parseClient("CURSOR")).toBe("cursor");
    expect(parseClient("WINDSURF/2")).toBe("windsurf");
  });
});
