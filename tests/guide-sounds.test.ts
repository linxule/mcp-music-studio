import { describe, expect, it } from "vitest";
import { STRUDEL_GUIDES } from "../src/strudel-guide";
import { ABC_GUIDES } from "../src/abc-guide";
import gmNames from "./fixtures/gm-sound-names.json";
import strudelSounds from "../src/shared/data/strudel-sounds.json";

/**
 * Every sound and bank name the guides tell an agent to use must actually be
 * registered by @strudel/repl's prebake(). superdough throws
 * "sound <name> not found" for an unknown name, which silently mutes that
 * layer — so a wrong name in the guide is a pattern that renders and plays
 * nothing, with no error the agent can see.
 *
 * Data: src/shared/data/strudel-sounds.json (regenerate with
 * `bun scripts/sync-strudel-sounds.mjs`) and gm-sound-names.json.
 *
 * Escape hatch: a guide line containing the literal text "needs samples()" is
 * exempt — it documents a bank/sound that requires an explicit samples() load
 * and says so to the reader.
 */

const NEEDS_SAMPLES_MARKER = "needs samples()";

/** Sounds a guide may name as a fill-in-the-blank rather than a real sound. */
const PLACEHOLDERS = new Set([
  "gm_",
  "gm_instrument_name",
  "MachineName",
  "sample",
  "samplename",
]);

/** Lines the guide itself flags as counter-examples ("WRONG:  s(\"c3 e3\")"). */
const isCounterExample = (line: string) => /^WRONG\b/.test(line.trim());

const registeredSounds = new Set<string>([
  ...(strudelSounds.samples as string[]),
  ...(strudelSounds.synths as string[]),
  ...(gmNames as string[]),
]);
const registeredBanks = new Set<string>(strudelSounds.drumBanks as string[]);

/** `s("...")`, `sound("...")`, `.s("...")` — the sound-source setters. */
const SOUND_CALL = /(?:^|[^\w.])(?:\.)?(?:s|sound)\(\s*(["'])([^"'\n]*)\1/g;
/** `.bank("...")` */
const BANK_CALL = /\.bank\(\s*(["'])([^"'\n]*)\1/g;

/**
 * Reduce one mini-notation word to the bare sound name.
 * Strips grouping/alternation brackets, repetition and elongation operators,
 * euclid arguments, sample indices, and the probability suffix.
 */
function bareName(word: string): string {
  return word
    .replace(/\([^)]*\)?/g, "") // euclid args: bd(3,8)
    .replace(/[<>[\]{}(),~]/g, "") // grouping / alternation / rest / stack
    .replace(/[*!/@%][\d.]*/g, "") // *4  !3  /2  @3  %4
    .replace(/\?[\d.]*/g, "") // bd?  bd?0.3
    .replace(/:.*$/, "") // bd:1  bd:0:0.3
    .replace(/^\.+|\.+$/g, "")
    .trim();
}

function tokensIn(pattern: string): string[] {
  return pattern
    .split(/\s+/)
    .map(bareName)
    .filter((t) => t.length > 0 && !/^[\d.]+$/.test(t));
}

interface Mention {
  readonly topic: string;
  readonly name: string;
  readonly line: string;
}

function collect(guides: Record<string, string>, source: string): { sounds: Mention[]; banks: Mention[] } {
  const sounds: Mention[] = [];
  const banks: Mention[] = [];
  for (const [topic, text] of Object.entries(guides)) {
    for (const line of text.split("\n")) {
      if (line.includes(NEEDS_SAMPLES_MARKER) || isCounterExample(line)) continue;
      const label = `${source}:${topic}`;
      for (const m of line.matchAll(SOUND_CALL)) {
        for (const name of tokensIn(m[2])) sounds.push({ topic: label, name, line: line.trim() });
      }
      for (const m of line.matchAll(BANK_CALL)) {
        for (const name of tokensIn(m[2])) banks.push({ topic: label, name, line: line.trim() });
      }
    }
  }
  return { sounds, banks };
}

const strudel = collect(STRUDEL_GUIDES, "strudel");
const abc = collect(ABC_GUIDES, "abc");
const allSounds = [...strudel.sounds, ...abc.sounds];
const allBanks = [...strudel.banks, ...abc.banks];

const describeMention = (m: Mention) => `${m.topic}: ${m.name}  <-  ${m.line}`;

describe("guide sound names are registered by prebake()", () => {
  it("extracts sound names from both guides", () => {
    expect(allSounds.length).toBeGreaterThan(50);
    expect(allBanks.length).toBeGreaterThan(5);
  });

  it("every s()/sound()/.s() name is a registered sample, GM soundfont, or synth", () => {
    const unknown = allSounds
      .filter((m) => !registeredSounds.has(m.name) && !PLACEHOLDERS.has(m.name))
      .map(describeMention);
    expect([...new Set(unknown)]).toEqual([]);
  });

  it("every .bank() name is a real drum machine bank or alias", () => {
    const unknown = allBanks
      .filter((m) => !registeredBanks.has(m.name) && !PLACEHOLDERS.has(m.name))
      .map(describeMention);
    expect([...new Set(unknown)]).toEqual([]);
  });

  it("only references real gm_* soundfont names", () => {
    const canonical = new Set(gmNames as string[]);
    const mentioned = new Set<string>();
    for (const text of [...Object.values(STRUDEL_GUIDES), ...Object.values(ABC_GUIDES)]) {
      for (const m of text.matchAll(/gm_[a-z0-9_]*/g)) mentioned.add(m[0]);
    }
    const unknown = [...mentioned].filter((n) => !canonical.has(n) && !PLACEHOLDERS.has(n));
    expect(unknown).toEqual([]);
  });

  it("the vendored sample-name lists in the sounds topic are all loaded", () => {
    // The "Sample Libraries Loaded by Default" section lists bare sound names,
    // two-space-indented, comma separated. This is the list that was ~54 names
    // of pure fiction before (the full Dirt library, which dough-samples does
    // not ship) — it must stay generated from the real manifests.
    const section = STRUDEL_GUIDES.sounds.split("## Sample Libraries Loaded by Default")[1] ?? "";
    const block = section.split("## Drum Machine Banks")[0];
    const listed = new Set<string>();
    for (const line of block.split("\n")) {
      if (!/^ {2}[a-z]/.test(line)) continue;
      for (const raw of line.split(",")) {
        const name = raw.trim();
        if (/^[a-z][a-z0-9_]*$/.test(name)) listed.add(name);
      }
    }
    expect(listed.size).toBeGreaterThan(150);
    expect([...listed].filter((n) => !registeredSounds.has(n))).toEqual([]);
  });

  it("bank names listed as prose in the sounds topic are real", () => {
    // The "Popular Banks" block lists bare bank names, one group per line.
    const block = STRUDEL_GUIDES.sounds.split("### Popular Banks")[1]?.split("###")[0] ?? "";
    const named = block
      .split(/[\s,]+/)
      .map((w) => w.trim())
      .filter((w) => /^[A-Z][A-Za-z0-9]{3,}$/.test(w));
    expect(named.length).toBeGreaterThan(20);
    expect(named.filter((n) => !registeredBanks.has(n))).toEqual([]);
  });
});

describe("strudel-sounds fixture", () => {
  it("matches the manifests prebake() actually loads", () => {
    expect(strudelSounds.strudelReplVersion).toBe("1.3.0");
    expect(strudelSounds.sampleManifests).toHaveLength(6);
    // 71 distinct bank prefixes in tidal-drum-machines.json + 67 short aliases
    expect(new Set(strudelSounds.drumBanks).size).toBe(138);
    expect(registeredBanks.has("RolandTR808")).toBe(true);
    expect(registeredBanks.has("BossDR660")).toBe(false);
    // Dirt-Samples.json on dough-samples is a 9-entry subset, not the full library
    expect(registeredSounds.has("casio")).toBe(true);
    expect(registeredSounds.has("arpy")).toBe(false);
    // vcsl orchestral/percussion pack is loaded
    expect(registeredSounds.has("marimba")).toBe(true);
    expect(registeredSounds.has("steinway")).toBe(true);
  });
});
