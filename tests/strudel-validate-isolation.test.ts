import { describe, expect, it } from "vitest";
import { shutdownStrudelValidation, validateStrudelCode } from "../src/shared/strudel-validate";

/**
 * Validation runs code an LLM wrote. Until v0.5 that only ever happened in the
 * widget's CSP-pinned browser iframe; v0.5 moved it into the MCP server, and an
 * adversarial review found two P1s in the first cut:
 *
 *   F1  `Function(modelCode)()` in the real global scope — the pattern below
 *       ("SERVER-PROCESS-VISIBLE") threw from inside the server process, and
 *       `await import("node:fs")` resolved.
 *   F2  `while(true){}` is a SYNCHRONOUS busy loop, so `Promise.race` never got
 *       a turn: validateStrudelCode never resolved and a stdio server was dead
 *       until restarted.
 *
 * Both are answered by running the evaluation somewhere else — a forked child
 * with `env: {}`, a 512 MB heap cap and no stdout, evaluating inside a node:vm
 * context, which the host SIGKILLs and respawns. This file is the proof, and it
 * is written to fail loudly if any layer is quietly removed.
 *
 * Each probe pattern reports through its OWN thrown message rather than through
 * an assertion on the outside: if `process` were visible again, the pattern
 * would throw "SERVER-PROCESS-VISIBLE" and the test would say so by name.
 */

/** Comfortable for a warm child (measured ~2-5 ms); generous for cold CI. */
const LATENCY_BUDGET_MS = 3000;

describe("F1: the pattern cannot see the server process", () => {
  it("has no process, require, fetch, or globalThis.process", async () => {
    const v = await validateStrudelCode(
      `if (typeof process !== 'undefined' && process.env && typeof fetch === 'function') { throw new Error('SERVER-PROCESS-VISIBLE') }
       if (typeof process !== 'undefined') { throw new Error('PROCESS-VISIBLE') }
       if (typeof require !== 'undefined') { throw new Error('REQUIRE-VISIBLE') }
       if (typeof fetch !== 'undefined') { throw new Error('FETCH-VISIBLE') }
       if (typeof globalThis !== 'undefined' && typeof globalThis.process !== 'undefined') { throw new Error('GLOBALTHIS-PROCESS-VISIBLE') }
       note('c4')`,
    );
    // A leak shows up as the pattern's own name for it.
    expect(v.error?.message).toBeUndefined();
    expect(v.ok).toBe(true);
  });

  it("cannot dynamically import a node builtin", async () => {
    const v = await validateStrudelCode(
      `const fs = await import('node:fs'); if (typeof fs.readFileSync === 'function') { throw new Error('FS-IMPORT-WORKS') }; note('c4')`,
    );
    expect(v.ok).toBe(false);
    expect(v.error?.message).not.toMatch(/FS-IMPORT-WORKS/);
    // Node and Bun both refuse an import() with no importModuleDynamically.
    expect(v.error?.message).toMatch(/dynamic import callback was not specified/i);
  });

  it("cannot read the parent's environment, because the child has none", async () => {
    // Belt and braces: even if `process` came back, `env: {}` means there is
    // nothing in it. Asserted through the vm's own view.
    const v = await validateStrudelCode(
      `if (typeof process !== 'undefined' && Object.keys(process.env || {}).length > 2) { throw new Error('ENV-INHERITED') }; note('c4')`,
    );
    expect(v.ok).toBe(true);
  });
});

describe("F2: a synchronous busy loop cannot wedge the server", () => {
  it("times out, keeps the event loop running, and the next pattern still works", async () => {
    // The event-loop probe: a timer scheduled before the call must fire on
    // time. If validation ran in this process, `while(true){}` would starve it
    // and the drift would be the length of the whole call.
    let firedAt = 0;
    const scheduledAt = Date.now();
    const timer = setTimeout(() => {
      firedAt = Date.now();
    }, 300);

    const started = Date.now();
    const v = await validateStrudelCode("while(true){}; note('c4')", { timeoutMs: 1000 });
    const elapsed = Date.now() - started;
    clearTimeout(timer);

    expect(v.ok).toBe(false);
    expect(v.error?.message).toMatch(/timed out/);
    expect(elapsed).toBeLessThan(1000 + 1000);
    // Fired at all, and roughly on time — 300 ms nominal, 250 ms of slack.
    expect(firedAt).toBeGreaterThan(0);
    expect(firedAt - scheduledAt).toBeLessThan(300 + 250);

    // The child was SIGKILLed; the next request must fork a fresh one.
    const after = await validateStrudelCode('s("bd sd")');
    expect(after.ok).toBe(true);
    expect(after.sounds).toEqual(["bd", "sd"]);
  }, 30_000);

  it("survives a loop hidden behind an await, which the vm timeout cannot catch", async () => {
    // The vm's `timeout` only interrupts synchronous execution, so this one is
    // stopped by the host's SIGKILL alone. Named because it is exactly the case
    // a vm-only fix would miss.
    const v = await validateStrudelCode("await Promise.resolve(); while(true){}; note('c4')", {
      timeoutMs: 1000,
    });
    expect(v.ok).toBe(false);
    expect(v.error?.message).toMatch(/timed out/);

    const after = await validateStrudelCode('note("c e g")');
    expect(after.ok).toBe(true);
  }, 30_000);
});

describe("an out-of-memory pattern kills the child, not the server", () => {
  it("reports a crash and recovers", async () => {
    const v = await validateStrudelCode("Array(1e9).fill(0); note('c4')", { timeoutMs: 8000 });
    expect(v.ok).toBe(false);
    // Either the allocation aborts the child (crash) or it is still going when
    // the deadline lands (timeout). Both are contained; neither is `ok`.
    expect(v.error?.message).toMatch(/validation (crashed|timed out)/);

    const after = await validateStrudelCode('s("hh*4")');
    expect(after.ok).toBe(true);
  }, 40_000);
});

describe("validation stays fast once the child is warm", () => {
  it("answers a typical pattern well inside the budget", async () => {
    // Warm the child so this measures a round trip, not a fork.
    await validateStrudelCode('s("bd")');

    const code = `setcps(0.5)
stack(
  s("bd*4").gain(0.9),
  s("~ cp ~ cp").bank("RolandTR909").gain(0.7),
  note("c2 ~ [c2 c2] ~").s("gm_electric_bass_finger"),
).room(0.2)`;
    const started = Date.now();
    const v = await validateStrudelCode(code);
    const elapsed = Date.now() - started;
    // eslint-disable-next-line no-console
    console.error(`warm validation round trip: ${elapsed} ms`);

    expect(v.ok).toBe(true);
    expect(elapsed).toBeLessThan(LATENCY_BUDGET_MS);
  }, 30_000);

  it("shuts the child down on request", async () => {
    await validateStrudelCode('s("bd")');
    await shutdownStrudelValidation();
    // A killed child is not an error; the next call forks a new one.
    const v = await validateStrudelCode('s("bd")');
    expect(v.ok).toBe(true);
  }, 30_000);
});
