// The pieces made in claude.ai on 2026-10-01 (tests/fixtures/pieces/), exactly
// as they ran in the widget — a canvas fed to Hydra, an ASCII camera, a Game of
// Life composer, a short film, a spoken duet. They are the regression suite for
// "an audiovisual piece is real browser JavaScript": the validator must accept
// every one that played, and still catch the two that never parsed.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateStrudelInProcess } from "../src/shared/strudel-validate-core";

const piece = (name: string) => readFileSync(`tests/fixtures/pieces/${name}.js`, "utf8");

describe("audiovisual pieces through the validator", () => {
  // Before 0.7 the first five failed with "window is not defined" (or, for the
  // terminal, "Cannot convert object to primitive value" from `kick * 30` in
  // the top-level first frame) — on the local server, `isError` for code that plays.
  it.each([
    "first-light-v1",
    "first-light-film",
    "duet",
    "petri-dish",
    "lossy-terminal",
    "lossy-club-damage",
    "signal-corruption",
  ])("%s evaluates and produces events", async (name) => {
    const result = await validateStrudelInProcess(piece(name), { timeoutMs: 8000 });
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.eventsPerCycle).toBeGreaterThan(0);
  });

  // `))` for `)]` closing an arrange() section — both Lossy versions shipped
  // it, and only the user ever saw the error.
  it.each([
    ["lossy-v1-typo", 82, 41],
    ["lossy-club-damage-typo", 88, 61],
  ])("%s is rejected at the typo", async (name, line, column) => {
    const result = await validateStrudelInProcess(piece(name), { timeoutMs: 8000 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ line, column });
  });
});

describe("the stage runtime in the validator", () => {
  const validate = (code: string) => validateStrudelInProcess(code, { timeoutMs: 8000 });

  it("knows cycle/onFrame/onEvent/onTap/say, and say() lines count as registered sounds", async () => {
    const result = await validate(`
      const hello = say('hi. it is me.', { voice: 'orion' })
      onFrame(f => { const c = cycle() })
      onTap(t => t.next(16))
      onEvent(note("c3 e3"), e => e.midi)
      stack(note("c3 e3").s("piano"), hello.mask("<1 0 0 0>"))
    `);
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.unregistered ?? []).toEqual([]);
    expect(result.warnings).toBeUndefined();
  });

  it("runs each frame callback once AFTER the top level — no false TDZ errors", async () => {
    const result = await validate(`
      onFrame(() => { g.fillRect(0, 0, W, 10) })
      const W = 800
      const g = document.createElement('canvas').getContext('2d')
      s("bd*4")
    `);
    expect(result.ok).toBe(true);
    expect(result.warnings).toBeUndefined();
  });

  it("reports a draw loop that throws, without failing the pattern", async () => {
    const result = await validate(`
      onFrame(f => { ctx.fillRect(0, 0, 1, 1) })
      onEvent(s("bd sd"), e => e.value.missing.field)
      s("bd sd")
    `);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      expect.stringMatching(/^onFrame callback threw on a test frame: .*ctx/),
      expect.stringMatching(/^onEvent callback threw on a test frame/),
    ]);
  });

  it("rejects what the stage would refuse, at the call", async () => {
    const result = await validate(`say('x', { voice: 'not-a-voice' }); s("bd")`);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/not one of/);
  });
});
