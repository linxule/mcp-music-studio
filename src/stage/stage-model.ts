/**
 * @file What the Stage shows, as data: who plays (one player per instrument
 * in the tune's audio, accompaniment included), which figure draws them, and
 * which of their notes sound at a moment. No DOM, so the timing rules are
 * tested directly.
 *
 * Source of truth is abcjs's own note map (create-note-map.js): the notes the
 * synth renders, one track per voice plus the style's chord, bass and drum
 * tracks, each note `{ pitch, instrument, start, end, volume }` in whole
 * notes. Before the first ▶ the widget builds one from `tune.setUpAudio()`
 * (instruments as GM numbers); once primed it takes the map abcjs actually
 * played, after swing, via `sequenceCallback` (instruments as names).
 */
import ABCJS from "abcjs";
import { INSTRUMENTS } from "../music-logic";
import type { FigureKind } from "./figures";

export interface MapNote {
  pitch: number;
  /** GM program number, or abcjs's instrument name ("percussion" = drums). */
  instrument: number | string;
  /** Whole notes. */
  start: number;
  end: number;
  volume: number;
}

export interface StageNote {
  pitch: number;
  /** Seconds from the start of the audio. */
  start: number;
  end: number;
  /** 0 = a muted (practice) voice. */
  volume: number;
}

export interface Player {
  /** abcjs's instrument name — stable across re-primes. */
  id: string;
  /** GM program, 128 for the drum kit. */
  program: number;
  label: string;
  figure: FigureKind;
  /** Sorted by start. */
  notes: StageNote[];
  low: number;
  high: number;
  /** The longest note, which bounds how far back a sounding note can have started. */
  longest: number;
  /** The audio's tracks this player's notes come from (a score's voices first, in `voicesOff` numbering). */
  tracks?: number[];
}

export const DRUMS = 128;

/** abcjs's GM program → instrument-name table: the names its note map uses ("percussion" = 128). */
const instrumentNames: readonly string[] = ABCJS.synth.instrumentIndexToName;

/** GM program → the figure that draws it. Anything without its own figure plays on a keyboard with its name on the screen. */
export function figureFor(program: number): FigureKind {
  if (program === DRUMS) return "drums";
  if (program <= 3 || program === 6) return "grand";
  if (program >= 9 && program <= 15) return "mallets";
  if (program === 24 || program === 25 || (program >= 104 && program <= 107)) return "guitar";
  if (program >= 26 && program <= 31) return "guitar";
  if (program >= 33 && program <= 39) return "ebass";
  if (program === 32 || (program >= 40 && program <= 45) || (program >= 48 && program <= 51) || program === 110) return "bowed";
  if (program === 108 || program === 112 || program === 114) return "mallets";
  if (program === 72 || program === 73) return "flute";
  if (program === 78) return "whistle";
  if (program === 71) return "clarinet";
  if (program === 113 || (program >= 115 && program <= 119)) return "drums";
  return "keys";
}

/** Which member of the violin family a bowed program draws. */
export function bowedKind(program: number): "violin" | "viola" | "cello" | "bass" {
  if (program === 40 || program === 110) return "violin";
  if (program === 41) return "viola";
  if (program === 43 || program === 32) return "bass";
  return "cello";
}

/** Is it an electric guitar (a solid body) rather than an acoustic one? */
export const isElectric = (program: number) => program >= 26 && program <= 31;

const LABELS = new Map<number, string>();
for (const [name, program] of Object.entries(INSTRUMENTS)) if (!LABELS.has(program)) LABELS.set(program, name);

export function programOf(instrument: number | string): number {
  if (typeof instrument === "number") return instrument;
  const i = instrumentNames.indexOf(instrument);
  return i < 0 ? 0 : i;
}

/**
 * A name tag's word: the instrument, not its variety ("Acoustic Grand Piano"
 * → "Piano", "Electric Bass (finger)" → "Bass").
 */
export function shortName(label: string): string {
  const base = label.replace(/\s*\(.*\)$/, "").trim();
  if (/ensemble|strings/i.test(base)) return "Strings";
  if (/choir|voice/i.test(base)) return "Voices";
  const words = base.split(/\s+/);
  const last = words[words.length - 1];
  return /^\d+$/.test(last) && words.length > 1 ? words[words.length - 2] : last;
}

export const labelOf = (program: number) => (program === DRUMS ? "Drums" : LABELS.get(program) ?? `Program ${program}`);

/**
 * abcjs's flattened sequence (`tune.setUpAudio()`) as a note map — the same
 * walk as create-note-map.js: `program` events set the instrument for the
 * notes after them, notes may carry their own, a note's `gap` is cut from its
 * end (at most two thirds of it).
 */
export function noteMapFromSequence(tracks: readonly (readonly Record<string, unknown>[])[]): MapNote[][] {
  let current = 0;
  return tracks.map((track) => {
    const out: MapNote[] = [];
    for (const ev of track) {
      if (ev.cmd === "program" && typeof ev.instrument === "number") current = ev.instrument;
      if (ev.cmd !== "note" || typeof ev.pitch !== "number" || typeof ev.start !== "number" || typeof ev.duration !== "number") continue;
      if (!(ev.duration > 0)) continue;
      const gap = Math.min(typeof ev.gap === "number" ? ev.gap : 0, (ev.duration * 2) / 3);
      out.push({
        pitch: ev.pitch,
        instrument: typeof ev.instrument === "number" ? ev.instrument : current,
        start: ev.start,
        end: ev.start + ev.duration - gap,
        volume: typeof ev.volume === "number" ? ev.volume : 0,
      });
    }
    return out;
  });
}

/**
 * One player per instrument, in order of first appearance (so the melody,
 * the score's first voice, comes first). Times scale from whole notes to
 * seconds by `secondsPerWhole`.
 */
export function playersFrom(tracks: readonly (readonly MapNote[])[], secondsPerWhole: number): Player[] {
  const players = new Map<number, Player>();
  tracks.forEach((track, index) => {
    for (const n of track) {
      const program = programOf(n.instrument);
      let p = players.get(program);
      if (!p) {
        p = {
          id: typeof n.instrument === "string" ? n.instrument : instrumentNames[program] ?? String(program),
          program,
          label: labelOf(program),
          figure: figureFor(program),
          notes: [],
          low: Infinity,
          high: -Infinity,
          longest: 0,
          tracks: [],
        };
        players.set(program, p);
      }
      if (!p.tracks!.includes(index)) p.tracks!.push(index);
      const start = n.start * secondsPerWhole, end = Math.max(start, n.end * secondsPerWhole);
      p.notes.push({ pitch: n.pitch, start, end, volume: n.volume });
      if (n.pitch < p.low) p.low = n.pitch;
      if (n.pitch > p.high) p.high = n.pitch;
      if (end - start > p.longest) p.longest = end - start;
    }
  });
  for (const p of players.values()) p.notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return [...players.values()];
}

/** A note lights for at least this long, so a staccato drum hit is seen. */
export const MIN_LIT_SECONDS = 0.09;

export interface Moment {
  /** Pitches sounding now. */
  on: number[];
  /** Pitches a muted voice would be playing now — the part you play. */
  yours: number[];
  /** Pitches starting within the lookahead. */
  next: number[];
  /** How many notes have started by now: its parity turns a bow round with each new note. */
  started: number;
}

/** First index whose note starts after `t`. */
function upperBound(notes: readonly StageNote[], t: number): number {
  let lo = 0, hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].start <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** What `player` is doing at `t` seconds, and what starts within `lookahead`. */
export function momentAt(player: Player, t: number, lookahead = 0): Moment {
  const notes = player.notes;
  const i = upperBound(notes, t);
  const on: number[] = [], yours: number[] = [], next: number[] = [];
  const reach = Math.max(player.longest, MIN_LIT_SECONDS);
  for (let j = i - 1; j >= 0 && notes[j].start > t - reach; j--) {
    const n = notes[j];
    if (t < Math.max(n.end, n.start + MIN_LIT_SECONDS)) (n.volume > 0 ? on : yours).push(n.pitch);
  }
  if (lookahead > 0) {
    for (let j = i; j < notes.length && notes[j].start <= t + lookahead; j++) next.push(notes[j].pitch);
  }
  return { on, yours, next, started: i };
}
