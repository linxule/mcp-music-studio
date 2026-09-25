/**
 * @file `$:` blocks — Strudel's everyday way to write several patterns.
 *
 * `$: pattern` transpiles to `pattern.p('$')`, a method repl() injects. The
 * headless validator never had it, so the local server reported EVERY `$:`
 * pattern as "failed to evaluate: ….p is not a function" (isError) while the
 * widget played it fine. These hold the validator to repl()'s semantics:
 * registered patterns play stacked whatever the last expression is; an id with
 * a leading or trailing `_` mutes; `S$:` solos.
 */
import { afterAll, describe, expect, it } from "vitest";
import { evalStrudelSandboxed, queryHaps } from "../src/shared/strudel-eval";
import { shutdownStrudelValidation, validateStrudelCode } from "../src/shared/strudel-validate";

afterAll(() => shutdownStrudelValidation());

async function sounds(code: string) {
  const { pattern, error } = await evalStrudelSandboxed(code);
  expect(error, String(error)).toBeUndefined();
  const { haps, error: qErr } = queryHaps(pattern, 1);
  expect(qErr).toBeUndefined();
  return [...new Set(haps.map((h: { value: { s?: string } }) => h.value.s))].sort();
}

describe("$: blocks in the headless evaluator", () => {
  it("stacks every block", async () => {
    expect(await sounds(`$: s("bd*4")\n$: s("hh*8")`)).toEqual(["bd", "hh"]);
  });

  it("plays the blocks even when the last expression is not a pattern (a Hydra .out())", async () => {
    expect(await sounds(`$: s("bd*4")\nawait initHydra()\nosc(10).out(o0)`)).toEqual(["bd"]);
  });

  it("does not hang when a Hydra chain is the last expression", async () => {
    // The stub chain answered every property, \`then\` included, so the async
    // wrapper awaited it forever.
    const { error } = await evalStrudelSandboxed(`$: s("bd")\nosc(10).kaleid(4).out(o0)`);
    expect(error).toBeUndefined();
  });

  it("mutes _$: and $_ blocks", async () => {
    expect(await sounds(`$: s("bd*4")\n_$: s("hh*8")\nd1_: s("cp")`)).toEqual(["bd"]);
  });

  it("solos S$: blocks", async () => {
    expect(await sounds(`$: s("bd*4")\nS$: s("hh*8")`)).toEqual(["hh"]);
  });

  it("applies all() to the stack", async () => {
    const { pattern } = await evalStrudelSandboxed(`all(x => x.fast(2))\n$: s("bd")\n$: s("hh")`);
    expect(queryHaps(pattern, 1).haps).toHaveLength(4);
  });

  it("forgets the blocks of the previous evaluation", async () => {
    await sounds(`$: s("cp*2")`);
    expect(await sounds(`$: s("bd")`)).toEqual(["bd"]);
  });

  it("keeps d1…d9 working", async () => {
    expect(await sounds(`s("bd*2").d1\ns("hh*4").d2`)).toEqual(["bd", "hh"]);
  });
});

describe("$: blocks through the out-of-process validator", () => {
  it("validates, counting the blocks as layers", async () => {
    const v = await validateStrudelCode(`$: s("bd*4").bank("RolandTR909")\n$: note("c3 e3").s("piano")`);
    expect(v.ok, JSON.stringify(v.error)).toBe(true);
    expect(v.layers).toBe(2);
    expect(v.sounds).toEqual(expect.arrayContaining(["piano"]));
  });

  it("reports an all-muted pattern as silent, not as a crash", async () => {
    const v = await validateStrudelCode(`_$: s("bd*4")`);
    expect(v.error?.message ?? "").not.toMatch(/is not a function/);
  });
});
