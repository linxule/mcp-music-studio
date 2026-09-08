import { describe, expect, it } from "vitest";
import { validateStrudelCode } from "../src/shared/strudel-validate";

/**
 * Its own file on purpose: vitest isolates each test file's module graph, so
 * this is the only place the FIRST import of @strudel/core can be observed.
 *
 * `@strudel/core` prints "🌀 @strudel/core loaded 🌀" through console.log the
 * moment it is imported. main.ts's standing invariant is that "a stdio
 * transport's stdout stays pure JSON-RPC" — and that banner landed in front of
 * the first tool response until strudel-validate stopped importing the
 * evaluator statically. A static `import` anywhere in the chain brings it back,
 * silently, and only on a real stdio client.
 */
describe("the @strudel import banner never reaches stdout", () => {
  it("writes nothing to console.log on the first validation", async () => {
    const written: unknown[][] = [];
    const log = console.log;
    const info = console.info;
    console.log = (...args: unknown[]) => void written.push(args);
    console.info = console.log;
    try {
      const v = await validateStrudelCode('s("bd sd")');
      expect(v.ok).toBe(true);
    } finally {
      console.log = log;
      console.info = info;
    }
    expect(written).toEqual([]);
  });
});
