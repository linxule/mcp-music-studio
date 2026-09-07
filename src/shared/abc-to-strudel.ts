// =============================================================================
// convert-abc-to-strudel — bridge the two studio modes
//
// Turns a scored ABC melody into a Strudel mini-notation pattern so a
// play-sheet-music composition can be remixed live with play-live-pattern.
//
// Pure logic: the abcjs parser is INJECTED (`ParseOnlyFn`) rather than imported,
// so this module stays dependency-free and both transports can bundle it
// without dragging abcjs where it isn't wanted.
//
// What abcjs `parseOnly()` actually gives us (verified against abcjs 6.6.2):
//   - `pitches[].pitch` is a diatonic step index with 0 === ABC `C` === c4;
//     `c` is 7, `C,` is -7. Letter = "cdefgab"[pitch mod 7].
//   - `pitches[].accidental` is present ONLY when the accidental is written in
//     the source. The key signature is NOT folded in, and an accidental is NOT
//     propagated to later notes in the same bar — both are our job.
//   - `duration` is a fraction of a whole note and does NOT include the triplet
//     multiplier; `tripletMultiplier` rides on the note that has `startTriplet`.
//   - Ties live on `pitches[].startTie` / `.endTie`; chord symbols on
//     `el.chord[].name`; a bar line is `el_type === "bar"`.
// =============================================================================

import { asciiChordSymbol, irealChordSymbol, isChordSymbol } from "./harmony.js";

// -----------------------------------------------------------------------------
// Structural types for the subset of the abcjs parse tree we read
// -----------------------------------------------------------------------------

export interface AbcPitchElement {
  pitch: number;
  name?: string;
  accidental?: string;
  startTie?: unknown;
  endTie?: unknown;
}

export interface AbcVoiceElement {
  el_type?: string;
  type?: string;
  /** Offset of this element in the ABC source — how a voice slot is identified. */
  startChar?: number;
  duration?: number;
  pitches?: AbcPitchElement[];
  rest?: { type?: string };
  /**
   * Text attached above/below the note. `position: "default"` marks a real chord
   * symbol; anything else is a positioned annotation (`"^rit."`, `"_text"`).
   */
  chord?: { name?: string; position?: string }[];
  gracenotes?: unknown[];
  decoration?: string[];
  lyric?: unknown[];
  startTriplet?: number;
  tripletMultiplier?: number;
  endTriplet?: boolean;
  startEnding?: string;
  value?: { num?: string | number; den?: string | number }[];
  accidentals?: { acc?: string; note?: string }[];
  /** `el_type: "midi"` — `%%MIDI <cmd> <params…>` inside a voice. */
  cmd?: string;
  params?: (number | string)[];
  /** `el_type: "tempo"` — an inline Q: change. */
  bpm?: number;
}

export interface AbcStaffElement {
  voices?: AbcVoiceElement[][];
  key?: { accidentals?: { acc?: string; note?: string }[] };
  meter?: { type?: string; value?: { num?: string | number; den?: string | number }[] };
  /** `"treble"`, `"bass"`, `"treble-8"` — the ±8 suffix is a real octave shift. */
  clef?: { type?: string };
}

export interface AbcLineElement {
  staff?: AbcStaffElement[];
}

export interface AbcTune {
  lines?: AbcLineElement[];
  warnings?: string[];
  metaText?: { title?: string; tempo?: { bpm?: number; duration?: number[] } };
  /**
   * abcjs files `%%MIDI` directives that aren't inside an explicit V: here
   * (a single-voice tune's `%%MIDI program 73` lands in `midi.program`).
   */
  formatting?: { midi?: Record<string, (number | string)[]> };
}

export type ParseOnlyFn = (abcNotation: string) => AbcTune[];

// -----------------------------------------------------------------------------
// Public API types
// -----------------------------------------------------------------------------

export interface AbcToStrudelArgs {
  abcNotation: string;
  /** 1-based voice index across all staves of the tune. */
  voice?: number;
  /** Strudel sound for the melody line (a GM soundfont name). */
  sound?: string;
}

export interface AbcToStrudelSuccess {
  ok: true;
  /** Runnable Strudel code (setcps + note + optional chord lines). */
  code: string;
  /** One mini-notation group per bar, e.g. `[c4@2 d4 e4]`. */
  bars: string[];
  /**
   * Chord symbols per bar in ABC/lead-sheet spelling, carried forward when a bar
   * has none. A bar that changes chord partway through holds a weighted
   * sub-pattern, e.g. `[Dm7 G7]`. The emitted `code` uses the same shape but
   * respelled for Strudel's voicing dictionary (`Cmaj7` there is `C^7`).
   */
  chords: string[];
  /** Features that could not survive the conversion. */
  dropped: string[];
  /** How many voices the tune has, across all staves. */
  voiceCount: number;
  /** Agent-facing text: the code plus the lossiness note. */
  text: string;
}

export interface AbcToStrudelFailure {
  ok: false;
  error: string;
}

export type AbcToStrudelResult = AbcToStrudelSuccess | AbcToStrudelFailure;

export const DEFAULT_STRUDEL_SOUND = "gm_piano";
/** Sound used for the chord-symbol companion line. */
export const CHORD_STRUDEL_SOUND = "gm_epiano1";

// -----------------------------------------------------------------------------
// Sound names
// -----------------------------------------------------------------------------

/**
 * GM program number → Strudel soundfont name, indexed by program (0–127).
 *
 * ABC's `%%MIDI program 73` and Strudel's `gm_flute` name the same instrument;
 * without this table a flute part converted to a piano with nothing said about
 * it. The names are Strudel's own spellings — several differ from the GM
 * caption (program 0 is `gm_piano`, not `gm_acoustic_grand_piano`; 4 is
 * `gm_epiano1`; 23 is `gm_bandoneon`) — and a test checks every one of them
 * against the pinned REPL bundle's sound list.
 */
export const GM_PROGRAM_SOUNDS: readonly string[] = [
  // 0–7 piano
  "gm_piano", "gm_piano" /* gm_bright_acoustic_piano is not in the REPL bundle */, "gm_piano" /* gm_electric_grand_piano is not in the REPL bundle */, "gm_piano" /* gm_honky_tonk_piano is not in the REPL bundle */,
  "gm_epiano1", "gm_epiano2", "gm_harpsichord", "gm_clavinet",
  // 8–15 chromatic percussion
  "gm_celesta", "gm_glockenspiel", "gm_music_box", "gm_vibraphone",
  "gm_marimba", "gm_xylophone", "gm_tubular_bells", "gm_dulcimer",
  // 16–23 organ
  "gm_drawbar_organ", "gm_percussive_organ", "gm_rock_organ", "gm_church_organ",
  "gm_reed_organ", "gm_accordion", "gm_harmonica", "gm_bandoneon",
  // 24–31 guitar
  "gm_acoustic_guitar_nylon", "gm_acoustic_guitar_steel", "gm_electric_guitar_jazz",
  "gm_electric_guitar_clean", "gm_electric_guitar_muted", "gm_overdriven_guitar",
  "gm_distortion_guitar", "gm_guitar_harmonics",
  // 32–39 bass
  "gm_acoustic_bass", "gm_electric_bass_finger", "gm_electric_bass_pick", "gm_fretless_bass",
  "gm_slap_bass_1", "gm_slap_bass_2", "gm_synth_bass_1", "gm_synth_bass_2",
  // 40–47 strings
  "gm_violin", "gm_viola", "gm_cello", "gm_contrabass",
  "gm_tremolo_strings", "gm_pizzicato_strings", "gm_orchestral_harp", "gm_timpani",
  // 48–55 ensemble
  "gm_string_ensemble_1", "gm_string_ensemble_2", "gm_synth_strings_1", "gm_synth_strings_2",
  "gm_choir_aahs", "gm_voice_oohs", "gm_synth_choir", "gm_orchestra_hit",
  // 56–63 brass
  "gm_trumpet", "gm_trombone", "gm_tuba", "gm_muted_trumpet",
  "gm_french_horn", "gm_brass_section", "gm_synth_brass_1", "gm_synth_brass_2",
  // 64–71 reed
  "gm_soprano_sax", "gm_alto_sax", "gm_tenor_sax", "gm_baritone_sax",
  "gm_oboe", "gm_english_horn", "gm_bassoon", "gm_clarinet",
  // 72–79 pipe
  "gm_piccolo", "gm_flute", "gm_recorder", "gm_pan_flute",
  "gm_blown_bottle", "gm_shakuhachi", "gm_whistle", "gm_ocarina",
  // 80–87 synth lead
  "gm_lead_1_square", "gm_lead_2_sawtooth", "gm_lead_3_calliope", "gm_lead_4_chiff",
  "gm_lead_5_charang", "gm_lead_6_voice", "gm_lead_7_fifths", "gm_lead_8_bass_lead",
  // 88–95 synth pad
  "gm_pad_new_age", "gm_pad_warm", "gm_pad_poly", "gm_pad_choir",
  "gm_pad_bowed", "gm_pad_metallic", "gm_pad_halo", "gm_pad_sweep",
  // 96–103 synth effects
  "gm_fx_rain", "gm_fx_soundtrack", "gm_fx_crystal", "gm_fx_atmosphere",
  "gm_fx_brightness", "gm_fx_goblins", "gm_fx_echoes", "gm_fx_sci_fi",
  // 104–111 ethnic
  "gm_sitar", "gm_banjo", "gm_shamisen", "gm_koto",
  "gm_kalimba", "gm_bagpipe", "gm_fiddle", "gm_shanai",
  // 112–119 percussive
  "gm_tinkle_bell", "gm_agogo", "gm_steel_drums", "gm_woodblock",
  "gm_taiko_drum", "gm_melodic_tom", "gm_synth_drum", "gm_reverse_cymbal",
  // 120–127 sound effects
  "gm_guitar_fret_noise", "gm_breath_noise", "gm_seashore", "gm_bird_tweet",
  "gm_telephone", "gm_helicopter", "gm_applause", "gm_gunshot",
];

/** Strudel soundfont name for a GM program number, or null if out of range. */
export function soundForProgram(program: number): string | null {
  if (!Number.isFinite(program)) return null;
  const index = Math.round(program);
  return GM_PROGRAM_SOUNDS[index] ?? null;
}

/**
 * A double-quoted string is MINI-NOTATION in Strudel, not a plain string, so a
 * sound name has to be a bare token — anything with a space, bracket, comma or
 * angle would be parsed as a pattern (or fail to parse at all).
 */
const SAFE_SOUND = /^[A-Za-z0-9_:-]+$/;

/**
 * Quote a value as a JavaScript string literal. Everything user-supplied that
 * reaches the emitted code goes through this, so a stray quote or newline can
 * never produce source that won't parse.
 */
function jsString(value: string): string {
  return JSON.stringify(value);
}

// -----------------------------------------------------------------------------
// Small numeric helpers (durations are floats: 0.125, 0.0833…)
// -----------------------------------------------------------------------------

const EPS = 1e-6;

function isNearInteger(value: number): boolean {
  return Math.abs(value - Math.round(value)) < 1e-4;
}

// -----------------------------------------------------------------------------
// Pitch spelling
// -----------------------------------------------------------------------------

const LETTERS = "cdefgab";

const ACCIDENTAL_TO_SYMBOL: Record<string, string> = {
  sharp: "#",
  flat: "b",
  natural: "",
  dblsharp: "##",
  dblflat: "bb",
  quartersharp: "#",
  quarterflat: "b",
};

/** ABC key-signature accidentals → { letter: "#" | "b" }. */
function keyAccidentalMap(
  accidentals: { acc?: string; note?: string }[] | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of accidentals ?? []) {
    const letter = (entry.note ?? "").trim().toLowerCase().charAt(0);
    if (!letter || !LETTERS.includes(letter)) continue;
    map.set(letter, ACCIDENTAL_TO_SYMBOL[entry.acc ?? ""] ?? "");
  }
  return map;
}

interface PitchContext {
  key: Map<string, string>;
  /** Accidentals in force for the rest of the current bar, keyed letter+octave. */
  measure: Map<string, string>;
  microtonal: boolean;
  /**
   * Octaves to add to every emitted note: `clef=treble-8` sounds an octave below
   * where it is written, and `%%MIDI transpose 12` moves the whole part up one.
   */
  octaveShift: number;
}

export function pitchToStrudel(pitch: AbcPitchElement, ctx: PitchContext): string {
  const step = pitch.pitch ?? 0;
  const letter = LETTERS[((step % 7) + 7) % 7]!;
  const written = 4 + Math.floor(step / 7);
  const octave = written + ctx.octaveShift;
  // The bar's running accidentals are keyed by written position, so a shift
  // can't make two different notes share a slot.
  const slot = `${letter}${written}`;

  let accidental: string;
  if (pitch.accidental) {
    if (pitch.accidental === "quartersharp" || pitch.accidental === "quarterflat") {
      ctx.microtonal = true;
    }
    accidental = ACCIDENTAL_TO_SYMBOL[pitch.accidental] ?? "";
    ctx.measure.set(slot, accidental);
  } else if (ctx.measure.has(slot)) {
    accidental = ctx.measure.get(slot)!;
  } else {
    accidental = ctx.key.get(letter) ?? "";
  }

  return `${letter}${accidental}${octave}`;
}

// -----------------------------------------------------------------------------
// Bar rendering
// -----------------------------------------------------------------------------

interface Slot {
  /** Duration as a fraction of a whole note (triplet multiplier already applied). */
  dur: number;
  text: string;
}

/**
 * Weight each slot by its duration relative to the shortest one in the group and
 * render it as mini-notation. `C4 D2 E2` in 4/4 becomes `c4@2 d4 e4`.
 */
function renderSlots(slots: Slot[]): string {
  if (slots.length === 0) return "~";
  const unit = Math.min(...slots.map((s) => s.dur));
  if (!(unit > 0)) return slots.map((s) => s.text).join(" ");

  // Most tunes are dyadic, so the shortest slot is already the common unit.
  // Mixed tuplet/duple bars need a finer one — try successive subdivisions.
  let scale = 1;
  for (let k = 1; k <= 12; k += 1) {
    if (slots.every((s) => isNearInteger((s.dur / unit) * k))) {
      scale = k;
      break;
    }
  }

  const weights = slots.map((s) => Math.max(1, Math.round((s.dur / unit) * scale)));
  if (weights.every((w) => w === 1)) return slots.map((s) => s.text).join(" ");
  return slots.map((s, i) => (weights[i]! > 1 ? `${s.text}@${weights[i]}` : s.text)).join(" ");
}

/** A compound meter (6/8, 9/8, 12/8) reads as groups of three eighths. */
function compoundGroups(slots: Slot[], meter: Meter): Slot[][] | null {
  if (meter.den !== 8 || meter.num % 3 !== 0 || meter.num < 6) return null;
  const target = 3 / 8;
  const groups: Slot[][] = [];
  let current: Slot[] = [];
  let acc = 0;
  for (const slot of slots) {
    current.push(slot);
    acc += slot.dur;
    if (Math.abs(acc - target) < EPS) {
      groups.push(current);
      current = [];
      acc = 0;
    } else if (acc > target + EPS) {
      return null; // a note straddles the group boundary — fall back to a flat bar
    }
  }
  if (current.length > 0) groups.push(current);
  return groups.length > 1 ? groups : null;
}

function renderBar(slots: Slot[], meter: Meter): string {
  const groups = compoundGroups(slots, meter);
  if (groups) {
    return `[${groups.map((g) => (g.length > 1 ? `[${renderSlots(g)}]` : renderSlots(g))).join(" ")}]`;
  }
  return `[${renderSlots(slots)}]`;
}

// -----------------------------------------------------------------------------
// Conversion
// -----------------------------------------------------------------------------

interface Meter {
  num: number;
  den: number;
}

const DEFAULT_METER: Meter = { num: 4, den: 4 };

// -----------------------------------------------------------------------------
// Chord symbols, in time
// -----------------------------------------------------------------------------
//
// A bar can carry more than one chord ("Cmaj7 … G7 …"), and keeping only the
// first turned a ii-V into a static vamp. Each symbol is stamped with where in
// the bar it starts, so the bar renders as a weighted sub-pattern — the same
// `@` weighting the melody uses — instead of a single symbol.

interface ChordEvent {
  /** Offset into the bar, as a fraction of a whole note. */
  at: number;
  /** Lead-sheet / ABC spelling, e.g. "Cmaj7". */
  abc: string;
  /** Spelling Strudel's ireal voicing dictionary accepts, e.g. "C^7". */
  ireal: string | null;
}

interface BarChords {
  events: ChordEvent[];
  /** Total sounding length of the bar. */
  total: number;
}

/** Render one bar's chord events as mini-notation, in the requested spelling. */
function renderChordBar(events: readonly ChordEvent[], total: number, ireal: boolean): string {
  const slots: Slot[] = [];
  for (let i = 0; i < events.length; i += 1) {
    const dur = (events[i + 1]?.at ?? total) - events[i]!.at;
    if (!(dur > EPS)) continue;
    const event = events[i]!;
    slots.push({ dur, text: (ireal ? event.ireal : event.abc) ?? "~" });
  }
  if (slots.length === 0) return "~";
  if (slots.length === 1) return slots[0]!.text;
  return `[${renderSlots(slots)}]`;
}

function readMeter(
  meter: { value?: { num?: string | number; den?: string | number }[] } | undefined,
): Meter | null {
  const first = meter?.value?.[0];
  if (!first) return null;
  const num = Number(first.num);
  const den = Number(first.den);
  if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) return null;
  return { num, den };
}

// -----------------------------------------------------------------------------
// Voice identity
// -----------------------------------------------------------------------------
//
// abcjs's parse tree carries NO V: identity: `lines[].staff[].voices[]` is a
// positional list that shrinks when a later system omits a voice. Resolving the
// requested voice per line by position therefore silently retargets (or, when
// the system is shorter than the index, drops) whole systems.
//
// The identity is recoverable from the source instead: every element carries a
// `startChar`, and the V: field most recently preceding that offset names the
// voice the element belongs to. So we resolve the ID ONCE, up front, and then
// match each system's slots by ID — falling back to position only for tunes
// with no V: fields in the body at all.

interface VoiceMarker {
  id: string;
  /** Source offset at which this voice's music starts. */
  from: number;
}

interface VoiceMap {
  /** Voice IDs in declaration order (header V: fields count). */
  declared: string[];
  /** V: fields in the tune BODY, in source order. */
  body: VoiceMarker[];
}

/** `V:1 clef=bass` on its own line, or an inline `[V:1]` switch. */
const VOICE_FIELD = /(?:^[ \t]*V:[ \t]*|\[V:[ \t]*)([^\s\]\n]+)/gm;

export function readVoiceMap(abcNotation: string): VoiceMap {
  // Everything up to and including the first K: line is the tune header, where
  // a V: field declares a voice rather than opening its music.
  const keyLine = abcNotation.match(/^[ \t]*K:[^\n]*\n?/m);
  const headerEnd =
    keyLine?.index === undefined ? 0 : keyLine.index + keyLine[0].length;

  const declared: string[] = [];
  const body: VoiceMarker[] = [];
  for (const match of abcNotation.matchAll(VOICE_FIELD)) {
    const id = match[1]!;
    if (!declared.includes(id)) declared.push(id);
    if (match.index >= headerEnd) {
      body.push({ id, from: match.index + match[0].length });
    }
  }
  return { declared, body };
}

/** Which voice owns the music at this source offset. */
function voiceIdAt(offset: number, body: readonly VoiceMarker[]): string | null {
  let id: string | null = null;
  for (const marker of body) {
    if (marker.from > offset) break;
    id = marker.id;
  }
  return id;
}

/**
 * Earliest source offset in a voice slot. abcjs stamps `startChar: -1` on
 * elements it synthesised (a restated clef or key at the head of a system), so
 * only non-negative offsets identify anything — take the smallest of those.
 */
function firstOffset(voice: AbcVoiceElement[]): number | null {
  let earliest: number | null = null;
  for (const el of voice) {
    const at = el.startChar;
    if (typeof at !== "number" || at < 0) continue;
    if (earliest === null || at < earliest) earliest = at;
  }
  return earliest;
}

/**
 * How many bars a voice slot contributes, counted the way `closeBar()` does:
 * a bar line only closes a bar when notes have accumulated since the last one.
 */
function countBars(voice: AbcVoiceElement[]): number {
  let bars = 0;
  let pending = false;
  for (const el of voice) {
    if (el.el_type === "bar") {
      if (pending) bars += 1;
      pending = false;
    } else if (el.el_type === "note") {
      pending = true;
    }
  }
  return pending ? bars + 1 : bars;
}

function stripHtml(text: string): string {
  return String(text).replace(/<[^>]*>/g, "");
}

/**
 * abcjs pretty-prints chord symbols with typographic accidentals ("Bb7" comes
 * back as "B♭7"). Strudel's chord parser wants ASCII, so put them back.
 * (One implementation, shared with analyze-harmony.)
 */
export function normalizeChordSymbol(name: string): string {
  return asciiChordSymbol(name);
}

/**
 * A chord symbol carried by a note, or null when the attached text isn't one.
 *
 * abcjs puts positioned annotations (`"^rit."`, `"_soft"`, `"<"`, `">"`, `"@"`)
 * in the SAME `chord` array as real chord symbols, distinguished only by
 * `position` — everything but `"default"` is an annotation. That alone let
 * `"^rit."` through as a chord symbol, so the token is validated against tonal
 * as well: anything tonal can't read is reported, not guessed at.
 */
function readChordToken(
  entry: { name?: string; position?: string } | undefined,
): { ok: true; symbol: string } | { ok: false; text: string } | null {
  if (!entry) return null;
  const position = entry.position ?? "default";
  if (position !== "default") return null;
  // Defensive: if a build ever leaves the marker in the name, it's an annotation.
  const raw = String(entry.name ?? "").trim();
  if (!raw || /^[\^_<>@]/.test(raw)) return null;
  const symbol = normalizeChordSymbol(raw);
  if (!symbol) return null;
  return isChordSymbol(symbol) ? { ok: true, symbol } : { ok: false, text: raw };
}

/** Same fatal/non-fatal split as play-sheet-music, so the two tools agree. */
function fatalWarnings(warnings: string[] | undefined): string[] {
  const messages = (warnings ?? []).map(stripHtml);
  return messages.filter(
    (m) => m.includes("Expected") || m.includes("Unknown") || m.includes("Error"),
  );
}

export function convertAbcToStrudel(
  args: AbcToStrudelArgs,
  parseOnly: ParseOnlyFn,
): AbcToStrudelResult {
  const abcNotation = args.abcNotation ?? "";
  if (abcNotation.trim().length === 0) {
    return { ok: false, error: "No ABC notation supplied." };
  }

  let tune: AbcTune | undefined;
  try {
    tune = parseOnly(abcNotation)[0];
  } catch (err) {
    return { ok: false, error: `ABC parse failed: ${(err as Error).message}` };
  }
  if (!tune) return { ok: false, error: "ABC parse produced no tune." };

  const fatal = fatalWarnings(tune.warnings);
  if (fatal.length > 0) {
    return {
      ok: false,
      error: `ABC notation has errors:\n${fatal.join("\n")}`,
    };
  }

  const voiceIndex = Math.max(1, Math.floor(args.voice ?? 1)) - 1;

  // How many voices exist (max across lines — later lines can omit voices).
  let voiceCount = 0;
  for (const line of tune.lines ?? []) {
    let count = 0;
    for (const staff of line.staff ?? []) count += staff.voices?.length ?? 0;
    voiceCount = Math.max(voiceCount, count);
  }
  if (voiceCount === 0) {
    return { ok: false, error: "No music staves found in that ABC." };
  }
  if (voiceIndex >= voiceCount) {
    return {
      ok: false,
      error: `Voice ${voiceIndex + 1} not found — this tune has ${voiceCount} voice${voiceCount === 1 ? "" : "s"}.`,
    };
  }

  const dropped = new Set<string>();
  const bars: string[] = [];
  const barChords: (BarChords | null)[] = [];
  const barDurations: number[] = [];

  let meter: Meter = DEFAULT_METER;
  let firstMeter: Meter = DEFAULT_METER;
  let sawMeter = false;
  const ctx: PitchContext = {
    key: new Map(),
    measure: new Map(),
    microtonal: false,
    octaveShift: 0,
  };

  let slots: Slot[] = [];
  let chordEvents: ChordEvent[] = [];
  let tripletSlots: Slot[] | null = null;
  let tripletMultiplier = 1;

  // --- sound + octave, gathered from %%MIDI and the clef ----------------------
  let clefOctave = 0;
  let transposeOctave = 0;
  let midiProgram: number | null = null;
  const unconvertedMidi = new Set<string>();

  const applyMidi = (cmd: string, params: readonly (number | string)[]) => {
    if (cmd === "program") {
      // `%%MIDI program [channel] program` — the program is the last number.
      const program = Number(params[params.length - 1]);
      if (soundForProgram(program) !== null) midiProgram = program;
      else dropped.add(`%%MIDI program ${params.join(" ")} (not a GM program)`);
      return;
    }
    if (cmd === "transpose") {
      const semitones = Number(params[params.length - 1]);
      if (Number.isFinite(semitones) && semitones % 12 === 0) {
        transposeOctave = semitones / 12;
      } else {
        dropped.add(
          `%%MIDI transpose ${params.join(" ")} (only whole octaves are carried over)`,
        );
      }
      return;
    }
    if (cmd) unconvertedMidi.add(cmd);
  };

  for (const [cmd, params] of Object.entries(tune.formatting?.midi ?? {})) {
    applyMidi(cmd, Array.isArray(params) ? params : [params]);
  }

  const syncOctave = () => {
    ctx.octaveShift = clefOctave + transposeOctave;
  };
  syncOctave();

  /** How far into the current bar we are (triplet in progress included). */
  const barElapsed = () =>
    slots.reduce((sum, s) => sum + s.dur, 0) +
    (tripletSlots?.reduce((sum, s) => sum + s.dur, 0) ?? 0);

  const closeTriplet = () => {
    if (!tripletSlots) return;
    if (tripletSlots.length > 0) {
      slots.push({
        dur: tripletSlots.reduce((sum, s) => sum + s.dur, 0),
        text: `[${renderSlots(tripletSlots)}]`,
      });
    }
    tripletSlots = null;
    tripletMultiplier = 1;
  };

  const closeBar = () => {
    closeTriplet();
    if (slots.length > 0) {
      const total = slots.reduce((sum, s) => sum + s.dur, 0);
      bars.push(renderBar(slots, meter));
      barChords.push(chordEvents.length > 0 ? { events: chordEvents, total } : null);
      barDurations.push(total);
    }
    slots = [];
    chordEvents = [];
    ctx.measure.clear();
  };

  // Resolve the voice ONCE by V: id; position is the fallback for tunes whose
  // body has no V: fields (single-voice tunes, and multi-staff tunes that only
  // declare voices in the header).
  const voiceMap = readVoiceMap(abcNotation);
  const targetVoiceId = voiceMap.declared[voiceIndex] ?? null;
  const byId = targetVoiceId !== null && voiceMap.body.length > 0;
  let absentSystems = 0;

  for (const line of tune.lines ?? []) {
    if (!line.staff || line.staff.length === 0) continue;

    let chosen: { voice: AbcVoiceElement[]; staff: AbcStaffElement } | null = null;
    if (byId) {
      for (const staff of line.staff) {
        for (const voice of staff.voices ?? []) {
          const offset = firstOffset(voice);
          if (offset !== null && voiceIdAt(offset, voiceMap.body) === targetVoiceId) {
            chosen = { voice, staff };
          }
        }
      }
    } else {
      // Voices are numbered across staves, in reading order.
      let cursor = 0;
      for (const staff of line.staff) {
        for (const voice of staff.voices ?? []) {
          if (cursor === voiceIndex) chosen = { voice, staff };
          cursor += 1;
        }
      }
    }

    // The staff carrying our voice restates key/meter on every line. When our
    // voice is missing from this system, any staff's meter still tells us how
    // long its bars are.
    const meterStaff = chosen?.staff ?? line.staff.find((s) => readMeter(s.meter));
    const lineMeter = readMeter(meterStaff?.meter);
    if (lineMeter) {
      if (sawMeter && (lineMeter.num !== meter.num || lineMeter.den !== meter.den)) {
        dropped.add("meter changes (every bar becomes one cycle)");
      }
      meter = lineMeter;
      if (!sawMeter) firstMeter = lineMeter;
      sawMeter = true;
    }
    if (chosen?.staff.key?.accidentals) {
      ctx.key = keyAccidentalMap(chosen.staff.key.accidentals);
    }
    // `clef=treble-8` / `bass+8` sounds an octave away from where it is written.
    const clefType = chosen?.staff.clef?.type ?? "";
    if (clefType.endsWith("-8")) clefOctave = -1;
    else if (clefType.endsWith("+8")) clefOctave = 1;
    else if (chosen) clefOctave = 0;
    syncOctave();

    if (!chosen) {
      // This system has no music for our voice. Silence is not the same as
      // nothing: emit a rest per bar so the pattern stays aligned with the
      // other voices, and say so in `dropped` rather than losing the bars.
      closeBar();
      const reference = line.staff.flatMap((staff) => staff.voices ?? [])[0];
      const missing = reference ? countBars(reference) : 0;
      if (missing > 0) {
        absentSystems += 1;
        for (let i = 0; i < missing; i += 1) {
          bars.push("~");
          barChords.push(null);
          barDurations.push(meter.num / meter.den);
        }
      }
      continue;
    }

    for (const el of chosen.voice) {
      const type = el.el_type;

      if (type === "bar") {
        if (el.type && el.type !== "bar_thin" && el.type !== "bar_thin_thick") {
          dropped.add("repeats and alternate endings (bars are emitted in source order)");
        }
        if (el.startEnding) {
          dropped.add("repeats and alternate endings (bars are emitted in source order)");
        }
        closeBar();
        continue;
      }

      if (type === "meter") {
        const inline = readMeter(el);
        if (inline) {
          if (inline.num !== meter.num || inline.den !== meter.den) {
            dropped.add("meter changes (every bar becomes one cycle)");
          }
          meter = inline;
          if (!sawMeter) firstMeter = inline;
          sawMeter = true;
        }
        continue;
      }

      if (type === "key") {
        if (el.accidentals) ctx.key = keyAccidentalMap(el.accidentals);
        continue;
      }

      if (type === "midi") {
        applyMidi(String(el.cmd ?? ""), el.params ?? []);
        syncOctave();
        continue;
      }

      if (type === "tempo") {
        // setcps is set once, from the tune's opening Q:.
        dropped.add("tempo changes inside the tune (setcps uses the first tempo)");
        continue;
      }

      if (type !== "note") continue;

      // --- a note, chord, or rest ------------------------------------------
      for (const entry of el.chord ?? []) {
        const token = readChordToken(entry);
        if (!token) continue;
        if (!token.ok) {
          dropped.add(`chord symbol "${token.text}" (not a chord tonal can read)`);
          continue;
        }
        const ireal = irealChordSymbol(token.symbol);
        if (!ireal) {
          dropped.add(
            `chord symbol "${token.symbol}" has no Strudel voicing (that cycle is silent)`,
          );
        }
        const at = barElapsed();
        const previous = chordEvents[chordEvents.length - 1];
        if (previous?.abc === token.symbol) continue;
        if (previous && Math.abs(previous.at - at) < EPS) {
          // Two symbols on the same beat — the later one wins.
          chordEvents[chordEvents.length - 1] = { at, abc: token.symbol, ireal };
        } else {
          chordEvents.push({ at, abc: token.symbol, ireal });
        }
      }
      if (el.gracenotes?.length) dropped.add("grace notes");
      if (el.decoration?.length) dropped.add("dynamics and ornaments");
      if (el.lyric?.length) dropped.add("lyrics");
      if (el.pitches?.some((p) => p.startTie || p.endTie) && (el.pitches?.length ?? 0) > 1) {
        dropped.add("ties inside chords");
      }

      if (el.startTriplet) {
        closeTriplet();
        tripletSlots = [];
        tripletMultiplier = el.tripletMultiplier ?? 1;
        if (el.startTriplet !== 3) dropped.add("tuplets other than triplets are approximated");
      }

      const dur = (el.duration ?? 0) * (tripletSlots ? tripletMultiplier : 1);
      const target = tripletSlots ?? slots;

      // A tied continuation is not a new event: fold its length into the note it
      // continues. Mini-notation's `_` needs a preceding step in the same group,
      // so a tie that crosses a bar line has to be re-articulated instead.
      const isTieContinuation =
        !el.rest && !!el.pitches?.length && el.pitches.every((p) => p.endTie);
      if (isTieContinuation && target.length > 0) {
        target[target.length - 1]!.dur += dur;
        if (el.endTriplet) closeTriplet();
        continue;
      }
      if (isTieContinuation) {
        dropped.add("ties across bar lines (the note is re-articulated)");
      }

      let text: string;
      if (el.rest || !el.pitches || el.pitches.length === 0) {
        text = "~";
      } else {
        const tokens = el.pitches.map((p) => pitchToStrudel(p, ctx));
        text = tokens.length > 1 ? `[${tokens.join(",")}]` : tokens[0]!;
      }

      target.push({ dur, text });

      if (el.endTriplet) closeTriplet();
    }
  }

  closeBar();

  if (bars.length === 0 || bars.every((bar) => bar === "~")) {
    return {
      ok: false,
      error: `Voice ${voiceIndex + 1} has no playable notes. Check the voice number, or that the ABC body has music after the K: line.`,
    };
  }

  if (absentSystems > 0) {
    dropped.add(
      `voice ${voiceIndex + 1} is silent in ${absentSystems} system${absentSystems === 1 ? "" : "s"} (filled with rests)`,
    );
  }
  if (unconvertedMidi.size > 0) {
    dropped.add(
      `%%MIDI ${[...unconvertedMidi].join(", ")} ` +
        "(ABC's own accompaniment — write it as extra Strudel layers instead)",
    );
  }
  if (ctx.microtonal) dropped.add("microtonal accidentals (rounded to the nearest semitone)");
  if (voiceCount > 1) {
    dropped.add(
      `${voiceCount - 1} other voice${voiceCount - 1 === 1 ? "" : "s"} (re-run with voice: 2…${voiceCount})`,
    );
  }

  // A bar shorter than the meter becomes a whole cycle like any other, whether
  // it opens the tune or closes it — say so out loud in both cases.
  const barWhole = firstMeter.num / firstMeter.den;
  if (bars.length > 1 && barDurations[0]! < barWhole - EPS) {
    dropped.add("pickup bar is stretched to a full cycle");
  }
  if (bars.length > 1 && barDurations[bars.length - 1]! < barWhole - EPS) {
    dropped.add("final bar is a pickup — Strudel will stretch it to a full cycle");
  }

  // --- chords -----------------------------------------------------------------
  // A bar with no symbol of its own inherits the last one, and a bar that starts
  // partway through a chord inherits it for the opening slot.
  const chords: string[] = [];
  const voicingChords: string[] = [];
  let lastChord: ChordEvent | null = null;
  let anyChord = false;
  for (const bar of barChords) {
    if (!bar) {
      chords.push(lastChord?.abc ?? "~");
      voicingChords.push(lastChord?.ireal ?? "~");
      continue;
    }
    anyChord = true;
    const events: ChordEvent[] =
      bar.events[0]!.at > EPS && lastChord
        ? [{ ...lastChord, at: 0 }, ...bar.events]
        : bar.events;
    chords.push(renderChordBar(events, bar.total, false));
    voicingChords.push(renderChordBar(events, bar.total, true));
    lastChord = events[events.length - 1]!;
  }

  // --- tempo ------------------------------------------------------------------
  const tempo = tune.metaText?.tempo;
  // One bar is one cycle, so cps is derived from the bar length in quarter notes.
  const beatsPerBar = (firstMeter.num * 4) / firstMeter.den;
  const lines: string[] = [];
  let setCps = false;
  if (tempo?.bpm && tempo.bpm > 0) {
    const beat = tempo.duration?.[0] ?? 0.25;
    const quarterBpm = Math.round(tempo.bpm * (beat / 0.25));
    lines.push(`setcps(${quarterBpm}/60/${beatsPerBar})`);
    setCps = true;
  }

  // --- sound ------------------------------------------------------------------
  // Priority: an explicit `sound` argument, then the tune's own %%MIDI program,
  // then the default. A caller-supplied name has to be a bare token: a
  // double-quoted string is mini-notation to Strudel, so `.s("my sound")` would
  // be read as a two-step pattern rather than one instrument.
  const requestedSound = args.sound?.trim() ?? "";
  let sound = DEFAULT_STRUDEL_SOUND;
  if (requestedSound) {
    if (SAFE_SOUND.test(requestedSound)) sound = requestedSound;
    else {
      dropped.add(
        `sound ${jsString(requestedSound)} is not a usable Strudel sound name ` +
          `(letters, digits, _ : - only) — using ${DEFAULT_STRUDEL_SOUND}`,
      );
    }
  } else if (midiProgram !== null) {
    sound = soundForProgram(midiProgram) ?? DEFAULT_STRUDEL_SOUND;
  }

  // Strudel's transpiler makes only the LAST expression statement the pattern it
  // plays; a melody line followed by a bare chord line would have silently
  // dropped the melody. One `stack(...)` is the whole piece.
  const layers = [`note("<${bars.join(" ")}>").s(${jsString(sound)})`];
  if (anyChord) {
    layers.push(
      `chord("<${voicingChords.join(" ")}>").voicing().s(${jsString(CHORD_STRUDEL_SOUND)})`,
    );
  }
  lines.push(layers.length === 1 ? layers[0]! : `stack(\n  ${layers.join(",\n  ")}\n)`);

  const code = lines.join("\n");
  const droppedList = [...dropped];
  const title = tune.metaText?.title;

  const header =
    `${title ? `${jsString(title)} — ` : ""}voice ${voiceIndex + 1} of ${voiceCount}, ` +
    `${bars.length} bar${bars.length === 1 ? "" : "s"} in ${firstMeter.num}/${firstMeter.den}. ` +
    "Each bar is one Strudel cycle. Play it with play-live-pattern.";

  const lossNote =
    droppedList.length > 0
      ? `Dropped: ${droppedList.join("; ")}.`
      : "Lossless for this tune.";

  // play-live-pattern's `bpm` parameter rewrites setcps as bpm/60/4 — right for
  // a four-quarter bar, wrong for anything else. This pattern already carries
  // the tune's own tempo over its own bar length, so passing bpm would silently
  // retime it (a 6/8 bar is 3 quarter notes, not 4).
  const tempoNote = !setCps
    ? ""
    : beatsPerBar === 4
      ? "\n\nTempo is already set — don't pass `bpm` for this pattern; it would override the tune's own tempo. Edit the setcps() line instead."
      : `\n\nTempo is already set — don't pass \`bpm\` for this pattern ` +
        `(its bar is ${beatsPerBar} quarter-note${beatsPerBar === 1 ? "" : "s"}, not 4). ` +
        "Edit the setcps() line instead.";

  return {
    ok: true,
    code,
    bars,
    chords,
    dropped: droppedList,
    voiceCount,
    text: `${header}\n\n${code}\n\n${lossNote}${tempoNote}`,
  };
}
