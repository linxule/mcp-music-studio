import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SERVER_ICONS, WEBSITE_URL, LOGO_URL } from "../src/shared/tool-defs";

// Guards that the server advertises its logo + website in the initialize
// handshake's serverInfo (Implementation.icons / websiteUrl). Spec-current
// clients (e.g. MCP Inspector) render this; older-protocol clients ignore it.
describe("serverInfo icons + websiteUrl", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("advertises the logo icon and website in serverInfo", async () => {
    const server = createServer({ defaultRenderMode: "auto" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([
      client.connect(clientTransport),
      server.server.connect(serverTransport),
    ]);
    cleanup = async () => {
      await client.close();
      await server.close();
    };

    const info = client.getServerVersion() as
      | { icons?: { src: string; mimeType?: string; sizes?: string[] }[]; websiteUrl?: string }
      | undefined;

    expect(info?.websiteUrl).toBe(WEBSITE_URL);
    expect(info?.icons?.length).toBeGreaterThan(0);
    expect(info?.icons?.[0]?.src).toBe(LOGO_URL);
    expect(info?.icons?.[0]?.mimeType).toBe("image/png");
  });

  it("SERVER_ICONS points at the committed 256px variant", () => {
    expect(SERVER_ICONS[0]?.src).toContain("assets/icons/logo-256.png");
    expect(SERVER_ICONS[0]?.sizes).toContain("256x256");
  });
});
