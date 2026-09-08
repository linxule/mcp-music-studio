import { describe, expect, it } from "vitest";
import { STRUDEL_GUIDES } from "../src/strudel-guide";
import { validateStrudelCode } from "../src/shared/strudel-validate";
import { extractBlocks } from "./guide-blocks";

/**
 * The server now runs Strudel code before answering, so a text-only client
 * (Claude Code, a CLI, the worker reached from a terminal) gets a real report
 * instead of "nothing has played yet". These tests pin what that report says.
 *
 * The genre-template pass is the load-bearing one: every template we hand an
 * agent must come back `ok` with every sound registered. If the validator ever
 * gets stricter than the guides it will fail here, not in a user's terminal.
 */

const genreTemplates = extractBlocks("genres", STRUDEL_GUIDES.genres).filter(
  // The multi-section arrange() template declares `drums`/`bass`/... and is
  // extracted as one block; every block in this topic is a complete template.
  (b) => b.code.trim().length > 0,
);

describe("genre templates validate", () => {
  it("finds every template in the genres topic", () => {
    // 8 genres today (techno, house, dnb, ambient, jazz, lofi, synthwave,
    // breakbeat, minimal techno, progressive house). A floor, not a count.
    expect(genreTemplates.length).toBeGreaterThanOrEqual(8);
  });

  it.each(genreTemplates.map((b) => [b.heading, b.code] as const))(
    "%s evaluates with every sound registered",
    async (_heading, code) => {
      const v = await validateStrudelCode(code);
      expect(v.error?.message, `validating:\n${code}`).toBeUndefined();
      expect(v.ok).toBe(true);
      expect(v.unregistered, `validating:\n${code}`).toEqual([]);
      expect(v.eventsPerCycle).toBeGreaterThan(0);
    },
  );
});

describe("what the report says", () => {
  it("reports layers, events, sounds and notes for a stacked pattern", async () => {
    const v = await validateStrudelCode(
      'stack(s("bd*4"), s("~ cp ~ cp"), note("c3 e3 g3").s("gm_piano"))',
    );
    expect(v.ok).toBe(true);
    expect(v.layers).toBe(3);
    expect(v.sounds).toEqual(["bd", "cp", "gm_piano"]);
    expect(v.unregistered).toEqual([]);
    expect(v.usesNotes).toBe(true);
    // 4 kicks + 2 claps + 3 piano notes per cycle.
    expect(v.eventsPerCycle).toBe(9);
  });

  it("omits `layers` when stack() was never called", async () => {
    const v = await validateStrudelCode('s("bd sd")');
    expect(v.ok).toBe(true);
    expect(v.layers).toBeUndefined();
    expect(v.usesNotes).toBe(false);
  });

  it("reads cps out of setcps(120/60/4)", async () => {
    const v = await validateStrudelCode('setcps(120/60/4)\ns("bd*4")');
    expect(v.ok).toBe(true);
    expect(v.cps).toBe(0.5);
  });

  it("reads cps out of setcpm(), which is per minute", async () => {
    const v = await validateStrudelCode('setcpm(30)\ns("bd*4")');
    expect(v.ok).toBe(true);
    expect(v.cps).toBe(0.5);
  });

  it("records draw methods as visuals", async () => {
    const v = await validateStrudelCode('s("bd sd").pianoroll()');
    expect(v.ok).toBe(true);
    expect(v.visuals).toEqual(["pianoroll"]);
  });

  it("records initHydra as a Hydra background", async () => {
    const v = await validateStrudelCode(
      'await initHydra()\nosc(10, 0.1, 1.2).kaleid(5).out()\ns("bd*4, hh*8")',
    );
    expect(v.ok).toBe(true);
    expect(v.usesHydra).toBe(true);
  });

  it("keeps a bank-qualified sound registered when the bank exists", async () => {
    const v = await validateStrudelCode('s("~ cp ~ cp").bank("RolandTR909")');
    expect(v.ok).toBe(true);
    expect(v.unregistered).toEqual([]);
  });

  it("flags a bank that no drum machine matches", async () => {
    const v = await validateStrudelCode('s("bd sd").bank("NotARealMachine")');
    expect(v.ok).toBe(true);
    expect(v.unregistered).toEqual(["NotARealMachine:bd", "NotARealMachine:sd"]);
  });
});

describe("things that are wrong", () => {
  it("reports a syntax error with a line and column", async () => {
    const v = await validateStrudelCode('stack(\n  s("bd*4"),\n  s("hh*8"]\n)');
    expect(v.ok).toBe(false);
    expect(v.error?.message).toMatch(/./);
    expect(v.error?.line).toBe(3);
    expect(typeof v.error?.column).toBe("number");
  });

  it("names a sound prebake() does not register", async () => {
    const v = await validateStrudelCode('s("bd totallyNotASound")');
    expect(v.ok).toBe(true);
    expect(v.unregistered).toEqual(["totallyNotASound"]);
    // ...and does not confuse it with the ones that ARE registered.
    expect(v.sounds).toEqual(["bd", "totallyNotASound"]);
  });

  it("withholds `unregistered` once samples() has loaded custom names", async () => {
    // Single quotes: the transpiler turns DOUBLE-quoted strings into
    // mini-notation, which is why the guide insists on '...' for sample URLs.
    const v = await validateStrudelCode(
      "await samples('https://example.com/kit.json')\ns(\"mySample*2\")",
    );
    expect(v.ok).toBe(true);
    expect(v.unregistered).toBeUndefined();
    expect(v.sampleUrls).toEqual(["https://example.com/kit.json"]);
    expect(v.sounds).toEqual(["mySample"]);
  });

  it("catches the double-quoted samples() URL the guide warns about", async () => {
    // `samples("https://...")` mini-parses the URL and dies on the slashes —
    // the exact mistake get-strudel-guide topic 'tips' calls out as WRONG.
    const v = await validateStrudelCode(
      'samples("https://example.com/kit.json")\ns("mySample*2")',
    );
    expect(v.ok).toBe(false);
    expect(v.error?.message).toContain("parse error");
  });

  it("catches a query-time failure Strudel only logs", async () => {
    // A Pattern where a function is required: this parses, resolves every
    // name, and then throws inside queryArc — which Strudel catches and logs
    // rather than rethrowing, so it used to look like a working pattern.
    const v = await validateStrudelCode('s("~ [~ cp]").sometimes(gain(0.7))');
    expect(v.ok).toBe(false);
    expect(v.error?.message).toBeTruthy();
  });

  it("reports an undefined name", async () => {
    const v = await validateStrudelCode('sound("bd").notAMethod()');
    expect(v.ok).toBe(false);
    expect(v.error?.message).toMatch(/notAMethod/);
  });
});

describe("a runaway pattern cannot take the server with it", () => {
  // `s("bd").fast(1e9)` asks for four billion one-cycle spans and kills the
  // process with an out-of-memory abort — measured before the guard existed.
  // Promise.race cannot help (queryArc is synchronous); the span guard in
  // strudel-eval.ts is what actually stops it.
  it.each([
    ['s("bd").fast(1e9)', "fast"],
    ['s("bd*100000")', "replication"],
  ])("survives %s and reports it", async (code) => {
    const started = Date.now();
    const v = await validateStrudelCode(code, { timeoutMs: 3000 });
    const elapsed = Date.now() - started;
    expect(v.ok).toBe(false);
    expect(v.error?.message).toMatch(/cycles in one query/);
    expect(elapsed).toBeLessThan(3500);
  }, 20000);

  it("returns within the timeout for a pattern that is merely slow", async () => {
    const started = Date.now();
    const v = await validateStrudelCode('s("bd").fast(19000)', {
      timeoutMs: 500,
    });
    expect(Date.now() - started).toBeLessThan(1000);
    // Either it finished under the ceiling or the deadline caught it; both are
    // acceptable, hanging is not.
    expect(typeof v.ok).toBe("boolean");
  }, 20000);
});

describe("stdout stays clean", () => {
  // main.ts: "a stdio transport's stdout stays pure JSON-RPC". @strudel/core
  // console.log()s on import and on every query-time error, so validation has
  // to capture console.log — otherwise the first play-live-pattern call on a
  // stdio server corrupts the protocol stream.
  it("captures the console.log Strudel writes on a failed query", async () => {
    const written: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => {
      written.push(String(args[0]));
    };
    try {
      await validateStrudelCode('s("~ [~ cp]").sometimes(gain(0.7))');
    } finally {
      console.log = log;
    }
    expect(written).toEqual([]);
  });

  it("restores console.log afterwards", async () => {
    const before = console.log;
    await validateStrudelCode('s("bd sd")');
    expect(console.log).toBe(before);
  });
});
