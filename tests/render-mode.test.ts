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

  async function connect(mode: "auto" | "html" | "browser") {
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

  // The share link folds `visuals` into the code (toPlayShareArgs), but the
  // standalone page built by --render-mode html/browser used to be handed the
  // RAW args, so a call with visuals: "hydra-kaleid" produced a page with no
  // shader. All three paths now run the same reduction.
  it("html mode bakes the visuals preset into the standalone page", async () => {
    await connect("html");
    const withViz = await client.callTool({
      name: "play-live-pattern",
      arguments: { code: 's("bd sd")', visuals: "hydra-kaleid" },
    });
    const without = await client.callTool({
      name: "play-live-pattern",
      arguments: { code: 's("bd sd")' },
    });

    const html = (c: unknown) =>
      ((c as ContentBlock[]).find((b) => b.type === "resource")?.resource
        ?.text ?? "");
    const vizHtml = html(withViz.content);
    const plainHtml = html(without.content);

    expect(vizHtml).not.toBe("");
    expect(vizHtml).not.toBe(plainHtml);
    // The recipe body, not just the initHydra shim the page always ships.
    expect(vizHtml).toContain("kaleid(5)");
    expect(plainHtml).not.toContain("kaleid(5)");
  });

  it("html mode drops `theme` — the standalone page has no theme switch", async () => {
    await connect("html");
    const themed = await client.callTool({
      name: "play-live-pattern",
      arguments: { code: 's("bd sd")', theme: "nord" },
    });
    const plain = await client.callTool({
      name: "play-live-pattern",
      arguments: { code: 's("bd sd")' },
    });
    const html = (c: unknown) =>
      ((c as ContentBlock[]).find((b) => b.type === "resource")?.resource
        ?.text ?? "");
    expect(html(themed.content)).toBe(html(plain.content));
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

// =============================================================================
// What tools/list says about each mode
// =============================================================================
//
// Two things used to be constant across modes and shouldn't be:
//
// T4 — the widget `_meta`. `--render-mode html|browser` is set precisely because
//      the client can't render an inline widget, yet the play tools still
//      advertised `ui.resourceUri`. A host that CAN render one would then show
//      the widget *and* deliver the HTML blob / open a browser window.
// T3 — `readOnlyHint`. Browser mode writes a file under --output-dir and shells
//      out to open it, which is neither read-only nor closed-world.
describe("tools/list per render mode", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  async function toolsFor(mode: "auto" | "html" | "browser") {
    const server = createServer({ defaultRenderMode: mode });
    const [c, s] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([client.connect(c), server.server.connect(s)]);
    cleanup = async () => {
      await client.close();
      await server.close();
    };
    const { tools } = await client.listTools();
    return tools;
  }

  afterEach(async () => {
    await cleanup();
  });

  const PLAY_TOOLS = ["play-sheet-music", "play-live-pattern"];

  it("auto mode advertises the widget in both _meta spellings", async () => {
    const tools = await toolsFor("auto");
    for (const name of PLAY_TOOLS) {
      const meta = tools.find((t) => t.name === name)?._meta as
        | { ui?: { resourceUri?: string }; "ui/resourceUri"?: string }
        | undefined;
      expect(meta?.ui?.resourceUri, name).toBeTruthy();
      expect(meta?.["ui/resourceUri"], name).toBe(meta?.ui?.resourceUri);
    }
  });

  it.each(["html", "browser"] as const)(
    "%s mode registers the play tools with NO ui metadata",
    async (mode) => {
      const tools = await toolsFor(mode);
      for (const name of PLAY_TOOLS) {
        const meta = tools.find((t) => t.name === name)?._meta as
          | Record<string, unknown>
          | undefined;
        expect(meta?.ui, name).toBeUndefined();
        expect(meta?.["ui/resourceUri"], name).toBeUndefined();
      }
    },
  );

  it.each(["auto", "html"] as const)(
    "%s mode keeps the play tools read-only (nothing is written)",
    async (mode) => {
      const tools = await toolsFor(mode);
      for (const name of PLAY_TOOLS) {
        expect(
          tools.find((t) => t.name === name)?.annotations,
          name,
        ).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      }
    },
  );

  it("browser mode admits it writes a file and launches an app", async () => {
    const tools = await toolsFor("browser");
    for (const name of PLAY_TOOLS) {
      expect(
        tools.find((t) => t.name === name)?.annotations,
        name,
      ).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      });
    }
  });

  it("still registers the widget RESOURCES in every mode", async () => {
    // Harmless: without the tool _meta nothing points a host at them, and
    // keeping them keeps resources/list identical across transports.
    for (const mode of ["auto", "html", "browser"] as const) {
      const server = createServer({ defaultRenderMode: mode });
      const [c, s] = InMemoryTransport.createLinkedPair();
      const probe = new Client({ name: "probe", version: "1.0.0" });
      await Promise.all([probe.connect(c), server.server.connect(s)]);
      const uris = (await probe.listResources()).resources.map((r) => r.uri);
      expect(uris, mode).toContain("ui://sheet-music/mcp-app.html");
      expect(uris, mode).toContain("ui://strudel/strudel-app.html");
      await probe.close();
      await server.close();
    }
    cleanup = async () => {};
  });
});
