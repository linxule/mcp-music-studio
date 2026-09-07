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

  it("auto mode inlines no player HTML (the UI comes from the _meta resource)", async () => {
    await connect("auto");
    const res = await client.callTool({
      name: "play-sheet-music",
      arguments: { abcNotation: "X:1\nK:C\nCDEF|" },
    });
    const content = res.content as ContentBlock[];
    // The point of auto mode: the ~600 KB player never travels in the result.
    expect(content.some((c) => c.type === "resource")).toBe(false);
    // Text, plus the click-to-play resource_link for hosts with no widget.
    expect(content.every((c) => c.type === "text" || c.type === "resource_link")).toBe(
      true,
    );
  });

  it("auto mode links a short score to the hosted player", async () => {
    await connect("auto");
    const res = await client.callTool({
      name: "play-sheet-music",
      arguments: { abcNotation: "X:1\nK:C\nCDEF|" },
    });
    const content = res.content as ContentBlock[];
    const link = content.find((c) => c.type === "resource_link") as
      | { uri: string; name: string; mimeType: string }
      | undefined;
    expect(link?.uri).toContain("/score?a=");
    expect(link?.name).toBe("Play in browser");
    expect(link?.mimeType).toBe("text/html");

    const text = (content[0] as { text: string }).text;
    expect(text).toContain("▶ Play in browser: ");
    expect(text).toContain(link!.uri);
    // The dead-end wording is gone precisely because there is now a link.
    expect(text).not.toContain("nothing has played yet");
  });

  it("auto mode omits the link when the score is too long for a URL", async () => {
    await connect("auto");
    const res = await client.callTool({
      name: "play-sheet-music",
      // No KV on the stdio server, so an oversized score gets no link at all.
      arguments: { abcNotation: `X:1\nK:C\n${"CDEF|".repeat(1000)}` },
    });
    const content = res.content as ContentBlock[];
    expect(content.some((c) => c.type === "resource_link")).toBe(false);
    // ...and the honest tail stays, because nothing can play it.
    expect((content[0] as { text: string }).text).toContain(
      "nothing has played yet",
    );
  });
});
