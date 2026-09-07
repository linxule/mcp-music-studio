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
  chord?: { name?: string }[];
  gracenotes?: unknown[];
  decoration?: string[];
  lyric?: unknown[];
  startTriplet?: number;
  tripletMultiplier?: number;
  endTriplet?: boolean;
  startEnding?: string;
  value?: { num?: string | number; den?: string | number }[];
  accidentals?: { acc?: string; note?: string }[];
}

export interface AbcStaffElement {
  voices?: AbcVoiceElement[][];
  key?: { accidentals?: { acc?: string; note?: string }[] };
  meter?: { type?: string; value?: { num?: string | number; den?: string | number }[] };
}

export interface AbcLineElement {
  staff?: AbcStaffElement[];
}

export interface AbcTune {
  lines?: AbcLineElement[];
  warnings?: string[];
  metaText?: { title?: string; tempo?: { bpm?: number; duration?: number[] } };
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
  /** Chord symbol per bar (carried forward when a bar has none). */
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
}

export function pitchToStrudel(pitch: AbcPitchElement, ctx: PitchContext): string {
  const step = pitch.pitch ?? 0;
  const letter = LETTERS[((step % 7) + 7) % 7]!;
  const octave = 4 + Math.floor(step / 7);
  const slot = `${letter}${octave}`;

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
 */
export function normalizeChordSymbol(name: string): string {
  return name
    .replace(/♭/g, "b")
    .replace(/♯/g, "#")
    .replace(/♮/g, "")
    .replace(/\u{1D12A}/gu, "##")
    .replace(/\u{1D12B}/gu, "bb")
    .replace(/[Δ△]/g, "maj7")
    .replace(/\s+/g, "");
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
  const sound = args.sound?.trim() || DEFAULT_STRUDEL_SOUND;

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
  const barChords: (string | null)[] = [];
  const barDurations: number[] = [];

  let meter: Meter = DEFAULT_METER;
  let firstMeter: Meter = DEFAULT_METER;
  let sawMeter = false;
  const ctx: PitchContext = { key: new Map(), measure: new Map(), microtonal: false };

  let slots: Slot[] = [];
  let barChord: string | null = null;
  let tripletSlots: Slot[] | null = null;
  let tripletMultiplier = 1;

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
      bars.push(renderBar(slots, meter));
      barChords.push(barChord);
      barDurations.push(slots.reduce((sum, s) => sum + s.dur, 0));
    }
    slots = [];
    barChord = null;
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

      if (type !== "note") {
        if (type === "midi") dropped.add("%%MIDI directives (instruments, gchord, drums)");
        continue;
      }

      // --- a note, chord, or rest ------------------------------------------
      if (el.chord && el.chord.length > 0) {
        const name = el.chord[0]?.name;
        if (name && !barChord) barChord = normalizeChordSymbol(name);
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
  if (ctx.microtonal) dropped.add("microtonal accidentals (rounded to the nearest semitone)");
  if (voiceCount > 1) {
    dropped.add(
      `${voiceCount - 1} other voice${voiceCount - 1 === 1 ? "" : "s"} (re-run with voice: 2…${voiceCount})`,
    );
  }

  // A short pickup bar becomes a whole cycle like any other — say so out loud.
  const barWhole = firstMeter.num / firstMeter.den;
  if (bars.length > 1 && barDurations[0]! < barWhole - EPS) {
    dropped.add("pickup bar is stretched to a full cycle");
  }

  // --- chords -----------------------------------------------------------------
  const chords: string[] = [];
  let lastChord: string | null = null;
  let anyChord = false;
  for (const chord of barChords) {
    if (chord) {
      lastChord = chord;
      anyChord = true;
    }
    chords.push(lastChord ?? "~");
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

  lines.push(`note("<${bars.join(" ")}>").s("${sound}")`);
  if (anyChord) {
    lines.push(`chord("<${chords.join(" ")}>").voicing().s("${CHORD_STRUDEL_SOUND}")`);
  }

  const code = lines.join("\n");
  const droppedList = [...dropped];
  const title = tune.metaText?.title;

  const header =
    `${title ? `"${title}" — ` : ""}voice ${voiceIndex + 1} of ${voiceCount}, ` +
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
