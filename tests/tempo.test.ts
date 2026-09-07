import { describe, expect, it } from "vitest";
import { bpmToCps, injectTempo } from "../src/shared/tempo";

import CASES from "./fixtures/tempo-cases.json";

interface Case {
  id: string;
  code: string;
  bpm: number;
  result: "transform" | "insert" | "reject";
}

/** The reference transform's outcomes mapped onto our policy names. */
const POLICY_FOR: Record<Case["result"], string> = {
  transform: "replaced",
  insert: "inserted",
  reject: "inserted-ambiguous",
};

function parensBalanced(code: string): boolean {
  let depth = 0;
  for (const c of code) {
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

describe("bpmToCps", () => {
  it("converts bpm to cycles per second at 4 quarter notes per cycle", () => {
    expect(bpmToCps(120)).toBe(0.5);
    expect(bpmToCps(90)).toBe(0.375);
  });

  it("honours a custom quarterNotesPerCycle", () => {
    expect(bpmToCps(120, 2)).toBe(1);
    expect(bpmToCps(120, 8)).toBe(0.25);
  });

  it("rounds to 4 decimal places", () => {
    // 100/60/4 = 0.41666… -> 0.4167
    expect(bpmToCps(100)).toBe(0.4167);
    expect(bpmToCps(140)).toBe(0.5833);
  });
});

describe("injectTempo — reference case list", () => {
  for (const testCase of CASES as Case[]) {
    it(`${testCase.id}: ${testCase.result} -> ${POLICY_FOR[testCase.result]}`, () => {
      const { code, bpm } = testCase;
      const out = injectTempo(code, bpm);
      expect(out.policy).toBe(POLICY_FOR[testCase.result]);
      expect(parensBalanced(out.code)).toBe(true);

      if (testCase.result === "insert" || testCase.result === "reject") {
        // Nothing is rewritten in place: the original source survives verbatim
        // after a single prepended setcps line.
        expect(out.code).toBe(`setcps(${bpmToCps(bpm)})\n${code}`);
      }
    });
  }
});

describe("injectTempo — replacement", () => {
  it("replaces a nested-paren argument without corrupting parens", () => {
    const out = injectTempo("setcps(120 / (60 * 4))\nnote(\"c3 e3 g3\")", 120);
    expect(out.policy).toBe("replaced");
    expect(out.code).toBe("setcps(0.5)\nnote(\"c3 e3 g3\")");
    // The old regex produced `setcps(0.5))` — a syntax error.
    expect(out.code).not.toContain("setcps(0.5))");
  });

  it("replaces a plain numeric argument", () => {
    const out = injectTempo('setcps(0.75)\nsound("bd hh")', 120);
    expect(out.policy).toBe("replaced");
    expect(out.code).toBe('setcps(0.5)\nsound("bd hh")');
  });

  it("preserves surrounding whitespace and trailing code exactly", () => {
    const out = injectTempo('setcps( 0.75 ) // tempo\nsound("bd")', 120);
    expect(out.policy).toBe("replaced");
    expect(out.code).toBe('setcps(0.5) // tempo\nsound("bd")');
  });

  it("converts to cycles per minute for setcpm", () => {
    // 90 bpm / 4 quarter notes per cycle = 22.5 cycles per minute
    const out = injectTempo('setcpm(30)\nnote("c3")', 90);
    expect(out.policy).toBe("replaced");
    expect(out.code).toBe('setcpm(22.5)\nnote("c3")');
  });

  it("uses quarterNotesPerCycle for both units", () => {
    expect(injectTempo("setcps(1)", 120, 2).code).toBe("setcps(1)");
    expect(injectTempo("setcps(9)", 120, 2).code).toBe("setcps(1)");
    expect(injectTempo("setcpm(9)", 120, 2).code).toBe("setcpm(60)");
  });

  it("replaces a setter that follows other top-level statements", () => {
    const out = injectTempo('await initHydra()\nsetcps(0.9)\nnote("c3")', 120);
    expect(out.policy).toBe("replaced");
    expect(out.code).toBe('await initHydra()\nsetcps(0.5)\nnote("c3")');
  });

  it("rounds the injected value to 4 decimals", () => {
    expect(injectTempo("setcps(1)", 100).code).toBe("setcps(0.4167)");
    expect(injectTempo("", 100).code).toBe("setcps(0.4167)\n");
  });
});

describe("injectTempo — lexical look-alikes are ignored", () => {
  it("ignores setcps inside a // line comment", () => {
    const out = injectTempo('// setcps(999)\nnote("c3")', 90);
    expect(out.policy).toBe("inserted");
    expect(out.code).toBe('setcps(0.375)\n// setcps(999)\nnote("c3")');
  });

  it("ignores setcps inside a /* block */ comment", () => {
    const out = injectTempo('/* setcps(999)\n   more */\nnote("c3")', 90);
    expect(out.policy).toBe("inserted");
    expect(out.code.startsWith("setcps(0.375)\n/*")).toBe(true);
  });

  it("ignores setcps inside a string literal", () => {
    const out = injectTempo('const label = "setcps(999)";\nnote("c3")', 100);
    expect(out.policy).toBe("inserted");
  });

  it("ignores setcps inside a template literal's text", () => {
    const out = injectTempo("const label = `setcps(999)`;\nnote(\"c3\")", 100);
    expect(out.policy).toBe("inserted");
  });

  it("ignores setcps inside a regex literal", () => {
    const out = injectTempo('const r = /setcps\\(999\\)/;\nnote("c3")', 100);
    expect(out.policy).toBe("inserted");
  });

  it("is not confused by a URL inside a string (// is not a comment there)", () => {
    const code =
      "samples('https://raw.githubusercontent.com/x/y/main/strudel.json')\nsetcps(0.9)\nnote(\"c3\")";
    const out = injectTempo(code, 120);
    expect(out.policy).toBe("replaced");
    expect(out.code).toContain("https://raw.githubusercontent.com/x/y/main/strudel.json");
    expect(out.code).toContain("setcps(0.5)");
  });

  it("is not confused by division elsewhere in the pattern", () => {
    const out = injectTempo('note("c3").gain(1 / 2)\nsetcps(0.9)', 120);
    expect(out.policy).toBe("replaced");
    expect(out.code).toBe('note("c3").gain(1 / 2)\nsetcps(0.5)');
  });
});

describe("injectTempo — ambiguity is never rewritten in place", () => {
  const ambiguous: Array<[string, string]> = [
    ["multiple top-level setters", 'setcps(0.5); setcps(0.6); note("c3")'],
    ["a setter nested in a function body", 'function later(){setcps(0.5)}; note("c3")'],
    ["a setter nested in a call", 'stack(setcps(0.5), note("c3"))'],
    ["a setter nested in an arrow body", 'const f = () => setcps(0.5); note("c3")'],
    ["a shadowing declaration", 'const setcps = x => x; setcps(0.5); note("c3")'],
    ["an alias", 'const tempo = setcps; note("c3")'],
    ["an effectful argument", 'setcps(getTempo()); note("c3")'],
    ["a member call", 'clock.setcps(0.5); note("c3")'],
    ["a setter inside a template expression", 'const t = `${setcps(0.5)}`; note("c3")'],
    ["a setter mid-expression", 'const x = setcps(0.5); note("c3")'],
    ["an argument with a string", "setcps('0.5'); note(\"c3\")"],
    ["an unbalanced call", 'setcps(0.5 ; note("c3")'],
  ];

  for (const [label, code] of ambiguous) {
    it(`prepends instead of rewriting for ${label}`, () => {
      const out = injectTempo(code, 90);
      expect(out.policy).toBe("inserted-ambiguous");
      expect(out.code).toBe(`setcps(0.375)\n${code}`);
    });
  }

  it("prepends without scanning when the source is very large", () => {
    const code = `setcps(0.9)\n${'note("c3")\n'.repeat(7000)}`;
    expect(code.length).toBeGreaterThan(65536);
    const out = injectTempo(code, 120);
    expect(out.policy).toBe("inserted-ambiguous");
    expect(out.code).toBe(`setcps(0.5)\n${code}`);
  });
});

describe("injectTempo — insertion placement", () => {
  it("prepends on the first line when there is no prologue", () => {
    const out = injectTempo('note("c3")', 120);
    expect(out.code.split("\n")[0]).toBe("setcps(0.5)");
  });

  it("inserts after a \"use strict\" directive prologue", () => {
    const out = injectTempo('"use strict";\nnote("c3")', 120);
    expect(out.policy).toBe("inserted");
    expect(out.code).toBe('"use strict";\nsetcps(0.5)\nnote("c3")');
  });

  it("inserts after a shebang line", () => {
    const out = injectTempo('#!/usr/bin/env strudel\nnote("c3")', 120);
    expect(out.code).toBe('#!/usr/bin/env strudel\nsetcps(0.5)\nnote("c3")');
  });

  it("does not split an expression that merely starts with a string", () => {
    const out = injectTempo('"bd hh".split(" ")', 120);
    expect(out.code).toBe('setcps(0.5)\n"bd hh".split(" ")');
  });
});

describe("injectTempo — guards", () => {
  it("returns the code untouched when bpm is missing or non-positive", () => {
    const code = 'setcps(0.9)\nnote("c3")';
    for (const bpm of [0, -1, Number.NaN, undefined as unknown as number]) {
      expect(injectTempo(code, bpm).code).toBe(code);
    }
  });

  it("falls back to 4 quarter notes per cycle for a bad divisor", () => {
    expect(injectTempo("setcps(9)", 120, 0).code).toBe("setcps(0.5)");
    expect(injectTempo("setcps(9)", 120, Number.NaN).code).toBe("setcps(0.5)");
  });

  it("always returns balanced parens", () => {
    const samples = [
      'setcps(120 / (60 * 4))\nnote("c3")',
      'setcps(getTempo()); note("c3")',
      '// setcps(1)\nnote("c3")',
      'stack(setcps(0.5), note("c3"))',
      "",
    ];
    for (const code of samples) {
      expect(parensBalanced(injectTempo(code, 110).code)).toBe(true);
    }
  });
});
