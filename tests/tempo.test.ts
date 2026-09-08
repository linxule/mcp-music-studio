import { describe, expect, it } from "vitest";
import { bpmToCps, injectTempo, type TempoPolicy } from "../src/shared/tempo";

import CASES from "./fixtures/tempo-cases.json";

interface Case {
  id: string;
  code: string;
  bpm: number;
  result: "transform" | "insert" | "reject" | "leave";
}

/** The reference transform's outcomes mapped onto our policy names. */
const POLICY_FOR: Record<Case["result"], TempoPolicy> = {
  transform: "replaced",
  insert: "inserted",
  reject: "inserted-ambiguous",
  leave: "unchanged-ambiguous",
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

/**
 * Real JavaScript parsing, via the engine. `new Function(body)` compiles `body`
 * as a function body, so top-level `await` is a syntax error there even though
 * it is legal in a Strudel pattern — those inputs are skipped explicitly.
 */
function parses(code: string): boolean {
  try {
    // eslint-disable-next-line no-new-func
    new Function(code);
    return true;
  } catch {
    return false;
  }
}

function hasTopLevelAwait(code: string): boolean {
  return /\bawait\b/.test(code);
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
      // The runtime escape hatch is always available, whatever the policy.
      expect(out.cps).toBe(bpmToCps(bpm));

      if (testCase.result === "leave") {
        // Nothing at all happens to the source: the caller applies out.cps.
        expect(out.code).toBe(code);
      }

      if (testCase.result === "insert" || testCase.result === "reject") {
        // Nothing is rewritten in place: the original source survives verbatim
        // once a single semicolon-terminated setcps line is removed again.
        // (The line lands at the top, or just after a shebang / directive
        // prologue — see "insertion placement".)
        const line = `setcps(${bpmToCps(bpm)});\n`;
        expect(out.code).toContain(line);
        expect(out.code.replace(line, "")).toBe(code);
      }
    });
  }
});

describe("injectTempo — every output is still parseable JavaScript", () => {
  const extras: string[] = [
    '(() => note("c3"))()',
    '["bd", "hh"].forEach((s) => sound(s))',
    '"use strict";\n(function () { return note("c3"); })()',
    'if (false)\n  setcps(0.25);\nnote("c3")',
    'if (a) { note("c3") } else setcps(0.25);\nnote("e3")',
    'let x;\nx =\n  setcps(0.5);\nnote("c3")',
    'foo: setcps(0.5);\nnote("c3")',
    '/* tempo */\nsetcps(0.9)\nnote("c3")',
    'const setcps = (x) => x;\nsetcps(0.5);\nnote("c3")',
    'const { setcps } = globalThis;\nsetcps(0.5);\nnote("c3")',
    "setcps(120 / (60 * 4))\nnote(\"c3\")",
    'stack(setcps(0.5), note("c3"))',
    'const t = `${setcps(0.5)}`; note("c3")',
    'clock.setcps(0.5); note("c3")',
    'note("c3")',
    "",
  ];
  const sources = [...(CASES as Case[]).map((c) => c.code), ...extras];

  for (const [index, code] of sources.entries()) {
    const label = JSON.stringify(code.length > 48 ? `${code.slice(0, 48)}…` : code);
    it(`#${index} output parses whenever the input did: ${label}`, () => {
      if (hasTopLevelAwait(code)) return; // new Function() cannot host top-level await
      if (!parses(code)) return; // an input that never parsed proves nothing
      const out = injectTempo(code, 120);
      expect(parses(out.code)).toBe(true);
    });
  }

  it("keeps the semantics of a leading IIFE (the ASI trap in the audit)", () => {
    // Without the terminating `;` this became `setcps(0.5)(() => …)()`.
    const out = injectTempo('(() => note("c3"))()', 120);
    expect(out.policy).toBe("inserted");
    expect(out.code).toBe('setcps(0.5);\n(() => note("c3"))()');
    expect(parses(out.code)).toBe(true);
    expect(parses('setcps(0.5)\n(() => note("c3"))()')).toBe(true);
    // …and it parsed only because it meant something else: one statement,
    // a call on setcps's return value. The semicolon form is two statements.
    expect(out.code.split(";\n").length).toBe(2);
  });

  it("keeps a leading array literal from becoming an index expression", () => {
    const out = injectTempo('["bd", "hh"].forEach((s) => sound(s))', 120);
    expect(out.code.startsWith("setcps(0.5);\n[")).toBe(true);
    expect(parses(out.code)).toBe(true);
  });
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

  it("replaces a setter that follows a block comment", () => {
    expect(injectTempo('/* tempo */\nsetcps(0.9)\nnote("c3")', 120).code).toBe(
      '/* tempo */\nsetcps(0.5)\nnote("c3")',
    );
    expect(injectTempo('note("c3")\n/* tempo */ setcps(0.9)', 120).code).toBe(
      'note("c3")\n/* tempo */ setcps(0.5)',
    );
  });

  it("rounds the injected value to 4 decimals", () => {
    expect(injectTempo("setcps(1)", 100).code).toBe("setcps(0.4167)");
    expect(injectTempo("", 100).code).toBe("setcps(0.4167);\n");
  });
});

describe("injectTempo — lexical look-alikes are ignored", () => {
  it("ignores setcps inside a // line comment", () => {
    const out = injectTempo('// setcps(999)\nnote("c3")', 90);
    expect(out.policy).toBe("inserted");
    expect(out.code).toBe('setcps(0.375);\n// setcps(999)\nnote("c3")');
  });

  it("ignores setcps inside a /* block */ comment", () => {
    const out = injectTempo('/* setcps(999)\n   more */\nnote("c3")', 90);
    expect(out.policy).toBe("inserted");
    expect(out.code.startsWith("setcps(0.375);\n/*")).toBe(true);
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

describe("injectTempo — conditional setters are never replaced (S2)", () => {
  const conditional: Array<[string, string]> = [
    ["an if header on its own line", 'if (false)\n  setcps(0.25);\nnote("c3")'],
    ["a while header on its own line", 'while (false)\n  setcps(0.25);\nnote("c3")'],
    ["a for header on its own line", 'for (const x of [])\n  setcps(0.25);\nnote("c3")'],
    ["an else branch", 'if (a) { note("c3") } else setcps(0.25);\nnote("e3")'],
    ["an assignment broken over two lines", 'let x;\nx =\n  setcps(0.5);\nnote("c3")'],
    ["a labelled statement", 'foo: setcps(0.5);\nnote("c3")'],
    ["an arrow body broken over two lines", 'const f = () =>\n  setcps(0.5);\nnote("c3")'],
    ["a trailing comma continuation", 'stack(\n  note("c3"),\n  setcps(0.5)\n)'],
  ];

  for (const [label, code] of conditional) {
    it(`prepends instead of rewriting for ${label}`, () => {
      const out = injectTempo(code, 120);
      expect(out.policy).toBe("inserted-ambiguous");
      expect(out.code).toBe(`setcps(0.5);\n${code}`);
      // The pattern's own argument is untouched — nothing pretends to be applied.
      expect(out.code.endsWith(code)).toBe(true);
    });
  }

  it("still replaces a setter whose preceding ) closes a plain call", () => {
    const out = injectTempo('note("c3")\nsetcps(0.9)', 120);
    expect(out.policy).toBe("replaced");
    expect(out.code).toBe('note("c3")\nsetcps(0.5)');
  });

  it("still replaces a setter after a closing brace", () => {
    const out = injectTempo('const o = { a: 1 }\nsetcps(0.9)\nnote("c3")', 120);
    expect(out.policy).toBe("replaced");
    expect(out.code).toBe('const o = { a: 1 }\nsetcps(0.5)\nnote("c3")');
  });
});

describe("injectTempo — shadowed and aliased setters are left alone (S1)", () => {
  const untouched: Array<[string, string]> = [
    ["a const shadow", 'const setcps = x => x; setcps(0.5); note("c3")'],
    ["a let shadow", 'let setcps = (x) => x;\nsetcps(0.5);\nnote("c3")'],
    ["a var shadow", 'var setcps = 1;\nnote("c3")'],
    ["a function shadow", 'function setcps(x) { return x; }\nsetcps(0.5);\nnote("c3")'],
    ["an alias", 'const tempo = setcps; note("c3")'],
    ["a destructured binding", 'const { setcps } = globalThis;\nsetcps(0.5);\nnote("c3")'],
    ["a parameter named setcps", 'const f = (setcps) => setcps(0.5); note("c3")'],
    ["a bare reference", 'window.tempo = setcps;\nnote("c3")'],
  ];

  for (const [label, code] of untouched) {
    it(`returns the code unchanged for ${label}`, () => {
      const out = injectTempo(code, 90);
      expect(out.policy).toBe("unchanged-ambiguous");
      expect(out.code).toBe(code);
      // The tempo still reaches the caller, which applies it via the REPL API.
      expect(out.cps).toBe(0.375);
    });
  }

  it("does not prepend into a const setcps temporal dead zone", () => {
    const code = 'const setcps = (x) => x;\nnote("c3")';
    const out = injectTempo(code, 120);
    expect(out.code).toBe(code);
    // `note` is supplied as a parameter so only the TDZ can throw.
    const run = (source: string) => new Function("note", source)(() => undefined);
    // The old behaviour produced this: it parses, then throws at runtime.
    const oldBehaviour = `setcps(0.5)\n${code}`;
    expect(parses(oldBehaviour)).toBe(true);
    expect(() => run(oldBehaviour)).toThrow(ReferenceError);
    expect(() => run(out.code)).not.toThrow();
  });
});

describe("injectTempo — ambiguity is never rewritten in place", () => {
  const ambiguous: Array<[string, string]> = [
    ["multiple top-level setters", 'setcps(0.5); setcps(0.6); note("c3")'],
    ["a setter nested in a function body", 'function later(){setcps(0.5)}; note("c3")'],
    ["a setter nested in a call", 'stack(setcps(0.5), note("c3"))'],
    ["a setter nested in an arrow body", 'const f = () => setcps(0.5); note("c3")'],
    ["a setter nested in an array literal", '[setcps(0.5)]; note("c3")'],
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
      expect(out.code).toBe(`setcps(0.375);\n${code}`);
    });
  }

  it("prepends without scanning when the source is very large", () => {
    const code = `setcps(0.9)\n${'note("c3")\n'.repeat(7000)}`;
    expect(code.length).toBeGreaterThan(65536);
    const out = injectTempo(code, 120);
    expect(out.policy).toBe("inserted-ambiguous");
    expect(out.code).toBe(`setcps(0.5);\n${code}`);
  });
});

describe("injectTempo — insertion placement", () => {
  it("prepends on the first line when there is no prologue", () => {
    const out = injectTempo('note("c3")', 120);
    expect(out.code.split("\n")[0]).toBe("setcps(0.5);");
  });

  it("inserts after a \"use strict\" directive prologue", () => {
    const out = injectTempo('"use strict";\nnote("c3")', 120);
    expect(out.policy).toBe("inserted");
    expect(out.code).toBe('"use strict";\nsetcps(0.5);\nnote("c3")');
  });

  it("inserts after a \"use strict\" prologue that precedes an IIFE", () => {
    const code = '"use strict";\n(function () { return note("c3"); })()';
    const out = injectTempo(code, 120);
    expect(out.code).toBe(
      '"use strict";\nsetcps(0.5);\n(function () { return note("c3"); })()',
    );
    expect(parses(out.code)).toBe(true);
  });

  it("inserts after a shebang line", () => {
    const out = injectTempo('#!/usr/bin/env strudel\nnote("c3")', 120);
    expect(out.code).toBe('#!/usr/bin/env strudel\nsetcps(0.5);\nnote("c3")');
  });

  it("does not split an expression that merely starts with a string", () => {
    const out = injectTempo('"bd hh".split(" ")', 120);
    expect(out.code).toBe('setcps(0.5);\n"bd hh".split(" ")');
  });

  // Audit finding 12. A newline after a directive-LOOKING string is not a
  // terminator when the next token continues the expression — the old code
  // emitted `'use strict'\nsetcps(0.5);\n.trim();…`, a SyntaxError.
  describe("a directive-looking string that is really part of an expression", () => {
    const CONTINUATIONS: [string, string][] = [
      ["member access", "'use strict'\n.trim();\nnote(\"c3\")"],
      ["a call", "'use strict'\n(0);\nnote(\"c3\")"],
      ["an index", "'use strict'\n[0];\nnote(\"c3\")"],
      ["a binary operator", "'use strict'\n+ 'ish';\nnote(\"c3\")"],
      ["a ternary", "'use strict'\n? note(\"c3\") : note(\"e3\")"],
    ];

    for (const [label, code] of CONTINUATIONS) {
      it(`inserts before the whole expression when the next line is ${label}`, () => {
        expect(parses(code)).toBe(true); // the input was valid to begin with
        const out = injectTempo(code, 120);
        expect(out.code).toBe(`setcps(0.5);\n${code}`);
        expect(parses(out.code)).toBe(true);
      });
    }

    it("still treats a real newline-terminated prologue as a prologue", () => {
      const out = injectTempo("'use strict'\nnote(\"c3\")", 120);
      expect(out.code).toBe("'use strict'\nsetcps(0.5);\nnote(\"c3\")");
      expect(parses(out.code)).toBe(true);
    });

    it("still handles a semicolon-terminated \"use strict\" prologue", () => {
      const out = injectTempo('"use strict";\n(() => note("c3"))()', 120);
      expect(out.code).toBe('"use strict";\nsetcps(0.5);\n(() => note("c3"))()');
      expect(parses(out.code)).toBe(true);
    });
  });
});

describe("injectTempo — guards", () => {
  it("returns the code untouched when bpm is missing or non-positive", () => {
    const code = 'setcps(0.9)\nnote("c3")';
    for (const bpm of [0, -1, Number.NaN, undefined as unknown as number]) {
      const out = injectTempo(code, bpm);
      expect(out.code).toBe(code);
      expect(out.policy).toBe("unchanged-ambiguous");
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
