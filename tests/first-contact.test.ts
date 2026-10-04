import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMusicServer } from "../worker/src/index";

// =============================================================================
// What a model reads before it plays a note
// =============================================================================
//
// Every chat that connects pays for the server instructions, every tool
// description and every input schema — whether or not it ever opens a session,
// draws a control or shares a link. 0.5.0 cost 12.6k characters; by 0.11.0 the
// optional modules had pushed it to 25.1k. 0.11.1 put the core first and gave
// each module one line plus the guide topic that teaches it (17.9k). An
// agent-ergonomics review (Fable) then bought back some discoverability on
// purpose — the gallery's faces, taps, where tilt/mic work, that a play result
// already carries a link — for 18.6k, still 26% under 0.11.0.
//
// The budget is a ceiling, not a target. Raising it is allowed; doing it
// without noticing is what this test prevents. If a new feature needs words
// here, consider whether one clause + a guide topic would do.
const BUDGET = {
  instructions: 1400,
  descriptions: 6400,
  schemas: 11200,
};

const client = new Client({ name: "first-contact", version: "0.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([
  client.connect(clientTransport),
  createMusicServer({} as never).connect(serverTransport),
]);
const instructions = client.getInstructions() ?? "";
const { tools } = await client.listTools();
const descriptions = tools.reduce((n, t) => n + (t.description ?? "").length, 0);
const schemas = tools.reduce((n, t) => n + JSON.stringify(t.inputSchema ?? {}).length, 0);

describe("first contact stays small", () => {
  it("fits the budget", () => {
    expect({ instructions: instructions.length, descriptions, schemas }).toSatisfy(
      (m: typeof BUDGET) =>
        m.instructions <= BUDGET.instructions && m.descriptions <= BUDGET.descriptions && m.schemas <= BUDGET.schemas,
    );
  });

  it("keeps the instructions under Claude Code's 2 KB cut with room to spare", () => {
    expect(instructions.length).toBeLessThan(1500);
  });
});

describe("…and still names every optional module", () => {
  // Small must not mean hidden: an agent should be able to find each module
  // from the instructions alone, and know which guide topic teaches it.
  // Each module: what it is, and where to read about it, in the same clause
  // (up to the next semicolon), so a module can't lose its words and keep
  // only a topic name.
  const clauses = instructions.split(/[;.] /);
  it.each([
    ["visuals", /pianoroll/, "'visuals'"],
    ["shaders", /Hydra/, "'hydra'"],
    ["music videos and films", /music videos/, "'stage'"],
    ["films", /films/, "'film'"],
    ["controls the user plays", /faders/, "'interactive'"],
    ["sensors", /tilt and mic/, "'interactive'"],
    ["controls the AI draws", /grids you draw/, "'interactive'"],
    ["complete pieces", /complete pieces/, "'gallery'"],
    ["live sessions", /live sessions/, "session: true"],
    ["sharing", /share/, "create-share-link"],
  ])("%s", (_name, what, where) => {
    expect(clauses.some((c) => what.test(c) && c.includes(where))).toBe(true);
  });

  it("says the core comes first and the rest is optional", () => {
    expect(instructions).toMatch(/whole core/);
    expect(instructions).toMatch(/optional/);
  });

  it("names the core tools", () => {
    for (const tool of ["play-sheet-music", "play-live-pattern", "get-music-guide", "get-strudel-guide", "analyze-harmony", "convert-abc-to-strudel", "search-music-docs"]) {
      expect(instructions).toContain(tool);
    }
  });
});
