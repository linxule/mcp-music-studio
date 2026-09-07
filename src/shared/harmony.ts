// =============================================================================
// analyze-harmony — pure music-theory helpers (no I/O, no DOM, no Node APIs)
//
// Shared by both transports (server.ts and worker/src/index.ts). Built on
// `tonal` (pure JS, no deps), plus a small key-detection scorer that tonal
// doesn't ship. Every entry point returns agent-actionable plain text and
// never throws — bad input becomes a helpful message.
//
// Output deliberately bridges both studio modes: an ABC chord-symbol spelling
// (for play-sheet-music) and the Strudel form (for play-live-pattern).
// =============================================================================

import { Chord, Key, Mode, Note, Progression, Scale } from "tonal";

export const HARMONY_TASKS = [
  "detect-chord",
  "detect-key",
  "suggest-progression",
  "scale-for-chord",
  "key-chords",
] as const;

export type HarmonyTask = (typeof HARMONY_TASKS)[number];

export interface AnalyzeHarmonyArgs {
  task: HarmonyTask;
  notes?: string[];
  chords?: string[];
  key?: string;
  romanNumerals?: string[];
}

// -----------------------------------------------------------------------------
// Symbol spelling
// -----------------------------------------------------------------------------

/**
 * Chord suffixes preferred when rendering a detected chord back to a symbol.
 * tonal's canonical symbol for a plain major triad is "CM" and for a major
 * seventh "CM7"; musicians (and ABC chord symbols) write "C" and "Cmaj7".
 * First alias in this list that the chord type actually has wins.
 */
const PREFERRED_ALIASES = [
  "",
  "m",
  "maj7",
  "7",
  "m7",
  "m7b5",
  "dim7",
  "dim",
  "aug",
  "6",
  "m6",
  "sus4",
  "sus2",
  "9",
  "maj9",
  "m9",
  "add9",
  "11",
  "13",
  "7b9",
  "7#9",
  "7#11",
  "7b13",
  "mMaj7",
];

/** Render a tonal chord name in the spelling ABC and lead sheets use. */
export function friendlyChordSymbol(name: string): string {
  const chord = Chord.get(name);
  if (chord.empty || !chord.tonic) return name;
  const alias =
    PREFERRED_ALIASES.find((a) => chord.aliases.includes(a)) ?? chord.aliases[0] ?? "";
  const bass = chord.bass && chord.bass !== chord.tonic ? `/${chord.bass}` : "";
  return `${chord.tonic}${alias}${bass}`;
}

// -----------------------------------------------------------------------------
// Strudel voicing symbols — the `ireal` dictionary
// -----------------------------------------------------------------------------
//
// `chord("Cmaj7").voicing()` prints NOTHING. Verified against the published
// @strudel/tonal@1.2.6 source:
//
//   voicings.mjs  registerVoicings('ireal', simple)  and  defaultDict = 'ireal'
//   tonleiter.mjs renderVoicing() → tokenizeChord(chord) splits the symbol into
//                 [root, suffix, bass] and then does `dictionary[suffix]` — an
//                 EXACT key lookup. A miss throws, `voicing` catches it, logs
//                 `[voicing]: unknown chord` and returns `silence`.
//
// So the only spellings that sound are the keys of `ireal.mjs`'s `simple` table
// plus the aliases voicings.mjs derives from them at import time. `maj7` is not
// one of them; `^7` and `M7` are. Everything this module prints inside a
// `chord("…")` goes through `irealChordSymbol` first.

/** Keys of the `simple` table in @strudel/tonal@1.2.6's ireal.mjs, verbatim. */
const IREAL_CANONICAL_SUFFIXES = [
  "2", "5", "6", "7", "9", "11", "13", "69", "add9", "+", "o", "h", "sus", "^", "-",
  "^7", "-7", "7sus", "h7", "o7", "^9", "^13", "^7#11", "^9#11", "^7#5", "-6", "-69",
  "-^7", "-^9", "-9", "-add9", "-11", "-7b5", "h9", "-b6", "-#5", "7b9", "7#9", "7#11",
  "7b5", "7#5", "9#11", "9b5", "9#5", "7b13", "7#9#5", "7#9b5", "7#9#11", "7b9#11",
  "7b9b5", "7b9#5", "7b9#9", "7b9b13", "7alt", "13#11", "13b9", "13#9", "7b9sus",
  "7susadd3", "9sus", "13sus", "7b13sus",
] as const;

/**
 * Every suffix `voicing()` accepts — the canonical keys plus the aliases
 * voicings.mjs adds, reproduced with the same substitutions it uses
 * (`^` → no symbol for the bare major triad, `-` → `m`, `^` → `M`, `+` → `aug`;
 * String.replace only touches the FIRST occurrence, exactly as upstream).
 */
export const IREAL_VOICING_SUFFIXES: ReadonlySet<string> = (() => {
  const set = new Set<string>(IREAL_CANONICAL_SUFFIXES);
  set.add(""); // voicingAlias('^', '') — a bare "C" is a major triad
  for (const suffix of IREAL_CANONICAL_SUFFIXES) {
    if (suffix.includes("-")) set.add(suffix.replace("-", "m"));
    if (suffix.includes("^")) set.add(suffix.replace("^", "M"));
    if (suffix.includes("+")) set.add(suffix.replace("+", "aug"));
  }
  return set;
})();

/**
 * Which accepted spelling to print when a chord has several. Readability only —
 * every entry is in `IREAL_VOICING_SUFFIXES` (a test asserts it).
 */
const IREAL_PREFERRED_SUFFIXES = [
  "", "m", "^7", "m7", "7", "6", "m6", "69", "^9", "m9", "9", "sus", "add9", "2",
  "m7b5", "o7", "o", "aug", "7sus", "9sus", "13sus", "m11", "11", "13", "^13",
  "7b9", "7#9", "7#11", "7b5", "7#5", "7b13", "7alt", "m^7", "5", "h7", "h",
];

/**
 * tonal alias → ireal suffix, for the handful of chords whose tonal aliases and
 * the ireal keys never overlap. Checked after the alias search.
 */
const IREAL_SUFFIX_FALLBACKS: Record<string, string> = {
  alt7: "7alt", // tonal's "Calt7" (1P 3M 7m 9m) — ireal spells the altered dominant "7alt"
  sus2: "2", // ireal's "2" is the sus2 voicing (1P 5P 8P 9M — no third)
  "-^7": "m^7", // both work; "m^7" reads better than the iReal dash
  "m/ma7": "m^7",
  maj7: "^7",
  dim: "o",
  dim7: "o7",
};

/**
 * Strip the typographic accidentals abcjs and lead-sheet fonts use, so a chord
 * symbol is plain ASCII before anything tries to parse it.
 * `B♭7` → `Bb7`, `F♯m7` → `F#m7`, `C△` → `Cmaj7`.
 */
export function asciiChordSymbol(name: string): string {
  return String(name)
    .replace(/♭/g, "b")
    .replace(/♯/g, "#")
    .replace(/♮/g, "")
    .replace(/\u{1D12A}/gu, "##")
    .replace(/\u{1D12B}/gu, "bb")
    .replace(/[Δ△]/g, "maj7")
    // "Cø7" and "Cø" are the same chord — don't let the 7 survive twice.
    .replace(/[øØ]7?/g, "m7b5")
    .replace(/°/g, "dim")
    .replace(/\s+/g, "");
}

/** Is this a chord symbol at all (as opposed to an annotation like "rit.")? */
export function isChordSymbol(name: string): boolean {
  const chord = Chord.get(asciiChordSymbol(name));
  return !chord.empty && !!chord.tonic;
}

/**
 * Respell a chord symbol so Strudel's default `ireal` voicing dictionary can
 * find it — `Cmaj7` → `C^7`, `C6/9` → `C69`, `Bdim` → `Bo`, `Csus4` → `Csus`.
 * Returns null when no accepted spelling exists; the caller should then say so
 * rather than emit a symbol that renders silence.
 */
export function irealChordSymbol(symbol: string): string | null {
  const chord = Chord.get(asciiChordSymbol(symbol));
  if (chord.empty || !chord.tonic) return null;

  const aliases = chord.aliases ?? [];
  let suffix = IREAL_PREFERRED_SUFFIXES.find(
    (a) => aliases.includes(a) && IREAL_VOICING_SUFFIXES.has(a),
  );
  if (suffix === undefined) {
    for (const alias of aliases) {
      const mapped = IREAL_SUFFIX_FALLBACKS[alias];
      if (mapped && IREAL_VOICING_SUFFIXES.has(mapped)) {
        suffix = mapped;
        break;
      }
    }
  }
  suffix ??= aliases.find((a) => IREAL_VOICING_SUFFIXES.has(a));
  if (suffix === undefined) return null;

  // renderVoicing ignores the bass note, but tokenizeChord accepts it, so a
  // slash chord still voices — keep it for the reader.
  const bass = chord.bass && chord.bass !== chord.tonic ? `/${chord.bass}` : "";
  return `${chord.tonic}${suffix}${bass}`;
}

/**
 * Render a list of chord symbols for a `chord("…")` mini-notation string.
 * Anything without an ireal spelling becomes `~` (a silent cycle) rather than a
 * symbol that would make Strudel log "unknown chord" and drop the layer.
 */
export function irealChordList(symbols: readonly string[]): string {
  return symbols.map((s) => irealChordSymbol(s) ?? "~").join(" ");
}

/** Lowercase Strudel note token: `C#4` → `c#4`, `Bb3` → `bb3`. */
function strudelNote(note: string, defaultOctave = 4): string {
  const parsed = Note.get(note);
  if (parsed.empty) return note.toLowerCase();
  const octave = parsed.oct ?? defaultOctave;
  return `${parsed.pc.toLowerCase()}${octave}`;
}

/**
 * Spell a chord's pitch classes as an ascending Strudel voicing, bumping the
 * octave whenever the next chord tone would otherwise fall below the previous
 * one (so Dm7 is `d4 f4 a4 c5`, not `d4 f4 a4 c4`).
 */
function ascendingStrudelNotes(pitchClasses: readonly string[], startOctave = 4): string[] {
  const out: string[] = [];
  let octave = startOctave;
  let previous = -1;
  for (const pc of pitchClasses) {
    const chroma = Note.chroma(pc);
    if (typeof chroma !== "number") continue;
    if (previous >= 0 && chroma <= previous) octave += 1;
    previous = chroma;
    out.push(`${pc.toLowerCase()}${octave}`);
  }
  return out;
}

// -----------------------------------------------------------------------------
// Key detection (tonal has none — pitch-class overlap scoring over 24 keys)
// -----------------------------------------------------------------------------

/**
 * Candidate tonics, spelled the way each mode is conventionally written — Db
 * major is real, "Db minor" (8 flats) is not, so the minor row uses C#/D#/G#.
 */
const MAJOR_TONICS = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MINOR_TONICS = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"];

export interface KeyScore {
  /** Display name, e.g. "C major" / "A minor". */
  name: string;
  tonic: string;
  mode: "major" | "minor";
  /** Weighted match score (higher is better). */
  score: number;
  /** How many of the distinct input pitch classes are in the key's scale. */
  matched: number;
  /** How many distinct pitch classes were considered. */
  total: number;
  scale: string[];
}

/** Chroma set (0–11) for a scale, ignoring anything tonal can't parse. */
function chromaSet(notes: readonly string[]): Set<number> {
  const set = new Set<number>();
  for (const n of notes) {
    const c = Note.chroma(n);
    if (typeof c === "number") set.add(c);
  }
  return set;
}

/**
 * Score all 24 major/minor keys by how well a bag of pitch classes fits.
 *
 * Weighting (deliberately simple and testable):
 *   +3 per occurrence of a pitch class that is in the key's scale
 *   -2 per occurrence of one that is not
 *   +2 bonus if the key's tonic appears at all
 *   +1 bonus if the key's dominant appears at all
 * Minor keys also accept the raised 7th (harmonic minor) as in-scale, which is
 * what makes "E7 in A minor" score correctly.
 */
export function scoreKeys(pitchClasses: readonly string[]): KeyScore[] {
  const chromas: number[] = [];
  for (const pc of pitchClasses) {
    const c = Note.chroma(pc);
    if (typeof c === "number") chromas.push(c);
  }
  const distinct = new Set(chromas);
  const results: KeyScore[] = [];

  for (const mode of ["major", "minor"] as const) {
    for (const tonic of mode === "major" ? MAJOR_TONICS : MINOR_TONICS) {
      const scale =
        mode === "major"
          ? Key.majorKey(tonic).scale.slice()
          : Key.minorKey(tonic).natural.scale.slice();
      if (scale.length === 0) continue;

      const inScale = chromaSet(scale);
      if (mode === "minor") {
        // harmonic-minor leading tone counts as diatonic for detection
        const raised = Note.chroma(Key.minorKey(tonic).harmonic.scale[6] ?? "");
        if (typeof raised === "number") inScale.add(raised);
      }

      let score = 0;
      let matched = 0;
      for (const c of chromas) score += inScale.has(c) ? 3 : -2;
      for (const c of distinct) if (inScale.has(c)) matched += 1;

      const tonicChroma = Note.chroma(tonic);
      const dominantChroma = Note.chroma(scale[4] ?? "");
      if (typeof tonicChroma === "number" && distinct.has(tonicChroma)) score += 2;
      if (typeof dominantChroma === "number" && distinct.has(dominantChroma)) score += 1;

      results.push({
        name: `${tonic} ${mode}`,
        tonic,
        mode,
        score,
        matched,
        total: distinct.size,
        scale,
      });
    }
  }

  // Stable, deterministic ordering: score, then match count, then major first.
  results.sort(
    (a, b) =>
      b.score - a.score ||
      b.matched - a.matched ||
      (a.mode === b.mode ? 0 : a.mode === "major" ? -1 : 1) ||
      a.name.localeCompare(b.name),
  );
  return results;
}

/** Pitch classes contributed by a list of chord symbols (unparseable ones skipped). */
function pitchClassesFromChords(chords: readonly string[]): {
  pcs: string[];
  unknown: string[];
} {
  const pcs: string[] = [];
  const unknown: string[] = [];
  for (const symbol of chords) {
    const chord = Chord.get(symbol);
    if (chord.empty || chord.notes.length === 0) {
      unknown.push(symbol);
      continue;
    }
    // Root twice: a chord's root carries more key information than its color tones.
    pcs.push(chord.notes[0]!, ...chord.notes);
  }
  return { pcs, unknown };
}

// -----------------------------------------------------------------------------
// Key parsing ("C", "A minor", "F# major", "Bbm")
// -----------------------------------------------------------------------------

/**
 * The modes this module can build material for. `major` and `minor` are the
 * ionian and aeolian rows under the names musicians (and ABC's K: field) use.
 */
export const KEY_MODES = [
  "major",
  "minor",
  "dorian",
  "phrygian",
  "lydian",
  "mixolydian",
  "locrian",
] as const;

export type KeyMode = (typeof KEY_MODES)[number];

/**
 * Accepted spellings of a mode. The suffix is matched EXACTLY (case-insensitively,
 * except for the bare `M`/`m` pair, where case is the whole distinction) — the old
 * `startsWith("m")` test read "Cmonsoon" as C minor and "D dorian" as D major,
 * because anything that wasn't recognisably minor silently became major.
 */
const KEY_MODE_ALIASES: Record<string, KeyMode> = {
  "": "major",
  major: "major",
  maj: "major",
  ionian: "major",
  minor: "minor",
  min: "minor",
  m: "minor",
  aeolian: "minor",
  "natural minor": "minor",
  dorian: "dorian",
  phrygian: "phrygian",
  lydian: "lydian",
  mixolydian: "mixolydian",
  locrian: "locrian",
};

/** ABC's K: field spells the modes with a three-letter suffix. */
const ABC_MODE_SUFFIX: Record<KeyMode, string> = {
  major: "",
  minor: "m",
  dorian: "dor",
  phrygian: "phr",
  lydian: "lyd",
  mixolydian: "mix",
  locrian: "loc",
};

export const KEY_HELP =
  'Write a key as a tonic plus an optional mode: "C", "A minor", "F# major", "D dorian". ' +
  "Modes: major (ionian), minor (aeolian), dorian, phrygian, lydian, mixolydian, locrian " +
  "— plus the shorthands m, min, maj, M.";

export interface ParsedKey {
  tonic: string;
  mode: KeyMode;
  name: string;
}

export function parseKeyName(input: string): ParsedKey | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;

  const match = raw.match(/^([A-Ga-g](?:#{1,2}|b{1,2}|s)?)\s*(.*)$/);
  if (!match) return null;

  const tonicRaw = match[1]!.replace(/s$/, "#");
  const tonic = tonicRaw[0]!.toUpperCase() + tonicRaw.slice(1);
  if (Note.get(tonic).empty) return null;

  const rest = match[2]!.trim();
  // `CM` is C major and `Cm` is C minor — the one place case carries meaning.
  if (rest === "M") return { tonic, mode: "major", name: `${tonic} major` };

  const mode = KEY_MODE_ALIASES[rest.toLowerCase().replace(/\s+/g, " ")];
  if (!mode) return null;
  return { tonic, mode, name: `${tonic} ${mode}` };
}

// -----------------------------------------------------------------------------
// Diatonic helpers
// -----------------------------------------------------------------------------

const ROMAN_DEGREES = ["I", "II", "III", "IV", "V", "VI", "VII"];

/** The seven modes in rotation order, so a mode's chord scales are a slice of it. */
const MODE_ROTATION: KeyMode[] = [
  "major",
  "dorian",
  "phrygian",
  "lydian",
  "mixolydian",
  "minor",
  "locrian",
];

/** tonal's mode name for a `KeyMode` (it spells the two familiar ones differently). */
const TONAL_MODE_NAME: Record<KeyMode, string> = {
  major: "ionian",
  minor: "aeolian",
  dorian: "dorian",
  phrygian: "phrygian",
  lydian: "lydian",
  mixolydian: "mixolydian",
  locrian: "locrian",
};

/**
 * Roman numerals read off the triads themselves: lowercase for a minor third,
 * `°` for a diminished fifth, `+` for an augmented one. Reproduces the familiar
 * `I ii iii IV V vi vii°` / `i ii° III iv v VI VII` rows exactly, and gets the
 * modal rows right for free.
 */
function romansFromTriads(triads: readonly string[]): string[] {
  return triads.map((symbol, i) => {
    const chord = Chord.get(symbol);
    const minor = chord.quality === "Minor" || chord.quality === "Diminished";
    const base = minor ? ROMAN_DEGREES[i]!.toLowerCase() : ROMAN_DEGREES[i]!;
    if (chord.quality === "Diminished") return `${base}°`;
    if (chord.quality === "Augmented") return `${base}+`;
    return base;
  });
}

export interface KeyMaterial {
  name: string;
  scale: string[];
  /** Diatonic seventh chords, in the studio's preferred spelling. */
  sevenths: string[];
  /** Diatonic triads, in the studio's preferred spelling. */
  triads: string[];
  romans: string[];
  chordScales: string[];
  /** The suffix ABC's K: field uses for this mode ("", "m", "dor", …). */
  abcModeSuffix: string;
  /** Scale name for Strudel's `.scale("C:major")` — always a real tonal name. */
  strudelScale: string;
}

export function keyMaterial(parsed: ParsedKey): KeyMaterial | null {
  const mode: KeyMode = parsed.mode;
  const tonal = TONAL_MODE_NAME[mode];
  if (!tonal) return null;

  const scale = Mode.notes(tonal, parsed.tonic);
  if (scale.length !== 7 || scale.some((n) => Note.get(n).empty)) return null;

  const triads = Mode.triads(tonal, parsed.tonic).map(friendlyChordSymbol);
  const sevenths = Mode.seventhChords(tonal, parsed.tonic).map(friendlyChordSymbol);

  // Degree i of a mode takes the mode that sits i steps further round the cycle.
  const start = MODE_ROTATION.indexOf(mode);
  const chordScales = scale.map(
    (note, i) => `${note} ${MODE_ROTATION[(start + i) % 7]}`,
  );

  return {
    name: parsed.name,
    scale,
    sevenths,
    triads,
    romans: romansFromTriads(triads),
    chordScales,
    abcModeSuffix: ABC_MODE_SUFFIX[mode],
    strudelScale: mode,
  };
}

/**
 * tonal reads roman numerals literally: `ii7` is "degree 2, chord type 7" → D7,
 * not Dm7. Musicians mean the lowercase numeral to carry the minor quality, so
 * insert an explicit `m` when the suffix doesn't already state a quality.
 */
export function normalizeRomanNumeral(numeral: string): string {
  const m = numeral.trim().match(/^([b#]*)([ivIV]+)(.*)$/);
  if (!m) return numeral.trim();
  const [, accidental = "", roman = "", suffix = ""] = m;
  const isLower = roman === roman.toLowerCase();
  const statesQuality = /^(m|min|dim|o|0|ø|°|\+|aug|maj|M|sus)/.test(suffix);
  if (isLower && !statesQuality) return `${accidental}${roman}m${suffix}`;
  return `${accidental}${roman}${suffix}`;
}

const CANNED_PROGRESSIONS: { label: string; major: string[]; minor: string[] }[] = [
  { label: "ii-V-I (jazz cadence)", major: ["iim7", "V7", "Imaj7"], minor: ["iim7b5", "V7", "im7"] },
  { label: "I-V-vi-IV (pop)", major: ["I", "V", "vim", "IV"], minor: ["i", "bVI", "bIII", "bVII"] },
  { label: "I-vi-ii-V (turnaround)", major: ["I", "vim", "iim", "V"], minor: ["im", "bVI", "iim7b5", "V"] },
  { label: "12-bar blues (first 4)", major: ["I7", "IV7", "I7", "I7"], minor: ["im7", "ivm7", "im7", "im7"] },
];

// -----------------------------------------------------------------------------
// Chord scales
// -----------------------------------------------------------------------------
//
// Every scale name this module prints has to survive TWO round trips:
//
//   1. tonal — `Scale.get("C " + name)` must return notes, or the printed scale
//      degrades silently to the chord tones.
//   2. Strudel — `.scale("C:whole:tone")` is `name.replaceAll(":", " ")` handed
//      to Strudel's own (older) tonal copy, so the colon form must resolve there
//      too. `tests/harmony.test.ts` checks both against the pinned REPL bundle's
//      scale list (`tests/fixtures/strudel-scale-names.json`).
//
// So the names below are CANONICAL tonal names, never prose. The old table
// carried display labels ("diminished (whole-half)", "altered (super locrian)")
// and Strudel got them via `.replace(/ .*/, "")` — which truncated "whole tone"
// to "whole" (not a scale in any tonal version) and printed no notes at all for
// the two parenthesised names.

/** Canonical tonal scale names this module is allowed to emit. */
export const CHORD_SCALE_NAMES = [
  "locrian",
  "whole-half diminished",
  "whole tone",
  "altered",
  "lydian dominant",
  "mixolydian",
  "major",
  "minor",
  "melodic minor",
  "dorian",
] as const;

export type ChordScaleName = (typeof CHORD_SCALE_NAMES)[number];

/**
 * Strudel spells a multi-word scale with colons: `.scale("C:whole:tone")`, which
 * its `scale()` turns back into `"C whole tone"` for tonal.
 */
export function strudelScaleName(scale: string): string {
  return scale.trim().replace(/\s+/g, ":");
}

/**
 * Root-position intervals. A slash chord's `intervals` are measured from the
 * BASS (`C/G` is `5P 8P 10M` — no third in sight), so re-read the chord from its
 * first alias to get the quality back before matching on it.
 */
function rootIntervals(chord: ReturnType<typeof Chord.get>): string[] {
  if (!chord.bass || chord.bass === chord.tonic) return chord.intervals;
  const root = Chord.get(`${chord.tonic}${chord.aliases[0] ?? ""}`);
  return root.empty ? chord.intervals : root.intervals;
}

/**
 * Chord → chord scale, decided by what the chord actually CONTAINS.
 *
 * The old table matched prose against tonal's `type` string, which meant a
 * symbol whose prose tonal happened to spell differently fell through to a
 * broad `/dominant/` catch-all: `G7b9` is "dominant flat ninth", matched no
 * altered-dominant branch, and was answered with mixolydian — a scale
 * containing the natural 9 the chord explicitly flattens.
 */
function chordScaleFor(chordName: string): ChordScaleName {
  const chord = Chord.get(chordName);
  const intervals = new Set(rootIntervals(chord));
  const has = (...wanted: string[]) => wanted.every((i) => intervals.has(i));
  const any = (...wanted: string[]) => wanted.some((i) => intervals.has(i));

  const third = intervals.has("3M") ? "major" : intervals.has("3m") ? "minor" : null;
  const dominant = third === "major" && intervals.has("7m");

  // Diminished family, innermost first: dim7 (bb7) before m7b5 before the triad.
  if (has("3m", "5d")) {
    // tonal spells the dim7's seventh "7d" (a doubly-flattened seventh).
    if (any("7d", "6M") && !intervals.has("7m")) return "whole-half diminished";
    return "locrian";
  }
  // Altered dominant: any alteration of the 5th or 9th over a dominant 7th.
  if (dominant && any("5A", "5d", "9m", "9A", "13m", "6m")) return "altered";
  // Lydian dominant is the one #11 that isn't "altered".
  if (dominant && any("11A", "4A")) return "lydian dominant";
  if (dominant) return "mixolydian";
  // Augmented triads and maj7#5.
  if (third === "major" && intervals.has("5A")) return "whole tone";
  if (third === "major") return "major";
  // A minor triad with a major 7th is melodic minor, not dorian.
  if (third === "minor" && intervals.has("7M")) return "melodic minor";
  if (third === "minor") return "dorian";
  // No third at all: sus chords (and power chords) read as dominant.
  if (any("4P", "2M", "5P")) return "mixolydian";
  return chord.quality === "Minor" ? "dorian" : "major";
}

// -----------------------------------------------------------------------------
// Task handlers
// -----------------------------------------------------------------------------

/**
 * Of the keys a chord fits, choose the one a musician would name as "home":
 * prefer major keys, and within them the readings where the chord is I, then V,
 * then ii (so Dm7 reads as ii of C major, not vi of F major).
 */
const DEGREE_PRIORITY = [0, 2, 5, 3, 1, 4, 6]; // index = scale degree, value = rank

function pickHomeKey(
  fits: readonly KeyScore[],
  chordRoot: string,
): { material: KeyMaterial; degree: number } | null {
  const rootChroma = Note.chroma(chordRoot);
  if (typeof rootChroma !== "number") return null;

  let best: { material: KeyMaterial; degree: number; rank: number } | null = null;
  for (const fit of fits) {
    const material = keyMaterial({ tonic: fit.tonic, mode: fit.mode, name: fit.name });
    if (!material) continue;
    const degree = material.scale.findIndex((n) => Note.chroma(n) === rootChroma);
    if (degree < 0) continue;
    const rank = (fit.mode === "major" ? 0 : 20) + DEGREE_PRIORITY[degree]!;
    if (!best || rank < best.rank) best = { material, degree, rank };
  }
  return best ? { material: best.material, degree: best.degree } : null;
}

const HELP =
  "Tasks: detect-chord (needs notes), detect-key (needs notes or chords), " +
  "suggest-progression (needs key, optional romanNumerals), " +
  "scale-for-chord (needs chords), key-chords (needs key).";

function nonEmpty(list: string[] | undefined): string[] {
  return (list ?? []).map((s) => String(s).trim()).filter((s) => s.length > 0);
}

function detectChord(args: AnalyzeHarmonyArgs): string {
  const notes = nonEmpty(args.notes);
  if (notes.length < 2) {
    return `detect-chord needs at least 2 notes, e.g. notes: ["c4","e4","g4","b4"]. ${HELP}`;
  }

  const parsed = notes.filter((n) => !Note.get(n).empty);
  const bad = notes.filter((n) => Note.get(n).empty);
  if (parsed.length < 2) {
    return (
      `Could not read those note names: ${notes.join(", ")}. ` +
      'Use scientific pitch names like "c4", "eb4", "f#5" (or bare pitch classes "C", "Eb").'
    );
  }

  const detected = Chord.detect(parsed);
  const noteList = parsed.map((n) => Note.get(n).pc).join(" ");
  const lines: string[] = [];

  if (detected.length === 0) {
    const keys = scoreKeys(parsed.map((n) => Note.get(n).pc));
    lines.push(
      `No standard chord matches ${noteList}. It may be a fragment, a cluster, or an incomplete voicing.`,
    );
    lines.push(`Closest keys for those notes: ${keys.slice(0, 3).map((k) => k.name).join(", ")}.`);
    // `note("c4 e4 g4")` plays a SEQUENCE in Strudel; a chord is one bracketed
    // step with the notes comma-separated.
    lines.push(`Strudel: note("[${parsed.map((n) => strudelNote(n)).join(",")}]")`);
    if (bad.length) lines.push(`Ignored unreadable notes: ${bad.join(", ")}.`);
    return lines.join("\n");
  }

  const best = friendlyChordSymbol(detected[0]!);
  const chord = Chord.get(detected[0]!);
  lines.push(`${best} (${chord.name || chord.type}). Notes: ${chord.notes.join(" ")}.`);
  if (detected.length > 1) {
    lines.push(
      `Other readings: ${detected.slice(1, 4).map(friendlyChordSymbol).join(", ")}.`,
    );
  }

  // Keys that contain every chord tone diatonically.
  const fits = scoreKeys(chord.notes).filter((k) => k.matched === k.total);
  if (fits.length > 0) {
    lines.push(`Fits keys: ${fits.slice(0, 3).map((k) => k.name).join(", ")}.`);

    const home = pickHomeKey(fits, chord.tonic ?? "");
    if (home) {
      const next = [3, 4, 5].map((step) => home.material.sevenths[(home.degree + step) % 7]!);
      lines.push(`Try next (in ${home.material.name}): ${next.join(", ")}.`);
    }
  }

  lines.push(`ABC chord symbol: "${best}"`);
  // ABC and Strudel spell the same chord differently: ABC wants "Cmaj7", the
  // ireal voicing dictionary only answers to "C^7".
  const voiced = irealChordSymbol(best);
  const spelled = `note("[${ascendingStrudelNotes(chord.notes).join(",")}]")`;
  lines.push(
    voiced
      ? `Strudel: chord("${voiced}").voicing()  —  or spelled out: ${spelled}`
      : `Strudel: ${spelled}  (no ireal voicing for "${best}" — spell it out)`,
  );
  if (bad.length) lines.push(`Ignored unreadable notes: ${bad.join(", ")}.`);
  return lines.join("\n");
}

function detectKey(args: AnalyzeHarmonyArgs): string {
  const notes = nonEmpty(args.notes);
  const chords = nonEmpty(args.chords);
  if (notes.length === 0 && chords.length === 0) {
    return `detect-key needs notes or chords, e.g. chords: ["Dm7","G7","Cmaj7"]. ${HELP}`;
  }

  const pcs: string[] = [];
  const unreadable: string[] = [];
  for (const n of notes) {
    const parsed = Note.get(n);
    if (parsed.empty) unreadable.push(n);
    else pcs.push(parsed.pc);
  }
  const fromChords = pitchClassesFromChords(chords);
  pcs.push(...fromChords.pcs);
  unreadable.push(...fromChords.unknown);

  if (pcs.length === 0) {
    return (
      `Could not read any of: ${[...notes, ...chords].join(", ")}. ` +
      'Notes look like "c4"/"Eb"; chords look like "Dm7"/"G7"/"Cmaj7".'
    );
  }

  const ranked = scoreKeys(pcs);
  const best = ranked[0]!;
  const material = keyMaterial({ tonic: best.tonic, mode: best.mode, name: best.name });
  const lines: string[] = [];

  lines.push(
    `Best key: ${best.name} — ${best.matched}/${best.total} distinct pitch classes are diatonic (score ${best.score}).`,
  );
  lines.push(
    `Runners-up: ${ranked
      .slice(1, 4)
      .map((k) => `${k.name} (${k.matched}/${k.total})`)
      .join(", ")}.`,
  );
  lines.push(`Scale: ${best.scale.join(" ")}`);
  if (material) {
    lines.push(`Diatonic sevenths: ${material.sevenths.join(" ")}`);
  }
  lines.push(`ABC key field: K:${best.tonic}${best.mode === "minor" ? "m" : ""}`);
  lines.push(`Strudel: n("0 2 4").scale("${best.tonic}:${best.mode}")`);
  if (unreadable.length) lines.push(`Ignored unreadable input: ${unreadable.join(", ")}.`);
  return lines.join("\n");
}

function suggestProgression(args: AnalyzeHarmonyArgs): string {
  const keyInput = (args.key ?? "").trim();
  if (!keyInput) {
    return `suggest-progression needs a key, e.g. key: "C" or key: "A minor". ${HELP}`;
  }
  const parsed = parseKeyName(keyInput);
  const material = parsed ? keyMaterial(parsed) : null;
  if (!parsed || !material) {
    return `Could not read the key "${keyInput}". ${KEY_HELP}`;
  }

  const numerals = nonEmpty(args.romanNumerals);
  const lines: string[] = [`Key: ${material.name}`, `Scale: ${material.scale.join(" ")}`];

  if (numerals.length > 0) {
    const normalized = numerals.map(normalizeRomanNumeral);
    const chords = Progression.fromRomanNumerals(parsed.tonic, normalized).map((c, i) =>
      c ? friendlyChordSymbol(c) : `?${numerals[i]}`,
    );
    const unresolved = chords.filter((c) => c.startsWith("?"));
    lines.push(`${numerals.join(" - ")}  →  ${chords.join(" ")}`);
    if (unresolved.length) {
      lines.push(
        `Could not read: ${unresolved.map((c) => c.slice(1)).join(", ")}. Use roman numerals like I, iim7, V7, bVII.`,
      );
    }
    lines.push(`ABC: ${chords.map((c) => `"${c}"`).join(" ")}`);
    lines.push(`Strudel: chord("<${irealChordList(chords)}>").voicing().s("gm_epiano1")`);
    return lines.join("\n");
  }

  lines.push("");
  // The canned sets are written for the two tonal modes; a modal key borrows the
  // set whose third matches its own.
  const minorish = parsed.mode !== "major" && parsed.mode !== "lydian" &&
    parsed.mode !== "mixolydian";
  for (const preset of CANNED_PROGRESSIONS) {
    const numeralSet = minorish ? preset.minor : preset.major;
    const chords = Progression.fromRomanNumerals(
      parsed.tonic,
      numeralSet.map(normalizeRomanNumeral),
    ).map(friendlyChordSymbol);
    lines.push(`${preset.label}: ${chords.join(" ")}`);
    lines.push(`  Strudel: chord("<${irealChordList(chords)}>").voicing().s("gm_epiano1")`);
  }
  lines.push("");
  lines.push(`Diatonic sevenths: ${material.sevenths.join(" ")}`);
  lines.push(
    "Pass romanNumerals (e.g. [\"iim7\",\"V7\",\"Imaj7\"]) to render your own progression in this key.",
  );
  return lines.join("\n");
}

function scaleForChord(args: AnalyzeHarmonyArgs): string {
  const chords = nonEmpty(args.chords);
  if (chords.length === 0) {
    return `scale-for-chord needs chords, e.g. chords: ["Dm7","G7","Cmaj7"]. ${HELP}`;
  }

  const lines: string[] = [];
  const unknown: string[] = [];
  for (const symbol of chords) {
    const chord = Chord.get(symbol);
    if (chord.empty || !chord.tonic) {
      unknown.push(symbol);
      continue;
    }
    const scaleName = chordScaleFor(symbol);
    const scale = Scale.get(`${chord.tonic} ${scaleName}`);
    const notes = scale.notes.length > 0 ? scale.notes : chord.notes;
    lines.push(
      `${friendlyChordSymbol(symbol)} (${chord.notes.join(" ")}) → ${chord.tonic} ${scaleName}: ${notes.join(" ")}`,
    );
    lines.push(
      `  Strudel: n("0 1 2 3 4 5 6").scale("${chord.tonic}:${strudelScaleName(scaleName)}")`,
    );
  }

  if (lines.length === 0) {
    return `Could not read any of those chord symbols: ${chords.join(", ")}. Try "Dm7", "G7", "Cmaj7".`;
  }
  if (unknown.length) lines.push(`Ignored unreadable chords: ${unknown.join(", ")}.`);

  const detected = detectKey({ task: "detect-key", chords });
  const bestLine = detected.split("\n")[0];
  if (bestLine?.startsWith("Best key")) lines.push(bestLine);
  return lines.join("\n");
}

function keyChords(args: AnalyzeHarmonyArgs): string {
  const keyInput = (args.key ?? "").trim();
  if (!keyInput) {
    return `key-chords needs a key, e.g. key: "C" or key: "A minor". ${HELP}`;
  }
  const parsed = parseKeyName(keyInput);
  const material = parsed ? keyMaterial(parsed) : null;
  if (!parsed || !material) {
    return `Could not read the key "${keyInput}". ${KEY_HELP}`;
  }

  const rows = material.romans.map(
    (roman, i) =>
      `  ${roman.padEnd(5)} ${material.triads[i]!.padEnd(8)} ${material.sevenths[i]!.padEnd(9)} ${material.chordScales[i] ?? ""}`,
  );

  return [
    `Key: ${material.name}`,
    `Scale: ${material.scale.join(" ")}`,
    "  deg   triad    seventh   chord scale",
    ...rows,
    `ABC key field: K:${parsed.tonic}${material.abcModeSuffix}`,
    `ABC chord symbols: ${material.sevenths.map((c) => `"${c}"`).join(" ")}`,
    `Strudel: chord("<${irealChordList(material.sevenths.slice(0, 4))}>").voicing().s("gm_epiano1")`,
    `Strudel scale: n("0 1 2 3 4 5 6").scale("${parsed.tonic}:${strudelScaleName(material.strudelScale)}")`,
  ].join("\n");
}

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

/**
 * Analyze harmony. Always returns text — unknown tasks, missing arguments, and
 * garbage note/chord names all produce a helpful message rather than throwing.
 */
export function analyzeHarmony(args: AnalyzeHarmonyArgs): string {
  try {
    switch (args?.task) {
      case "detect-chord":
        return detectChord(args);
      case "detect-key":
        return detectKey(args);
      case "suggest-progression":
        return suggestProgression(args);
      case "scale-for-chord":
        return scaleForChord(args);
      case "key-chords":
        return keyChords(args);
      default:
        return `Unknown task "${String(args?.task)}". ${HELP}`;
    }
  } catch (err) {
    return `Could not analyze that input (${(err as Error).message}). ${HELP}`;
  }
}
