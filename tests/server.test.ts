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
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(2000);
  });

  it("offers analyze-harmony rather than ordering a detour through it", () => {
    // Instructions ride on every turn; a standing "call X before Y" costs a
    // round trip on every chord symbol the model writes.
    expect(SERVER_INSTRUCTIONS).toContain("If unsure about chord spelling");
    expect(SERVER_INSTRUCTIONS).not.toMatch(/call analyze-harmony before/i);
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
    // Wording is conditional on purpose: on a terminal client nothing plays,
    // so "will still play" was a claim the server can't make.
    expect(result.content[0]?.text).toContain(
      "Parsed with warnings (the score still renders in MCP-app hosts):",
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

  // An unmatched instrument name used to fall back to a grand piano in silence:
  // the agent asked for a banjo, got a piano, and was told the piece played.
  describe("instrument resolution is spoken out loud", () => {
    const parseOnly: ParseOnlyFn = () => [{}];
    const play = (instrument?: string) =>
      handlePlaySheetMusic({ abcNotation: "X:1\nK:C\nCDEF|", instrument }, parseOnly);

    it("stays quiet when the instrument matched exactly", async () => {
      const text = (await play("Banjo")).content[0]?.text ?? "";
      expect(text).not.toContain("Instrument:");
    });

    it("stays quiet when no instrument was asked for", async () => {
      const text = (await play()).content[0]?.text ?? "";
      expect(text).not.toContain("Instrument:");
    });

    it("names the fallback when the instrument is unknown", async () => {
      const text = (await play("kazoo")).content[0]?.text ?? "";
      expect(text).toContain('Instrument: Acoustic Grand Piano (requested "kazoo")');
      expect(text).toContain("Unknown instrument");
    });

    it("names the resolved instrument when the match was fuzzy", async () => {
      const text = (await play("sax")).content[0]?.text ?? "";
      expect(text).toContain('Instrument: Soprano Sax (requested "sax")');
      expect(text).toContain("GM program 64");
    });

    it("reports the instrument alongside non-fatal parse warnings too", async () => {
      const warn: ParseOnlyFn = () => [{ warnings: ["Measure overflow warning"] }];
      const result = await handlePlaySheetMusic(
        { abcNotation: "X:1\nK:C\nC |", instrument: "kazoo" },
        warn,
      );
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("Parsed with warnings");
      expect(text).toContain('Instrument: Acoustic Grand Piano (requested "kazoo")');
    });
  });
});
