export const DEFAULT_INSTRUMENT = "Acoustic Grand Piano";
export const DEFAULT_STYLE = "";

export const INSTRUMENTS: Record<string, number> = {
  "Acoustic Grand Piano": 0,
  "Bright Acoustic Piano": 1,
  "Electric Piano": 4,
  "Harpsichord": 6,
  "Celesta": 8,
  "Music Box": 10,
  "Vibraphone": 11,
  "Marimba": 12,
  "Xylophone": 13,
  "Church Organ": 19,
  "Accordion": 21,
  "Harmonica": 22,
  "Acoustic Guitar (Nylon)": 24,
  "Acoustic Guitar (Steel)": 25,
  "Electric Guitar (Clean)": 27,
  "Acoustic Bass": 32,
  "Violin": 40,
  "Viola": 41,
  "Cello": 42,
  "String Ensemble": 48,
  "Trumpet": 56,
  "Trombone": 57,
  "French Horn": 60,
  "Alto Sax": 65,
  "Tenor Sax": 66,
  "Oboe": 68,
  "Clarinet": 71,
  "Flute": 73,
  "Pan Flute": 75,
  "Steel Drums": 114,
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
    "%%MIDI drum dzddzd 51 0 51 51 0 42 80 0 60 80 0 50",
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
    "%%MIDI drum dzz 36 0 0 90 0 0",
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
    "%%MIDI drum zdzd 0 42 0 38 0 60 0 90",
    "%%MIDI gchord zcfz",
    "%%MIDI chordprog 27",
    "%%MIDI bassprog 33",
    "%%MIDI chordvol 65",
    "%%MIDI bassvol 90",
  ].join("\n"),
  folk: [
    "%%MIDI drumon",
    "%%MIDI drum dzzz 36 0 0 0 50 0 0 0",
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
  return name in SOUNDFONTS;
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
  instrument: string;
  style: string;
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
  return style in STYLE_PRESETS;
}

export function findInstrument(name: string): string | undefined {
  if (name in INSTRUMENTS) return name;
  const lower = name.toLowerCase();
  return Object.keys(INSTRUMENTS).find(
    (instrument) =>
      instrument.toLowerCase() === lower ||
      instrument.toLowerCase().includes(lower),
  );
}

export function resolveInvocationSettings(
  input: Pick<MusicToolInput, "instrument" | "style">,
): InvocationSettings {
  const matchedInstrument = input.instrument
    ? findInstrument(input.instrument)
    : undefined;

  return {
    instrument: matchedInstrument ?? DEFAULT_INSTRUMENT,
    style: input.style && isStyleName(input.style) ? input.style : DEFAULT_STYLE,
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
 * Transposition used to ride along here as `%%MIDI transpose N`, which shifted
 * only the MIDI stream — the printed score and its K: stayed put, so what you
 * saw was a semitone-shifted lie about what you heard. Transposition now goes
 * through `transposeAbc()` (ABCJS `strTranspose`), which rewrites the notes and
 * the key signature in the ABC itself.
 */
export function injectTempo(
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
    program: INSTRUMENTS[args.instrument] ?? 0,
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
      ? injectTempo(input.abcNotation, input)
      : undefined,
    transpose: input.transpose,
    synthOptions,
  };
}
