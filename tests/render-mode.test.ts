import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

type ContentBlock = {
  type: string;
  resource?: { uri: string; mimeType: string; text: string };
};

describe("render modes", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  async function connect(mode: "auto" | "html") {
    const server = createServer({ defaultRenderMode: mode });
    const [c, s] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([client.connect(c), server.server.connect(s)]);
    cleanup = async () => {
      await client.close();
      await server.close();
    };
  }

  afterEach(async () => {
    await cleanup();
  });

  it("html mode embeds an HTML resource block with the player", async () => {
    await connect("html");
    const res = await client.callTool({
      name: "play-sheet-music",
      arguments: { abcNotation: "X:1\nK:C\nCDEF|" },
    });
    const content = res.content as ContentBlock[];
    const resourceBlock = content.find((c) => c.type === "resource");
    expect(resourceBlock).toBeTruthy();
    expect(resourceBlock?.resource?.uri).toContain("music://player/");
    expect(resourceBlock?.resource?.mimeType).toBe("text/html");
    expect(resourceBlock?.resource?.text).toContain("abcjs");
  });

  it("auto mode returns only text (UI rendered via _meta resource, not inline)", async () => {
    await connect("auto");
    const res = await client.callTool({
      name: "play-sheet-music",
      arguments: { abcNotation: "X:1\nK:C\nCDEF|" },
    });
    const content = res.content as ContentBlock[];
    expect(content.every((c) => c.type === "text")).toBe(true);
  });
});
