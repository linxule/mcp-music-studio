import { describe, expect, it } from "vitest";
import { Scale } from "tonal";
import strudelScales from "./fixtures/strudel-scale-names.json";
import { STRUDEL_GUIDES } from "../src/strudel-guide";
import { ABC_GUIDES } from "../src/abc-guide";

/**
 * Every `.scale("...")` name in the guides must resolve in tonal.
 *
 * @strudel/tonal's getScale() is literally:
 *
 *   scaleName = scaleName.replaceAll(':', ' ');
 *   const scale = Scale.get(scaleName);
 *   if ((empty && isNote(scaleName)) || (empty && !tonic)) logger(...error);
 *   throw new Error(`Invalid scale name "${scaleName}"`);
 *
 * so a camel-case name such as "melodicMinor", "minPent", "wholetone",
 * "bebopMajor" or "hex" is NOT a scale — tonal returns an empty scale, the
 * pattern throws inside query, and the layer produces no notes at all.
 * Multi-word scales must be spelled with colons: "melodic:minor".
 */

/** The exact transform @strudel/tonal@1.2.6 applies before Scale.get(). */
const toTonal = (name: string) => name.replaceAll(":", " ");

/**
 * @strudel/repl@1.3.0 bundles an older tonal table than our `tonal` dependency
 * (it spells "neopolitan major" where tonal 6.4.3 spells it "neapolitan
 * major"), so a name is only safe to teach if BOTH accept it.
 * tests/fixtures/strudel-scale-names.json is scraped from the pinned bundle by
 * scripts/sync-strudel-scales.mjs.
 */
const bundleScaleNames = new Set(strudelScales.names as string[]);

/** Drop the tonic, leaving the scale type the way both tables spell it. */
const scaleTypeOf = (name: string) => {
  const parsed = Scale.get(toTonal(name));
  return parsed.type;
};

const isKnownScale = (name: string) => {
  const parsed = Scale.get(toTonal(name));
  if (parsed.empty) return false;
  return bundleScaleNames.has(parsed.type);
};

const SCALE_CALL = /\.scale\(\s*(["'])([^"'\n]*)\1/g;

interface Mention {
  readonly where: string;
  readonly name: string;
}

function collectScales(): Mention[] {
  const out: Mention[] = [];
  for (const [source, guides] of [
    ["strudel", STRUDEL_GUIDES],
    ["abc", ABC_GUIDES],
  ] as const) {
    for (const [topic, text] of Object.entries(guides)) {
      for (const m of text.matchAll(SCALE_CALL)) {
        // strip mini-notation alternation: .scale("<C:major D:dorian>")
        for (const raw of m[2].replace(/[<>[\]{}]/g, " ").split(/\s+/)) {
          const name = raw.trim();
          if (name.length > 0) out.push({ where: `${source}:${topic}`, name });
        }
      }
    }
  }
  return out;
}

/**
 * Scale names the guides list as prose (the "Available scales" block in
 * `patterns` and the "Scales" block in `advanced`). These are what an agent
 * actually copies from, so they matter as much as the executable examples.
 */
function collectProseScaleNames(): Mention[] {
  const out: Mention[] = [];
  const blocks: Array<[string, string]> = [
    ["patterns", STRUDEL_GUIDES.patterns.split("Single-word scales:")[1]?.split("\n\n")[0] ?? ""],
    [
      "patterns",
      STRUDEL_GUIDES.patterns.split("Multi-word scales (mind the colon):")[1]?.split("\n\n")[0] ?? "",
    ],
    ["advanced", STRUDEL_GUIDES.advanced.split("## Scales")[1]?.split("\n\n")[1] ?? ""],
  ];
  for (const [where, block] of blocks) {
    for (const raw of block.split(/[,\n]/)) {
      const name = raw.replace(/^\s*-\s*/, "").trim();
      if (/^[a-z][a-z0-9:#-]*[a-z0-9]$/.test(name)) out.push({ where: `strudel:${where}`, name });
    }
  }
  return out;
}

const calls = collectScales();
const prose = collectProseScaleNames();

describe("guide scale names resolve in tonal", () => {
  it("finds .scale() calls in the guides", () => {
    expect(calls.length).toBeGreaterThan(3);
  });

  it("every .scale(\"...\") name is a real tonal scale", () => {
    const bad = calls.filter((m) => !isKnownScale(m.name)).map((m) => `${m.where}: ${m.name}`);
    expect([...new Set(bad)]).toEqual([]);
  });

  it("every scale name listed in prose is a real tonal scale", () => {
    expect(prose.length).toBeGreaterThan(30);
    const bad = prose.filter((m) => !isKnownScale(m.name)).map((m) => `${m.where}: ${m.name}`);
    expect([...new Set(bad)]).toEqual([]);
  });

  it("documents the camel-case names that silently produce no notes", () => {
    // Regression guard: these are the spellings the guide used to teach.
    for (const dead of [
      "minPent",
      "hex",
      "bebopMajor",
      "melodicMinor",
      "harmonicMinor",
      "whole",
      "wholetone",
      "neapolitan",
    ]) {
      expect(isKnownScale(dead), `${dead} unexpectedly resolves`).toBe(false);
    }
    // ...and their working spellings.
    for (const live of [
      "minor:pentatonic",
      "melodic:minor",
      "harmonic:minor",
      "whole:tone",
      "bebop:major",
      "half-whole:diminished",
    ]) {
      expect(isKnownScale(live), `${live} should resolve`).toBe(true);
    }
    // The dead spellings may still appear as explicit "do not use this"
    // callouts, but never inside a .scale() call — that is what `calls` covers.
    const inCalls = calls.map((m) => m.name);
    for (const dead of ["melodicMinor", "harmonicMinor", "bebopMajor", "minPent", "wholetone"]) {
      expect(inCalls).not.toContain(dead);
    }
  });

  it("a tonic with an octave still resolves (Strudel's C4:minor form)", () => {
    expect(isKnownScale("C4:minor")).toBe(true);
    expect(isKnownScale("C4:minor:pentatonic")).toBe(true);
    expect(scaleTypeOf("C4:whole:tone")).toBe("whole tone");
  });

  it("guards the one name the bundled tonal spells differently", () => {
    // tonal 6.4.3 renamed neopolitan -> neapolitan; @strudel/repl@1.3.0 still
    // ships the old table, so neither spelling is safe to teach.
    expect(Scale.get("C neapolitan major").empty).toBe(false);
    expect(bundleScaleNames.has("neapolitan major")).toBe(false);
    expect(bundleScaleNames.has("neopolitan major")).toBe(true);
    expect(isKnownScale("neapolitan:major")).toBe(false);
    const all = [...Object.values(STRUDEL_GUIDES), ...Object.values(ABC_GUIDES)].join("\n");
    expect(all).not.toContain("neapolitan");
    expect(all).not.toContain("neopolitan");
  });
});
