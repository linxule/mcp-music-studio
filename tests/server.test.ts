import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, handlePlaySheetMusic } from "../server";
import type { ParseOnlyFn } from "../src/server-logic";
import { SERVER_INSTRUCTIONS } from "../src/shared/tool-defs";

/** Every tool the server must advertise, on both transports. */
const EXPECTED_TOOLS = [
  "analyze-harmony",
  "convert-abc-to-strudel",
  "get-music-guide",
  "get-strudel-guide",
  "play-live-pattern",
  "play-sheet-music",
  "search-music-docs",
];

describe("tool registration", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
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

  it("lists all seven tools", async () => {
    const res = await client.listTools();
    expect(res.tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
  });

  it("keeps every tool description under the 2KB client truncation cap", async () => {
    const res = await client.listTools();
    for (const tool of res.tools) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.description!.length, tool.name).toBeLessThan(2048);
    }
  });

  it("marks the two analysis tools read-only and idempotent", async () => {
    const res = await client.listTools();
    for (const name of ["analyze-harmony", "convert-abc-to-strudel"]) {
      const tool = res.tools.find((t) => t.name === name)!;
      expect(tool.annotations?.readOnlyHint, name).toBe(true);
      expect(tool.annotations?.idempotentHint, name).toBe(true);
      // no widget — these are pure text tools
      expect(tool._meta?.ui, name).toBeUndefined();
    }
  });

  it("points the model at the two new tools in the server instructions", () => {
    expect(SERVER_INSTRUCTIONS).toContain("analyze-harmony");
    expect(SERVER_INSTRUCTIONS).toContain("convert-abc-to-strudel");
    // instructions are re-sent every turn and truncated at 2KB by Claude Code
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(2048);
  });
});

describe("play-sheet-music handler", () => {
  it("keeps warnings non-fatal", async () => {
    const parseOnly: ParseOnlyFn = () => [
      { warnings: ["<span>Measure overflow warning</span>"] },
    ];

    const result = await handlePlaySheetMusic(
      { abcNotation: "X:1\nK:C\nC |" },
      parseOnly,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain(
      "Parsed with warnings (will still play):",
    );
    expect(result.content[0]?.text).toContain("Measure overflow warning");
  });

  it("treats fatal parse errors as errors", async () => {
    const parseOnly: ParseOnlyFn = () => [
      { warnings: ["Error: Expected note after bar line"] },
    ];

    const result = await handlePlaySheetMusic(
      { abcNotation: "X:1\nK:C\n|" },
      parseOnly,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("ABC notation has errors:");
    expect(result.content[0]?.text).toContain(
      "Expected note after bar line",
    );
  });

  it("clean parse returns honest text and does not claim playback", async () => {
    const parseOnly: ParseOnlyFn = () => [{}];

    const result = await handlePlaySheetMusic(
      { abcNotation: "X:1\nK:C\nCDEF|" },
      parseOnly,
    );

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    // Honest: tells the agent nothing played if there's no widget...
    expect(text).toContain("nothing has played yet");
    // ...and never asserts it played.
    expect(text).not.toMatch(/playing!|successfully played|now playing/i);
  });
});
