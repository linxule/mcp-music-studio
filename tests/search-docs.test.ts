import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

describe("search-music-docs tool", () => {
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
    vi.restoreAllMocks();
    await cleanup();
  });

  it("returns search results on successful fetch", async () => {
    const mockResponse = "# Strudel Docs\n\nHow to use `note()` function...";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(mockResponse, { status: 200 }),
    );

    const result = await client.callTool({
      name: "search-music-docs",
      arguments: { query: "how to use note function", library: "strudel" },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    const text = (result.content as Array<{ type: string; text: string }>)[0];
    expect(text?.text).toContain("note()");
  });

  it("returns friendly message when no results found", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("", { status: 200 }),
    );

    const result = await client.callTool({
      name: "search-music-docs",
      arguments: { query: "xyznonexistent", library: "strudel" },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0];
    expect(text?.text).toContain("No results");
    expect(text?.text).toContain("xyznonexistent");
  });

  it("returns error on API failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 }),
    );

    const result = await client.callTool({
      name: "search-music-docs",
      arguments: { query: "test query", library: "abcjs" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0];
    expect(text?.text).toContain("failed");
    expect(text?.text).toContain("500");
  });

  it("returns error on network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new Error("Network timeout"),
    );

    const result = await client.callTool({
      name: "search-music-docs",
      arguments: { query: "test query", library: "strudel" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0];
    expect(text?.text).toContain("Network timeout");
  });

  it("defaults library to strudel", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("docs content", { status: 200 }));

    await client.callTool({
      name: "search-music-docs",
      arguments: { query: "mini notation" },
    });

    const calledUrl = fetchSpy.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("strudel_cc");
  });

  it("uses abcjs library ID when specified", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("abc docs", { status: 200 }));

    await client.callTool({
      name: "search-music-docs",
      arguments: { query: "render notation", library: "abcjs" },
    });

    const calledUrl = fetchSpy.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("paulrosen%2Fabcjs");
  });
});
