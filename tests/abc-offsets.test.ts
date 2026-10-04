// A click on the score reports abcjs's startChar/endChar into the EFFECTIVE ABC
// (style block inserted, program overridden); the editor holds the RAW ABC.
// src/abc-offsets.ts maps between them. Held here against the real derivation
// and the real parser: every note abcjs finds must map to the same characters.
import ABCJS from "abcjs";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { abcOffsetMap } from "../src/abc-offsets";
import { deriveEffectiveAbc } from "../src/abc-program";
import { STYLE_NAMES } from "../src/music-logic";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "abc");
const corpus = readdirSync(FIXTURES)
  .filter((name) => name.endsWith(".abc") && !name.startsWith("10-"))
  .map((name) => [name, readFileSync(path.join(FIXTURES, name), "utf8")] as const);

/** A tune whose first voice sets its own program, so an override rewrites it. */
const WITH_PROGRAM = `X:1
T:Program
M:4/4
L:1/8
K:D
%%MIDI program 73
"D"d2 f2 a2 f2 | "G"g2 b2 "A"a4 |]`;

/** Every note/rest element abcjs parsed, with its source span. */
function noteSpans(abc: string): Array<[number, number]> {
  const tune = ABCJS.parseOnly(abc)[0];
  const spans: Array<[number, number]> = [];
  for (const line of tune.lines) {
    for (const staff of line.staff ?? []) {
      for (const voice of staff.voices ?? []) {
        for (const el of voice as Array<{ el_type?: string; startChar?: number; endChar?: number }>) {
          if (el.el_type === "note" && typeof el.startChar === "number" && typeof el.endChar === "number") {
            spans.push([el.startChar, el.endChar]);
          }
        }
      }
    }
  }
  return spans;
}

const cases = [...corpus, ["program-override", WITH_PROGRAM] as const];
const optionSets = [
  ...["", ...STYLE_NAMES].map((style) => ({ style, programOverride: null })),
  { style: "jazz", programOverride: 40 },
  { style: "", programOverride: 105 },
];

describe("abcOffsetMap", () => {
  for (const [name, raw] of cases) {
    for (const options of optionSets) {
      it(`${name}, style "${options.style}", override ${options.programOverride}`, () => {
        const map = abcOffsetMap(raw, options);
        expect(map).not.toBeNull();
        expect(map!.effective).toBe(deriveEffectiveAbc(raw, options));
        const spans = noteSpans(map!.effective);
        expect(spans.length).toBeGreaterThan(0);
        for (const [start, end] of spans) {
          const rawStart = map!.toRaw(start);
          const rawEnd = map!.toRaw(end);
          expect(raw.slice(rawStart, rawEnd)).toBe(map!.effective.slice(start, end));
          expect(map!.toEffective(rawStart)).toBe(start);
          expect(map!.toEffective(rawEnd)).toBe(end);
        }
      });
    }
  }

  it("the override and the style really moved the notes (the test can fail)", () => {
    const options = { style: "jazz", programOverride: 105 };
    const map = abcOffsetMap(WITH_PROGRAM, options)!;
    const [start] = noteSpans(map.effective)[0];
    expect(map.toRaw(start)).not.toBe(start);
    // "73" → "105" adds one character before the body, the jazz block more.
    expect(start - map.toRaw(start)).toBeGreaterThan(1);
  });

  it("an offset inside the inserted %%MIDI block maps to where it went in", () => {
    const raw = "X:1\nK:C\nCDEF|]";
    const map = abcOffsetMap(raw, { style: "rock" })!;
    const inserted = map.effective.indexOf("%%MIDI");
    expect(inserted).toBe(raw.indexOf("CDEF"));
    expect(map.toRaw(inserted + 3)).toBe(raw.indexOf("CDEF"));
  });

  it("no style and no override is the identity", () => {
    const raw = corpus[0][1];
    const map = abcOffsetMap(raw, { style: "" })!;
    expect(map.effective).toBe(raw);
    expect(map.toRaw(17)).toBe(17);
  });
});
