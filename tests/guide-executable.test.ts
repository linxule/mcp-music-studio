import { describe, expect, it } from "vitest";
import { STRUDEL_GUIDES } from "../src/strudel-guide";
import gmNames from "./fixtures/gm-sound-names.json";
import strudelSounds from "../src/shared/data/strudel-sounds.json";
import { extractBlocks, parses, type GuideBlock } from "./guide-blocks";
import { evalStrudel, queryHaps, setupStrudel } from "./strudel-eval";

/**
 * RUN the guide's examples.
 *
 * guide-sounds and guide-scales prove that every NAME the guides use exists.
 * They cannot see an example that parses, resolves every name, and still
 * produces zero events — which is exactly what happens when a Pattern is
 * handed to something that wants a function:
 *
 *   s("~ [~ cp]").sometimes(gain(0.7))   // "e is not a function" at QUERY time
 *
 * That threw inside `queryArc`, so it silenced the whole Minimal Techno
 * template, and nothing in the suite noticed. This file evaluates each example
 * with the real @strudel/core + mini + tonal + transpiler (pinned to what
 * @strudel/repl@1.3.0 depends on) and asserts it actually produces haps.
 *
 * What this certifies: parsing, name resolution, and event structure/timing.
 * What it does NOT: audio. superdough, @strudel/draw and Hydra are stubbed.
 */

const CYCLES = 8;

/**
 * Names the guides use as fill-in-the-blanks in a reference line
 * (`stack(pat1, pat2)     layer patterns simultaneously`). A block that leans
 * on one is illustrating a signature, not offering a runnable example. Every
 * OTHER undefined name is a real failure, so this list is deliberately closed.
 */
const PLACEHOLDER_NAMES = new Set([
  "pat1",
  "pat2",
  "drums",
  "bass",
  "melody",
  "lead",
]);

/** Blocks the guide itself marks as needing an explicit samples() load. */
const NEEDS_SAMPLES = "needs samples()";

/**
 * Examples that are correct AND silent. Empty today; if the guides ever teach
 * `hush()` or a deliberate `silence`, name the block here rather than
 * weakening the assertion for everything.
 */
const EXPECTED_SILENT = new Set<string>([]);

const registeredSounds = new Set<string>([
  ...(strudelSounds.samples as string[]),
  ...(strudelSounds.synths as string[]),
  ...(gmNames as string[]),
]);

type Category = "run" | "fragment" | "setup" | "placeholder";

function categorize(block: GuideBlock): Category {
  // Hydra setup: browser/WebGL side effects, no Strudel pattern of its own.
  if (/\binitHydra\b/.test(block.code)) return "setup";
  if (!parses(block.code)) return "fragment";
  const declared = new Set(
    [...block.code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
  );
  for (const name of PLACEHOLDER_NAMES) {
    if (declared.has(name)) continue;
    if (new RegExp(`\\b${name}\\b`).test(block.code)) return "placeholder";
  }
  return "run";
}

const all = Object.entries(STRUDEL_GUIDES).flatMap(([topic, text]) =>
  extractBlocks(topic, text),
);
const categorized = all.map((block) => ({ block, category: categorize(block) }));
const runnable = categorized.filter((c) => c.category === "run").map((c) => c.block);
const label = (b: GuideBlock) => `${b.topic}:${b.line} ${b.heading}`;

describe("strudel guide examples actually run", () => {
  it("finds a substantial corpus of complete examples", () => {
    // A floor, not an exact count: the point is that a change to the extractor
    // (or to the guides) can't silently reduce coverage to nothing.
    expect(runnable.length).toBeGreaterThanOrEqual(50);
  });

  it.each(runnable.map((b) => [label(b), b] as const))(
    "%s produces events",
    async (_name, block) => {
      const { pattern, error } = await evalStrudel(block.code);
      expect(error, `evaluating:\n${block.code}`).toBeUndefined();
      expect(pattern, `evaluating:\n${block.code}`).toBeDefined();

      const { haps, error: queryError } = queryHaps(pattern!, CYCLES);
      expect(queryError, `querying:\n${block.code}`).toBeUndefined();

      if (EXPECTED_SILENT.has(label(block))) {
        expect(haps.length).toBe(0);
        return;
      }
      expect(
        haps.length,
        `no events over ${CYCLES} cycles — this example is SILENT:\n${block.code}`,
      ).toBeGreaterThan(0);
    },
  );

  it.each(
    runnable
      .filter((b) => !b.code.includes(NEEDS_SAMPLES))
      .map((b) => [label(b), b] as const),
  )("%s only plays registered sounds", async (_name, block) => {
    const { pattern } = await evalStrudel(block.code);
    if (!pattern) return; // reported by the previous assertion
    const { haps } = queryHaps(pattern, CYCLES);
    const unknown = new Set<string>();
    for (const hap of haps) {
      const s = (hap as any)?.value?.s;
      if (typeof s === "string" && !registeredSounds.has(s)) unknown.add(s);
    }
    expect(
      [...unknown],
      `sounds prebake() never registers — superdough throws "sound not found" ` +
        `and the layer is silent:\n${block.code}`,
    ).toEqual([]);
  });
});

describe("strudel guide method names exist", () => {
  /**
   * Reference lines like `.euclidInv(hits, steps)  the complement` never reach
   * the executable corpus — nothing about them parses as a runnable example —
   * so a method that upstream simply does not have can sit in the guide
   * forever. (`.euclidInv` was exactly that: plausible, documented, absent.)
   *
   * The `visuals` topic is excluded: its chains are Hydra's API (.kaleid(),
   * .modulateRotate(), .colorama() ...), not Strudel's, and Hydra is a WebGL
   * runtime this suite deliberately does not bring up.
   */
  const CHECKED = Object.entries(STRUDEL_GUIDES).filter(([topic]) => topic !== "visuals");

  /** Method names the guides name in order to say they do NOT exist. */
  const COUNTEREXAMPLES = new Set([
    "choose", // "There is NO .choose() / .wchoose() / .rand() / .irand()"
    "wchoose",
    "rand",
    "irand",
    "setcps", // tips: WRONG: note("c3 e3").setcps(0.5)
  ]);

  const METHOD_CALL = /(?:^|[^\w.$'"])\.([a-zA-Z_$][\w$]*)\s*\(/gm;

  it("every .method() the guides teach is on Pattern", async () => {
    await setupStrudel();
    const proto = (await import("@strudel/core")).Pattern.prototype as object;
    const known = new Set<string>();
    for (let o: object | null = proto; o; o = Object.getPrototypeOf(o)) {
      for (const k of Object.getOwnPropertyNames(o)) known.add(k);
    }
    const missing = new Set<string>();
    for (const [topic, text] of CHECKED) {
      for (const [, name] of text.matchAll(METHOD_CALL)) {
        if (!known.has(name) && !COUNTEREXAMPLES.has(name)) {
          missing.add(`${topic}: .${name}()`);
        }
      }
    }
    expect([...missing].sort()).toEqual([]);
  });
});

describe("strudel guide chord symbols resolve", () => {
  /** `voicing("...")` / `.chord("...")` arguments across the guides. */
  const CHORD_CALL = /(?:^|[^\w.])(?:\.)?(?:voicing|chord)\(\s*(["'])([^"'\n]*)\1/g;

  const symbols = new Map<string, string>();
  for (const [topic, text] of Object.entries(STRUDEL_GUIDES)) {
    for (const [, , arg] of text.matchAll(CHORD_CALL)) {
      for (const raw of arg.split(/\s+/)) {
        const sym = raw
          .replace(/[<>[\]{}(),~]/g, "")
          .replace(/[*!/@%][\d.]*/g, "")
          .replace(/\?[\d.]*/g, "")
          .trim();
        if (sym) symbols.set(sym, topic);
      }
    }
  }

  it("finds chord symbols to check", () => {
    expect(symbols.size).toBeGreaterThan(0);
  });

  it.each([...symbols].map(([sym, topic]) => [sym, topic] as const))(
    "%s voices under the default ireal dictionary (%s)",
    async (sym) => {
      await setupStrudel();
      const { pattern, error } = await evalStrudel(`voicing("${sym}")`);
      expect(error).toBeUndefined();
      const { haps } = queryHaps(pattern!, 1);
      expect(
        haps.length,
        `voicing("${sym}") yields NO notes. The default dictionary is "ireal", ` +
          `whose keys are iReal Pro suffixes: major 7th is "^7"/"M7", not "maj7". ` +
          `A symbol it does not know voices to silence with no error.`,
      ).toBeGreaterThan(0);
    },
  );
});
