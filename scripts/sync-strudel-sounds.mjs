#!/usr/bin/env bun
/**
 * Vendors the set of sound names that @strudel/repl's prebake() actually
 * registers, into src/shared/data/strudel-sounds.json.
 *
 * Why: superdough throws "sound <name> not found" for an unregistered name and
 * silently mutes that layer. A guide that advertises a sound Strudel never
 * loaded therefore teaches agents to produce silence. tests/guide-sounds.test.ts
 * asserts every sound/bank name in the guides is in this fixture.
 *
 * Source of truth: https://unpkg.com/@strudel/repl@<STRUDEL_REPL_VERSION>/prebake.mjs
 * — it awaits exactly the six samples() manifests below plus
 * registerSynthSounds() / registerZZFXSounds() / registerSoundfonts(), then
 * aliasBank()s the tidal-drum-machines alias file.
 *
 * The GM soundfont names are read out of the SHIPPED dist bundle rather than
 * @strudel/soundfonts' source, because those two disagree: the bundle's
 * registration map has 125 gm_* keys, and registerSoundfonts() iterates it
 * directly with no alias step. gm_acoustic_piano, gm_bright_acoustic_piano,
 * gm_electric_grand_piano and gm_honky_tonk_piano exist only upstream — in the
 * widget they are "sound not found", i.e. silence. What ships is what counts.
 *
 * Usage: bun scripts/sync-strudel-sounds.mjs
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "tests", "fixtures");
// The sound inventory is production data — src/shared/strudel-validate.ts checks
// every pattern against it and the validation child bundles it — so it lives
// under src/. gm-sound-names.json is still only read by tests, so it stays put.
const SOUND_DATA = join(ROOT, "src", "shared", "data");

/** Keep in sync with the @strudel/repl CDN pin used by the widget. */
export const STRUDEL_REPL_VERSION = "1.3.0";

const RAW = ["https:/", "raw.githubusercontent.com"].join("/");
const DOUGH = `${RAW}/felixroos/dough-samples/main`;
const UZU = `${RAW}/tidalcycles/uzu-drumkit/main`;
const TODEPOND = `${RAW}/todepond/samples/main`;

/** The exact manifests prebake() passes to samples(). */
const SAMPLE_MANIFESTS = [
  `${DOUGH}/tidal-drum-machines.json`,
  `${DOUGH}/piano.json`,
  `${DOUGH}/Dirt-Samples.json`,
  `${DOUGH}/vcsl.json`,
  `${DOUGH}/mridangam.json`,
  `${UZU}/strudel.json`,
];

/** aliasBank() target — maps long bank names to short aliases; both are usable. */
const BANK_ALIASES = `${TODEPOND}/tidal-drum-machines-alias.json`;

/**
 * Synth names registered in code rather than by a manifest, read out of the
 * pinned dist bundle (@strudel/repl@1.3.0 dist/index-*.js):
 *   - registerSynthSounds(): ["triangle","square","sawtooth","sine","user","one"]
 *     plus aliases [["tri","triangle"],["sqr","square"],["saw","sawtooth"],
 *     ["sin","sine"]], plus registerSound() calls for sbd / bytebeat / pulse /
 *     supersaw / bus, plus noises ["pink","white","brown","crackle"].
 *   - registerZZFXSounds(): ["zzfx","z_sine","z_sawtooth","z_triangle",
 *     "z_square","z_tan","z_noise"].
 */
const SYNTHS = [
  "triangle",
  "square",
  "sawtooth",
  "sine",
  "user",
  "one",
  "tri",
  "sqr",
  "saw",
  "sin",
  "sbd",
  "bytebeat",
  "pulse",
  "supersaw",
  "bus",
  "pink",
  "white",
  "brown",
  "crackle",
  "zzfx",
  "z_sine",
  "z_sawtooth",
  "z_triangle",
  "z_square",
  "z_tan",
  "z_noise",
];

/** The pinned dist bundle the widget loads from the CDN. */
const REPL_BUNDLE = `https://unpkg.com/@strudel/repl@${STRUDEL_REPL_VERSION}/dist/index.js`;

/**
 * GM soundfont names, straight out of the bundle's registration map. Entries
 * look like `gm_reed_organ:["0200_JCLive_sf2_file", ...]`, so anchoring on the
 * four-digit sf2 filename avoids matching prose or doc examples.
 */
async function fetchGmNames() {
  const res = await fetch(REPL_BUNDLE);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${REPL_BUNDLE}`);
  const source = await res.text();
  const names = new Set();
  for (const [, name] of source.matchAll(/\b(gm_[a-z0-9_]+)\s*:\s*\[\s*"\d{4}_/g)) {
    names.add(name);
  }
  if (names.size < 100) {
    throw new Error(`only ${names.size} gm_* names found in ${REPL_BUNDLE} — did the bundle shape change?`);
  }
  console.error(`  ${String(names.size).padStart(4)} gm names ${REPL_BUNDLE}`);
  return [...names].sort();
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

/** processSampleMap ignores keys starting with "_" (they are manifest metadata). */
const soundKeys = (manifest) => Object.keys(manifest).filter((k) => !k.startsWith("_"));

async function main() {
  const samples = new Set();
  const drumBanks = new Set();

  for (const url of SAMPLE_MANIFESTS) {
    const manifest = await fetchJson(url);
    const keys = soundKeys(manifest);
    for (const key of keys) samples.add(key);
    if (url.includes("tidal-drum-machines")) {
      // keys look like "RolandTR808_bd" — the bank is everything before the first "_"
      for (const key of keys) {
        const i = key.indexOf("_");
        if (i > 0) drumBanks.add(key.slice(0, i));
      }
    }
    console.error(`  ${String(keys.length).padStart(4)} sounds  ${url}`);
  }

  const aliases = await fetchJson(BANK_ALIASES);
  for (const [full, alias] of Object.entries(aliases)) {
    drumBanks.add(full);
    drumBanks.add(alias);
  }
  console.error(`  ${String(Object.keys(aliases).length).padStart(4)} aliases ${BANK_ALIASES}`);

  const gm = await fetchGmNames();
  // One name per line, matching the fixture's existing shape.
  const gmJson = `[\n${gm.map((name) => JSON.stringify(name)).join(",\n")}\n]\n`;
  await writeFile(join(FIXTURES, "gm-sound-names.json"), gmJson);

  const fixture = {
    _comment:
      "Generated by scripts/sync-strudel-sounds.mjs — do not edit by hand. " +
      `Reflects prebake() in @strudel/repl@${STRUDEL_REPL_VERSION}.`,
    strudelReplVersion: STRUDEL_REPL_VERSION,
    sampleManifests: SAMPLE_MANIFESTS,
    bankAliases: BANK_ALIASES,
    samples: [...samples].sort(),
    drumBanks: [...drumBanks].sort(),
    gm: [...gm].sort(),
    synths: [...SYNTHS].sort(),
  };

  const out = join(SOUND_DATA, "strudel-sounds.json");
  await writeFile(out, `${JSON.stringify(fixture, null, 2)}\n`);
  console.error(
    `\nwrote ${out}\n  samples ${fixture.samples.length}` +
      `  drumBanks ${fixture.drumBanks.length}` +
      `  gm ${fixture.gm.length}` +
      `  synths ${fixture.synths.length}`,
  );
}

await main();
