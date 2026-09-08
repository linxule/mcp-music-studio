export const DEFAULT_INSTRUMENT = "Acoustic Grand Piano";
export const DEFAULT_STYLE = "";

// =============================================================================
// General MIDI instruments
// =============================================================================
//
// All 128 GM melodic programs. This used to be a 30-name shortlist while the
// tool description called it "the full list" and get-music-guide's 'instruments'
// topic printed the whole GM table — so `instrument: "Banjo"` matched nothing
// and silently played a grand piano. The `%%MIDI program N` escape hatch always
// covered every program; only the friendly-name lookup was short.
//
// Names are the GM spellings, EXCEPT where an older key here or the guide
// already spells one differently (`Electric Piano` for 4, `String Ensemble` for
// 48, `Drawbar Organ` for 16 which the guide calls "Hammond Organ"). Those older
// spellings stay canonical so existing tool calls and the widget's saved
// selection keep working; the GM spelling is reachable through INSTRUMENT_ALIASES.
// The Lead/Pad families use the descriptor-first spelling the guide uses
// ("Square Lead", not "Lead 1 (square)").
export const INSTRUMENTS: Record<string, number> = {
  // Piano (0-7)
  "Acoustic Grand Piano": 0,
  "Bright Acoustic Piano": 1,
  "Electric Grand Piano": 2,
  "Honky-tonk Piano": 3,
  "Electric Piano": 4,
  "Electric Piano 2": 5,
  "Harpsichord": 6,
  "Clavinet": 7,
  // Chromatic percussion (8-15)
  "Celesta": 8,
  "Glockenspiel": 9,
  "Music Box": 10,
  "Vibraphone": 11,
  "Marimba": 12,
  "Xylophone": 13,
  "Tubular Bells": 14,
  "Dulcimer": 15,
  // Organ (16-23)
  "Drawbar Organ": 16,
  "Percussive Organ": 17,
  "Rock Organ": 18,
  "Church Organ": 19,
  "Reed Organ": 20,
  "Accordion": 21,
  "Harmonica": 22,
  "Tango Accordion": 23,
  // Guitar (24-31)
  "Acoustic Guitar (Nylon)": 24,
  "Acoustic Guitar (Steel)": 25,
  "Electric Guitar (Jazz)": 26,
  "Electric Guitar (Clean)": 27,
  "Electric Guitar (Muted)": 28,
  "Overdriven Guitar": 29,
  "Distortion Guitar": 30,
  "Guitar Harmonics": 31,
  // Bass (32-39)
  "Acoustic Bass": 32,
  "Electric Bass (Finger)": 33,
  "Electric Bass (Pick)": 34,
  "Fretless Bass": 35,
  "Slap Bass 1": 36,
  "Slap Bass 2": 37,
  "Synth Bass 1": 38,
  "Synth Bass 2": 39,
  // Strings (40-47)
  "Violin": 40,
  "Viola": 41,
  "Cello": 42,
  "Contrabass": 43,
  "Tremolo Strings": 44,
  "Pizzicato Strings": 45,
  "Orchestral Harp": 46,
  "Timpani": 47,
  // Ensemble (48-55)
  "String Ensemble": 48,
  "String Ensemble 2": 49,
  "Synth Strings 1": 50,
  "Synth Strings 2": 51,
  "Choir Aahs": 52,
  "Voice Oohs": 53,
  "Synth Choir": 54,
  "Orchestra Hit": 55,
  // Brass (56-63)
  "Trumpet": 56,
  "Trombone": 57,
  "Tuba": 58,
  "Muted Trumpet": 59,
  "French Horn": 60,
  "Brass Section": 61,
  "Synth Brass 1": 62,
  "Synth Brass 2": 63,
  // Reed (64-71)
  "Soprano Sax": 64,
  "Alto Sax": 65,
  "Tenor Sax": 66,
  "Baritone Sax": 67,
  "Oboe": 68,
  "English Horn": 69,
  "Bassoon": 70,
  "Clarinet": 71,
  // Pipe (72-79)
  "Piccolo": 72,
  "Flute": 73,
  "Recorder": 74,
  "Pan Flute": 75,
  "Blown Bottle": 76,
  "Shakuhachi": 77,
  "Whistle": 78,
  "Ocarina": 79,
  // Synth lead (80-87)
  "Square Lead": 80,
  "Sawtooth Lead": 81,
  "Calliope Lead": 82,
  "Chiff Lead": 83,
  "Charang Lead": 84,
  "Voice Lead": 85,
  "Fifths Lead": 86,
  "Bass + Lead": 87,
  // Synth pad (88-95)
  "New Age Pad": 88,
  "Warm Pad": 89,
  "Polysynth Pad": 90,
  "Choir Pad": 91,
  "Bowed Pad": 92,
  "Metallic Pad": 93,
  "Halo Pad": 94,
  "Sweep Pad": 95,
  // Synth effects (96-103)
  "Rain (FX)": 96,
  "Soundtrack (FX)": 97,
  "Crystal (FX)": 98,
  "Atmosphere (FX)": 99,
  "Brightness (FX)": 100,
  "Goblins (FX)": 101,
  "Echoes (FX)": 102,
  "Sci-Fi (FX)": 103,
  // Ethnic (104-111)
  "Sitar": 104,
  "Banjo": 105,
  "Shamisen": 106,
  "Koto": 107,
  "Kalimba": 108,
  "Bagpipe": 109,
  "Fiddle": 110,
  "Shanai": 111,
  // Percussive (112-119)
  "Tinkle Bell": 112,
  "Agogo": 113,
  "Steel Drums": 114,
  "Woodblock": 115,
  "Taiko Drum": 116,
  "Melodic Tom": 117,
  "Synth Drum": 118,
  "Reverse Cymbal": 119,
  // Sound effects (120-127)
  "Guitar Fret Noise": 120,
  "Breath Noise": 121,
  "Seashore": 122,
  "Bird Tweet": 123,
  "Telephone Ring": 124,
  "Helicopter": 125,
  "Applause": 126,
  "Gunshot": 127,
};

/**
 * Alternate spellings that resolve to a canonical INSTRUMENTS key.
 *
 * These are names the GM spec or get-music-guide's 'instruments' topic uses for
 * a program whose key here is spelled differently — an agent reading the guide
 * must not get a silent piano.
 */
export const INSTRUMENT_ALIASES: Record<string, string> = {
  "electric piano 1": "Electric Piano",
  "string ensemble 1": "String Ensemble",
  "hammond organ": "Drawbar Organ",
  "honky tonk piano": "Honky-tonk Piano",
  "steel drum": "Steel Drums",
  "slap bass": "Slap Bass 1",
  "guitar harmonic": "Guitar Harmonics",
};

export const STYLE_NAMES = [
  "rock",
  "jazz",
  "bossa",
  "waltz",
  "march",
  "reggae",
  "folk",
  "classical",
] as const;

export type StyleName = (typeof STYLE_NAMES)[number];

/**
 * Accompaniment presets — `%%MIDI` directives injected after the K: line.
 *
 * ## The `%%MIDI drum` argument-count rule (this silently ate four presets)
 *
 * abcjs's `normalizeDrumDefinition` (node_modules/abcjs/src/synth/abc_midi_flattener.js)
 * is deliberately all-or-nothing: *any* imperfection and it returns
 * `{ on: false }` — no error, no warning, just no drums. The rule it enforces:
 *
 *     params.pattern.length !== totalPlay * 2 + 1  ->  drums off
 *
 * where `totalPlay` counts only the **`d` (hit)** characters in the pattern
 * string. `z` rests take NO arguments. So the argument list is
 *
 *     <pattern> <pitch × numberOfD> <velocity × numberOfD>
 *
 * Until 2026-09 four presets padded the list with 0-placeholders for their `z`
 * rests (`dzz 36 0 0 90 0 0`), which made the count wrong and turned the drums
 * off. Measured percussion-note events over a two-bar 4/4 probe, before →
 * after: jazz 0 → 8, waltz 0 → 2, reggae 0 → 4, folk 0 → 2. (rock 8, bossa 16
 * and march 8 were always correct; classical is intentionally drumless.)
 *
 * `tests/style-presets-sequence.test.ts` runs every preset through the real
 * abcjs flattener (`tune.setUpAudio()`, the same call `CreateSynth` makes) and
 * asserts non-zero percussion, chord and bass events. `parseOnly()` cannot
 * catch this — the parser happily accepts a pattern the sequencer rejects.
 */
export const STYLE_PRESETS: Record<StyleName, string> = {
  rock: [
    "%%MIDI drumon",
    "%%MIDI drum dddd 36 42 38 42 90 70 100 70",
    "%%MIDI gchord fzcz",
    "%%MIDI chordprog 27",
    "%%MIDI bassprog 33",
    "%%MIDI chordvol 70",
    "%%MIDI bassvol 85",
  ].join("\n"),
  jazz: [
    "%%MIDI drumon",
    "%%MIDI drum dzddzd 51 51 51 42 80 60 80 50",
    "%%MIDI gchord fzcz",
    "%%MIDI chordprog 0",
    "%%MIDI bassprog 32",
    "%%MIDI chordvol 65",
    "%%MIDI bassvol 80",
  ].join("\n"),
  bossa: [
    "%%MIDI drumon",
    "%%MIDI drum dddddddd 36 76 38 76 36 76 38 76 80 50 70 50 80 50 70 50",
    "%%MIDI gchord fzcfzc",
    "%%MIDI chordprog 24",
    "%%MIDI bassprog 32",
    "%%MIDI chordvol 65",
    "%%MIDI bassvol 85",
  ].join("\n"),
  waltz: [
    "%%MIDI drumon",
    "%%MIDI drum dzz 36 90",
    "%%MIDI gchord fcc",
    "%%MIDI chordprog 0",
    "%%MIDI bassprog 32",
    "%%MIDI chordvol 70",
    "%%MIDI bassvol 80",
  ].join("\n"),
  march: [
    "%%MIDI drumon",
    "%%MIDI drum dddd 38 38 38 38 100 60 80 60",
    "%%MIDI gchord fzcz",
    "%%MIDI chordprog 56",
    "%%MIDI bassprog 32",
    "%%MIDI chordvol 75",
    "%%MIDI bassvol 85",
  ].join("\n"),
  reggae: [
    "%%MIDI drumon",
    "%%MIDI drum zdzd 42 38 60 90",
    "%%MIDI gchord zcfz",
    "%%MIDI chordprog 27",
    "%%MIDI bassprog 33",
    "%%MIDI chordvol 65",
    "%%MIDI bassvol 90",
  ].join("\n"),
  folk: [
    "%%MIDI drumon",
    "%%MIDI drum dzzz 36 50",
    "%%MIDI gchord fzcz",
    "%%MIDI chordprog 25",
    "%%MIDI bassprog 32",
    "%%MIDI chordvol 70",
    "%%MIDI bassvol 75",
  ].join("\n"),
  classical: [
    "%%MIDI gchord fzcz",
    "%%MIDI chordprog 48",
    "%%MIDI bassprog 42",
    "%%MIDI chordvol 65",
    "%%MIDI bassvol 75",
  ].join("\n"),
};

export interface MusicToolInput {
  abcNotation?: string;
  title?: string;
  instrument?: string;
  style?: string;
  tempo?: number;
  swing?: number;
  drumIntro?: number;
  transpose?: number;
}

// =============================================================================
// Swing
// =============================================================================
//
// abcjs's swing is a *percentage of the beat given to the first half*, not an
// "amount of swing" dial:
//
//   node_modules/abcjs/src/synth/create-synth.js → addSwing()
//     • returns immediately unless the meter denominator is 4 or 8
//     • returns immediately when `swing <= 50` (50 = straight)
//     • clamps anything above 75 down to 75
//
// So the old 0–100 schema with "33 = light swing" was backwards: every value
// it recommended was a silent no-op. These constants encode the real range.

/** At or below this, abcjs applies no swing at all. */
export const SWING_STRAIGHT = 50;
/** abcjs clamps here (first eighth dotted, second a sixteenth). */
export const SWING_MAX = 75;

/**
 * Map a caller-supplied swing value onto what abcjs actually honours.
 *
 * Returns `undefined` for "don't pass swing to the synth" — which covers both
 * an omitted value and any legacy value at or below 50 (including the old
 * `0` = straight convention). Values above 75 clamp to 75 rather than being
 * rejected, matching abcjs.
 */
export function normalizeSwing(swing: number | undefined): number | undefined {
  if (swing === undefined || !Number.isFinite(swing)) return undefined;
  if (swing <= SWING_STRAIGHT) return undefined;
  return Math.min(swing, SWING_MAX);
}

// =============================================================================
// Drum intro
// =============================================================================

/** abcjs counts the intro in whole measures; more than a couple is tedious. */
export const DRUM_INTRO_MAX = 8;

/**
 * Bars of count-in before the melody (abcjs `SynthOptions.drumIntro`).
 *
 * abcjs splices N measures of rest onto the front of every voice
 * (`abc_midi_sequencer.js`), so the *audible* count-in only exists when a drum
 * pattern is running — i.e. when a style preset has emitted `%%MIDI drumon`.
 * Without a style you get N bars of silence, which is why the schema says so.
 */
export function normalizeDrumIntro(bars: number | undefined): number | undefined {
  if (bars === undefined || !Number.isFinite(bars)) return undefined;
  const whole = Math.trunc(bars);
  if (whole <= 0) return undefined;
  return Math.min(whole, DRUM_INTRO_MAX);
}

// =============================================================================
// Sound fonts
// =============================================================================
//
// abcjs streams one mp3 per pitch, composing the URL as
//   <soundFontUrl><instrument>-mp3/<NoteName>.mp3
// (see node_modules/abcjs/src/synth/load-note.js). Any MIDI.js-format bank
// laid out that way works, but it MUST also ship a `percussion-mp3/` folder:
// `%%MIDI drumon` (every style preset except `classical`) resolves GM program
// 128 to the instrument name `percussion`, and a bank without it drops the
// drums silently — one console error per note, no visible failure.
//
// All three banks below are paulrosen mirrors, verified to carry
// `percussion-mp3/` plus every instrument in INSTRUMENTS. The gleitz mirror
// hosts the same MusyngKite/FluidR3 samples in the same layout but has no
// percussion folder, so it is deliberately not offered here.
//
// `volumeMultiplier` mirrors abcjs's own per-bank defaults so switching banks
// doesn't change perceived loudness (create-synth.js applies 3.0 to its
// default/alternate banks and 0.4 to the original `abcjs/` bank).

export interface SoundFontOption {
  /** Human label for the widget's Sound selector. */
  label: string;
  /** Base URL passed to abcjs as `soundFontUrl` (trailing slash required). */
  url: string;
  /** Passed as `soundFontVolumeMultiplier`; matches abcjs's per-bank default. */
  volumeMultiplier: number;
}

export const SOUNDFONT_NAMES = ["default", "musyngkite", "dry"] as const;

export type SoundFontName = (typeof SOUNDFONT_NAMES)[number];

export const DEFAULT_SOUNDFONT: SoundFontName = "default";

const SOUNDFONT_HOST = "https://paulrosen.github.io/midi-js-soundfonts";

export const SOUNDFONTS: Record<SoundFontName, SoundFontOption> = {
  // abcjs's own default bank — current behaviour, unchanged.
  default: {
    label: "Default (FluidR3)",
    url: `${SOUNDFONT_HOST}/FluidR3_GM/`,
    volumeMultiplier: 3.0,
  },
  // abcjs's `alternateSoundFontUrl`: fuller, more dynamic, larger samples
  // (first-play latency rises).
  musyngkite: {
    label: "MusyngKite (fuller)",
    url: `${SOUNDFONT_HOST}/MusyngKite/`,
    volumeMultiplier: 3.0,
  },
  // abcjs's `originalSoundFontUrl`: smaller, drier, fastest to load.
  dry: {
    label: "Dry (lightweight)",
    url: `${SOUNDFONT_HOST}/abcjs/`,
    volumeMultiplier: 0.4,
  },
};

export function isSoundFontName(name: string): name is SoundFontName {
  return Object.hasOwn(SOUNDFONTS, name);
}

export function resolveSoundFont(name: string | undefined): SoundFontOption {
  return name && isSoundFontName(name)
    ? SOUNDFONTS[name]
    : SOUNDFONTS[DEFAULT_SOUNDFONT];
}

/** Synth options fragment for a sound font, ready to spread into SynthOptions. */
export function soundFontSynthOptions(name: string | undefined): {
  soundFontUrl: string;
  soundFontVolumeMultiplier: number;
} {
  const font = resolveSoundFont(name);
  return {
    soundFontUrl: font.url,
    soundFontVolumeMultiplier: font.volumeMultiplier,
  };
}

export interface InvocationSettings {
  /** Canonical INSTRUMENTS key actually used. */
  instrument: string;
  style: string;
  /** What the caller asked for, when they asked for anything. */
  requestedInstrument?: string;
  /** Set when the resolved instrument is not what was requested. */
  warning?: string;
}

export interface PreparedToolInput extends InvocationSettings {
  abcNotation?: string;
  /**
   * Semitones to shift. Applied to the *notation* by `transposeAbc()` at render
   * time (both score and key signature move together) rather than baked into
   * the ABC here, because it needs a parsed tune and this module stays
   * ABCJS-free so the Worker can import it.
   */
  transpose?: number;
  synthOptions: Record<string, unknown>;
}

export function isStyleName(style: string): style is StyleName {
  return Object.hasOwn(STYLE_PRESETS, style);
}

/**
 * Resolve a caller-supplied instrument name to a canonical INSTRUMENTS key.
 *
 * Three passes, each preferring the LOWEST GM program number among its hits so
 * the answer is deterministic and explainable ("the first GM program that
 * matches"):
 *
 *   1. exact, case-insensitive — including INSTRUMENT_ALIASES.
 *   2. whole word or prefix — "sax" → Soprano Sax (64, the first of the four),
 *      "slap bass" → Slap Bass 1 (36), "piano" → Acoustic Grand Piano (0).
 *   3. plain substring — the last resort, e.g. "harp" → Harpsichord (6).
 *
 * Returns `undefined` when nothing matches, so callers can say so out loud
 * rather than playing a grand piano and pretending it was asked for.
 */
export function findInstrument(name: string): string | undefined {
  const query = name.trim().toLowerCase();
  if (query.length === 0) return undefined;

  if (Object.hasOwn(INSTRUMENTS, name)) return name;

  const byProgram = (a: string, b: string) => INSTRUMENTS[a]! - INSTRUMENTS[b]!;
  const keys = Object.keys(INSTRUMENTS);

  const exact = keys.filter((k) => k.toLowerCase() === query).sort(byProgram);
  if (exact.length > 0) return exact[0];

  const alias = Object.hasOwn(INSTRUMENT_ALIASES, query)
    ? INSTRUMENT_ALIASES[query]
    : undefined;
  if (alias) return alias;

  // Whole word or prefix: "sax" matches "Alto Sax" but not "Saxophonist"-style
  // mid-word noise, and "flute" matches "Pan Flute".
  const wordBoundary = new RegExp(
    `(^|[^a-z0-9])${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`,
  );
  const worded = keys
    .filter((k) => {
      const lower = k.toLowerCase();
      return lower.startsWith(query) || wordBoundary.test(lower);
    })
    .sort(byProgram);
  if (worded.length > 0) return worded[0];

  const loose = keys.filter((k) => k.toLowerCase().includes(query)).sort(byProgram);
  return loose[0];
}

export function resolveInvocationSettings(
  input: Pick<MusicToolInput, "instrument" | "style">,
): InvocationSettings {
  const requested = input.instrument?.trim();
  const matchedInstrument = requested ? findInstrument(requested) : undefined;
  const instrument = matchedInstrument ?? DEFAULT_INSTRUMENT;

  // Only speak up when the caller asked for something we did not give them.
  // An exact hit (case aside) is silent; a fuzzy hit and a miss are both worth
  // saying, because both used to look identical from outside.
  const warning =
    requested && requested.toLowerCase() !== instrument.toLowerCase()
      ? matchedInstrument
        ? `Instrument "${requested}" matched "${instrument}" (GM program ${INSTRUMENTS[instrument] ?? 0}).`
        : `Unknown instrument "${requested}" — using ${DEFAULT_INSTRUMENT}. ` +
          `Use get-music-guide with topic "instruments" for the GM list, or %%MIDI program N in the ABC.`
      : undefined;

  return {
    instrument,
    style: input.style && isStyleName(input.style) ? input.style : DEFAULT_STYLE,
    ...(requested ? { requestedInstrument: requested } : {}),
    ...(warning ? { warning } : {}),
  };
}

// Insert style directives after the K: line but before any V: (voice) lines.
// This places them in the global header area where ABCJS reads them as
// tune-level formatting (abctune.formatting.midi). Inline %%MIDI directives
// within voice blocks also work — ABCJS pushes drum changes to voices[0]
// regardless of which voice they appear in.
export function applyStyleToAbc(abc: string, style: string): string {
  if (!style || !isStyleName(style)) return abc;

  const directives = STYLE_PRESETS[style];
  const keyMatch = abc.match(/^(K:[^\n]*\n)/m);
  if (keyMatch && keyMatch.index !== undefined) {
    const insertPos = keyMatch.index + keyMatch[0].length;
    return abc.slice(0, insertPos) + directives + "\n" + abc.slice(insertPos);
  }

  return directives + "\n" + abc;
}

/**
 * Replace/insert the Q: tempo header.
 *
 * Named for the header it writes so it can't be confused with
 * `shared/tempo.ts`'s `injectTempo`, which rewrites Strudel's `setcps`.
 *
 * Transposition used to ride along here as `%%MIDI transpose N`, which shifted
 * only the MIDI stream — the printed score and its K: stayed put, so what you
 * saw was a semitone-shifted lie about what you heard. Transposition now goes
 * through `transposeAbc()` (ABCJS `strTranspose`), which rewrites the notes and
 * the key signature in the ABC itself.
 */
export function injectTempoHeader(
  abc: string,
  options: Pick<MusicToolInput, "tempo">,
): string {
  if (options.tempo === undefined) return abc;

  const nextAbc = abc.replace(/^Q:[^\n]*\n?/m, "");
  const injection = `Q:1/4=${options.tempo}`;

  if (/(K:[^\n]*\n)/m.test(nextAbc)) {
    return nextAbc.replace(/(K:[^\n]*\n)/m, `$1${injection}\n`);
  }

  return `${injection}\n${nextAbc}`;
}

/**
 * Every synth option derived from the current widget/player selections.
 *
 * The single place that decides what `setTune()` and `getMidiFile()` both see,
 * so exported MIDI matches what is playing. Kept pure (and here rather than in
 * the widget) so it can be unit-tested without a DOM.
 */
export function buildSynthOptions(args: {
  instrument: string;
  soundFont?: string;
  /** Synth options carried in from the tool call (swing, drumIntro, …). */
  toolSynthOptions?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    program: Object.hasOwn(INSTRUMENTS, args.instrument)
      ? (INSTRUMENTS[args.instrument] ?? 0)
      : 0,
    ...soundFontSynthOptions(args.soundFont),
    ...(args.toolSynthOptions ?? {}),
  };
}

export function prepareToolInput(input: MusicToolInput): PreparedToolInput {
  const settings = resolveInvocationSettings(input);
  const synthOptions: Record<string, unknown> = {};

  const swing = normalizeSwing(input.swing);
  if (swing !== undefined) {
    synthOptions.swing = swing;
  }

  const drumIntro = normalizeDrumIntro(input.drumIntro);
  if (drumIntro !== undefined) {
    synthOptions.drumIntro = drumIntro;
  }

  return {
    ...settings,
    abcNotation: input.abcNotation
      ? injectTempoHeader(input.abcNotation, input)
      : undefined,
    transpose: input.transpose,
    synthOptions,
  };
}
