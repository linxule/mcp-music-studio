import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

describe("music prompts", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const server = createServer();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([
      client.connect(clientTransport),
      server.server.connect(serverTransport),
    ]);
    cleanup = async () => {
      await client.close();
      await server.close();
    };
  });

  afterEach(async () => {
    await cleanup();
  });

  it("lists the three music prompts", async () => {
    const res = await client.listPrompts();
    const names = res.prompts.map((p) => p.name).sort();
    expect(names).toEqual(["arrange-tune", "compose-beat", "harmonize-melody"]);
  });

  it("compose-beat scaffolds a play-live-pattern flow", async () => {
    const res = await client.getPrompt({
      name: "compose-beat",
      arguments: { genre: "techno", mood: "dark" },
    });
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0]?.role).toBe("user");
    const text = (res.messages[0]?.content as { type: string; text: string })
      .text;
    expect(text).toContain("techno");
    expect(text).toContain("dark");
    expect(text).toContain("play-live-pattern");
    expect(text).toContain("get-strudel-guide");
  });

  it("harmonize-melody embeds the melody and targets play-sheet-music", async () => {
    const res = await client.getPrompt({
      name: "harmonize-melody",
      arguments: { melody: "X:1\nK:C\nCDEF|", style: "jazz" },
    });
    const text = (res.messages[0]?.content as { type: string; text: string })
      .text;
    expect(text).toContain("play-sheet-music");
    expect(text).toContain("jazz");
    expect(text).toContain("CDEF");
  });
});
