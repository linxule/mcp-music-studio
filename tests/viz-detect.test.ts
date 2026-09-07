import { describe, expect, it } from "vitest";
import { detectViz, stripNonCode, VIZ_METHOD_RE, HYDRA_INIT_RE } from "../src/shared/viz-detect";

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

  it("ignores commented-out visuals but keeps protocol URLs harmless", () => {
    expect(detectViz('s("bd") // .pianoroll()').any).toBe(false);
    expect(detectViz("// await initHydra()\ns(\"bd\")").hydra).toBe(false);
    // A `//` inside a string is NOT a comment: the draw call after it survives.
    const withUrl = "samples('https://example.com/strudel.json')\ns(\"bd\").scope()";
    expect(detectViz(withUrl).strudelViz).toBe(true);
    const inline = `samples('https://example.com/x.json').scope()`;
    expect(detectViz(inline).strudelViz).toBe(true);
  });

  it("ignores visuals inside block comments", () => {
    const r = detectViz('/* .pianoroll()\n await initHydra() */\ns("bd sd")');
    expect(r.any).toBe(false);
    expect(detectViz('s("bd").pianoroll() /* x */').strudelViz).toBe(true);
  });

  it("detects the all(pianoroll) form the guide documents", () => {
    const code = 'note("c3 e3").s("piano")\ns("bd*4")\nall(pianoroll)';
    expect(detectViz(code)).toEqual({ strudelViz: true, hydra: false, any: true });
    expect(detectViz("all(punchcard)").strudelViz).toBe(true);
    expect(detectViz("all( scope )").strudelViz).toBe(true);
    // a call merely named all() with something else in it is not a visual
    expect(detectViz('all(x => x.fast(2))\ns("bd")').strudelViz).toBe(false);
  });

  it("classifies every Hydra recipe shape from the guide's visuals topic", () => {
    // The widget stages the WebGL layer off `hydra`, and reveals the backdrop
    // off `any`, so these three shapes must not regress.
    const minimal = "await initHydra()\nosc(8, 0.05, 0.9).rotate(0.3).kaleid(5).out(o0)\n\ns(\"bd*2\")";
    expect(detectViz(minimal)).toEqual({ strudelViz: false, hydra: true, any: true });

    const feed =
      'await initHydra({ feedStrudel: true })\nsrc(s0).kaleid(4).out(o0)\n\nnote("c3").pianoroll({ cycles: 2 })';
    expect(detectViz(feed)).toEqual({ strudelViz: true, hydra: true, any: true });

    const pulse = 'await initHydra()\nshape(6, () => 0.15 + 0.35 * H("1 0")(), 0.3).out(o0)\n\ns("bd*2")';
    expect(detectViz(pulse)).toEqual({ strudelViz: false, hydra: true, any: true });
  });

  // ---------------------------------------------------------------------------
  // String literals are not code (S3)
  // ---------------------------------------------------------------------------

  it("ignores visual look-alikes inside string literals", () => {
    expect(detectViz('s("bd").note("call .pianoroll() later")').strudelViz).toBe(false);
    expect(detectViz("s('bd').label('initHydra(')").hydra).toBe(false);
    expect(detectViz("s(`bd ${1} .pianoroll()`)").strudelViz).toBe(false);
    // …but a real call sitting next to such a string still counts.
    expect(detectViz('s("bd .pianoroll()").scope()').strudelViz).toBe(true);
  });

  it("does not treat // inside a string as a comment", () => {
    // The old scanner stripped from `//` to end of line unless preceded by ':',
    // so a draw call after a quoted `//` vanished and the backdrop never showed.
    const code = 's("bd").someOpt("a // b").pianoroll()';
    expect(detectViz(code).strudelViz).toBe(true);
    expect(stripNonCode(code)).toContain(".pianoroll()");
    expect(detectViz('s("//example").scope()').strudelViz).toBe(true);
  });

  it("scans template interpolations as code but not template text", () => {
    expect(detectViz("const x = `label`\ns(`bd`).pianoroll()").strudelViz).toBe(true);
    expect(detectViz("const x = `${ s('bd').scope() }`").strudelViz).toBe(true);
    expect(detectViz("const x = `nested ${ `${1}` } .pianoroll()`").strudelViz).toBe(false);
  });

  it("keeps offsets stable so only non-code is blanked", () => {
    const code = 's("bd") // .pianoroll()\nawait initHydra()';
    const stripped = stripNonCode(code);
    expect(stripped).toHaveLength(code.length);
    expect(stripped.split("\n")).toHaveLength(2);
    expect(stripped).toContain("await initHydra()");
    expect(stripped).not.toContain("pianoroll");
  });

  it("handles unterminated strings and block comments without hanging", () => {
    expect(detectViz('s("bd\n.pianoroll()').strudelViz).toBe(true);
    expect(detectViz("/* never closed .pianoroll()").any).toBe(false);
    expect(detectViz("").any).toBe(false);
  });

  it("finds visuals across multiline / chained formatting", () => {
    const code = [
      "await initHydra({",
      "  feedStrudel: true,",
      "})",
      'note("c3 e3")',
      '  .s("sawtooth")',
      "  .pianoroll({",
      "    cycles: 2,",
      "  })",
    ].join("\n");
    expect(detectViz(code)).toEqual({ strudelViz: true, hydra: true, any: true });
    // Whitespace of any kind between the method name and its parens still
    // reads as a call — which is what JavaScript does too.
    expect(detectViz('s("bd")\n  .scope\n  ()').strudelViz).toBe(true);
    expect(detectViz('s("bd").scope\t()').strudelViz).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Known limits — aliasing is invisible to a lexical scan. Documented, not
  // fixed: the widget's manual "Visuals" toggle is the escape hatch.
  // ---------------------------------------------------------------------------

  it("does not follow aliases (documented limitation)", () => {
    expect(detectViz("const roll = pianoroll\nall(roll)").strudelViz).toBe(false);
    expect(detectViz("const boot = initHydra\nawait boot()").hydra).toBe(false);
    // An aliased RECEIVER is fine — the method name is what we match on.
    expect(detectViz('const p = note("c3")\np.pianoroll()').strudelViz).toBe(true);
    // `all(pianoroll)` behind a rename of `all` is likewise invisible.
    expect(detectViz("const every = all\nevery(pianoroll)").strudelViz).toBe(false);
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
