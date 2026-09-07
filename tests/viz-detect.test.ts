import { describe, expect, it } from "vitest";
import { detectViz, stripLineComments, VIZ_METHOD_RE, HYDRA_INIT_RE } from "../src/shared/viz-detect";

describe("viz-detect", () => {
  it("detects Strudel draw methods", () => {
    for (const m of ["pianoroll", "punchcard", "scope", "spectrum", "spiral", "pitchwheel"]) {
      expect(detectViz(`s("bd sd").${m}()`)).toEqual({ strudelViz: true, hydra: false, any: true });
    }
    expect(VIZ_METHOD_RE.test('note("c3").pianoroll({ cycles: 2 })')).toBe(true);
  });

  it("detects initHydra() as a visual", () => {
    const code = 'await initHydra()\nosc(8).out(o0)\ns("bd sd")';
    expect(detectViz(code)).toEqual({ strudelViz: false, hydra: true, any: true });
    expect(HYDRA_INIT_RE.test("await initHydra({ feedStrudel: true })")).toBe(true);
  });

  it("reports both layers when Hydra and a draw method are combined", () => {
    const code = 'await initHydra({feedStrudel:true})\nsrc(s0).kaleid(4).out(o0)\nnote("c3 e3").pianoroll()';
    expect(detectViz(code)).toEqual({ strudelViz: true, hydra: true, any: true });
  });

  it("ignores commented-out visuals but keeps protocol URLs intact", () => {
    expect(detectViz('s("bd") // .pianoroll()').any).toBe(false);
    expect(detectViz("// await initHydra()\ns(\"bd\")").hydra).toBe(false);
    const withUrl = "samples('https://example.com/strudel.json')\ns(\"bd\").scope()";
    expect(stripLineComments(withUrl)).toContain("https://example.com");
    expect(detectViz(withUrl).strudelViz).toBe(true);
  });

  it("does not false-positive on plain patterns", () => {
    expect(detectViz('stack(s("bd*2"), note("c3 e3").s("piano"))')).toEqual({
      strudelViz: false,
      hydra: false,
      any: false,
    });
    // a variable merely NAMED hydra shouldn't count
    expect(detectViz("const hydra = 1; s(\"bd\")").hydra).toBe(false);
  });
});
