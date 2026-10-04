// =============================================================================
// sing() — the pure half: word timings, notes, and the phrase they make
//
// "Talk-singing": the Worker renders the line ONCE with Aura-2 (the same clip
// say() plays) and asks Whisper where each word is (GET /tts?…&words=1). The
// player puts word i on the i-th note, sped up or slowed down so its spoken
// pitch (src/shared/sing-dsp.ts) lands on the note. No singing model exists on
// Workers AI; this is what one TTS render and one ASR call can do. It sounds
// like a robot singing — formants move with the pitch, and a word is as long
// as it was spoken (÷ the speed), so long notes end early.
//
// Pure: imported by the Worker (the words route), the widget and share page
// (through stage-runtime), and the validator's stub.
// =============================================================================

import { noteNameToMidi } from "./hap-number.js";
import { ttsUrl, type TtsRequest } from "./tts.js";

/** Workers AI speech recognition with word timestamps (segments[].words). */
export const ASR_MODEL = "@cf/openai/whisper-large-v3-turbo";

export interface SungWord {
  word: string;
  /** Seconds into the clip. */
  start: number;
  end: number;
}

/** What GET /tts?…&words=1 answers. */
export interface SungWords {
  /** Absolute URL of the clip (the same one say() plays). */
  clip: string;
  sampleRate: number;
  /** Seconds, from the MP3's frames (the decoded buffer is the authority). */
  duration: number;
  words: SungWord[];
}

/** The words URL for a line: the clip URL plus words=1. */
export function ttsWordsUrl(origin: string, request: TtsRequest): string {
  return `${ttsUrl(origin, request)}&words=1`;
}

// -----------------------------------------------------------------------------
// MP3 frames → sample rate and duration (Aura-2 answers MP3; no decoder here)
// -----------------------------------------------------------------------------

const L3_KBPS_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const L3_KBPS_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** Layer III frames counted: the clip's sample rate and length. Null if it isn't MP3. */
export function mp3Info(bytes: Uint8Array): { sampleRate: number; duration: number; frames: number } | null {
  let i = 0;
  if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    i = 10 + size + (bytes[5] & 0x10 ? 10 : 0);
  }
  let frames = 0;
  let samples = 0;
  let sampleRate = 0;
  while (i + 4 <= bytes.length) {
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const version = (b1 >> 3) & 3;
    const layer = (b1 >> 1) & 3;
    const bitrateIndex = b2 >> 4;
    const rateIndex = (b2 >> 2) & 3;
    if (bytes[i] !== 0xff || (b1 & 0xe0) !== 0xe0 || version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) {
      if (frames > 0) break; // trailing tag or junk
      i++;
      continue;
    }
    const rate = RATES[version][rateIndex];
    const kbps = (version === 3 ? L3_KBPS_V1 : L3_KBPS_V2)[bitrateIndex];
    const perFrame = version === 3 ? 1152 : 576;
    const length = Math.floor(((version === 3 ? 144 : 72) * kbps * 1000) / rate) + ((b2 >> 1) & 1);
    sampleRate = rate;
    frames++;
    samples += perFrame;
    i += length;
  }
  return frames ? { sampleRate, duration: samples / sampleRate, frames } : null;
}

/** Whisper's answer → words with times, trimmed (each word comes with a leading space). */
export function parseWhisperWords(output: unknown, duration: number): SungWord[] {
  const segments = (output as { segments?: unknown } | null)?.segments;
  const words: SungWord[] = [];
  if (!Array.isArray(segments)) return words;
  for (const segment of segments) {
    const list = (segment as { words?: unknown } | null)?.words;
    if (!Array.isArray(list)) continue;
    for (const w of list) {
      const word = typeof w?.word === "string" ? w.word.trim() : "";
      const start = Number(w?.start);
      const end = Number(w?.end);
      if (!word || !Number.isFinite(start) || !Number.isFinite(end)) continue;
      const s = Math.max(0, Math.min(start, duration));
      const e = Math.max(s, Math.min(end, duration));
      words.push({ word, start: Math.round(s * 1000) / 1000, end: Math.round(e * 1000) / 1000 });
    }
  }
  return words;
}

// -----------------------------------------------------------------------------
// Notes → steps → the phrase
// -----------------------------------------------------------------------------

/** One note onset: where it falls (cycles) and its MIDI number. */
export interface NoteStep {
  begin: number;
  end: number;
  midi: number;
}

/** A source of notes, cycle by cycle (a single-quoted string or array repeats every cycle). */
export type NoteSource = (cycle: number) => NoteStep[];

/** The longest phrase sing() lays out: words past it are dropped. */
export const SING_MAX_CYCLES = 16;

const REST = /^[~\-_.]$/;

function tokenMidi(token: unknown): number | null {
  if (typeof token === "number") return Number.isFinite(token) ? token : null;
  if (typeof token !== "string") return null;
  const t = token.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return noteNameToMidi(t);
}

/**
 * The notes argument as a NoteSource. An array or a single-quoted string of
 * note names / MIDI numbers is one evenly spaced step each, `~` a rest. A
 * double-quoted string arrives as a mini-notation PATTERN (the transpiler made
 * it one) — then its onsets are the steps, so "c4 [d4 e4] ~ g4" works.
 * `midiOf` reads a hap's note (stageEvent in the runtime). Throws on notes it
 * can't read, so the error reaches the evaluation, not the first bar.
 */
export function noteSource(
  notes: unknown,
  midiOf: (hap: any) => number | undefined,
  toPattern?: (value: unknown) => unknown,
): NoteSource {
  if (typeof notes === "string" && toPattern && /[[\]<>{}(),@!*/:?|]/.test(notes)) {
    // Mini-notation beyond plain tokens: let Strudel parse it.
    notes = toPattern(notes);
  }
  if (notes && typeof (notes as any).queryArc === "function") {
    const pattern = notes as { queryArc(a: number, b: number): any[] };
    const source: NoteSource = (cycle) =>
      pattern
        .queryArc(cycle, cycle + 1)
        .filter((hap) => hap?.whole && (typeof hap.hasOnset !== "function" || hap.hasOnset()))
        .map((hap) => ({ begin: Number(hap.whole.begin), end: Number(hap.whole.end), midi: midiOf(hap) }))
        .filter((step): step is NoteStep => typeof step.midi === "number" && Number.isFinite(step.midi))
        .sort((a, b) => a.begin - b.begin);
    let any = false;
    for (let c = 0; c < SING_MAX_CYCLES && !any; c++) any = source(c).length > 0;
    if (!any) throw new TypeError(`sing(line, notes): the notes pattern has no notes — e.g. "c4 e4 g4 c5"`);
    return source;
  }
  const tokens = Array.isArray(notes) ? notes : typeof notes === "string" ? notes.trim().split(/\s+/) : null;
  if (!tokens || tokens.length === 0 || (tokens.length === 1 && tokens[0] === "")) {
    throw new TypeError(`sing(line, notes) needs notes — e.g. sing('still water runs deep', "c4 e4 g4 c5")`);
  }
  const steps: Array<number | null> = tokens.map((token) => {
    if (typeof token === "string" && REST.test(token.trim())) return null;
    const midi = tokenMidi(token);
    if (midi === null) throw new TypeError(`sing(line, notes): "${String(token)}" is not a note — use names like c4, eb3 or MIDI numbers`);
    return midi;
  });
  if (steps.every((s) => s === null)) throw new TypeError("sing(line, notes): the notes are all rests");
  const n = steps.length;
  return (cycle) =>
    steps.flatMap((midi, k) => (midi === null ? [] : [{ begin: cycle + k / n, end: cycle + (k + 1) / n, midi }]));
}

/** Word i on note onset i, in order; leftover notes rest; the phrase is whole cycles. */
export interface PlacedWord extends NoteStep {
  index: number;
}

export function layoutWords(wordCount: number, source: NoteSource): { placed: PlacedWord[]; cycles: number } {
  const placed: PlacedWord[] = [];
  let cycles = 1;
  for (let c = 0; c < SING_MAX_CYCLES && placed.length < wordCount; c++) {
    for (const step of source(c)) {
      if (placed.length >= wordCount) break;
      placed.push({ ...step, index: placed.length });
      cycles = c + 1;
    }
  }
  return { placed, cycles };
}

/** Grid the phrase is laid on (per cycle): divisible by 2, 3, 4, 5, 6, 8, 10, 12, 16. */
const TICKS = 960;

export interface SungSlice {
  /** Fractions of the clip (Strudel's begin/end controls). */
  begin: number;
  end: number;
  /** Playback rate: target pitch ÷ spoken pitch. */
  speed: number;
}

/** The Strudel functions a phrase is built with (the page's, or the validator's). */
export interface PhraseKit {
  sound(name: string): any;
  timecat(...pairs: Array<[number, unknown]>): any;
  silence: unknown;
}

/**
 * The phrase as ONE Strudel pattern: each placed word plays `slice(word)` of
 * the clip `name` at its note, silence between, `cycles` long.
 */
export function buildPhrase(
  kit: PhraseKit,
  name: string,
  layout: { placed: PlacedWord[]; cycles: number },
  slice: (word: PlacedWord) => SungSlice,
): any {
  const total = layout.cycles * TICKS;
  const pairs: Array<[number, unknown]> = [];
  let at = 0;
  for (const word of layout.placed) {
    const b = Math.max(at, Math.round(word.begin * TICKS));
    const e = Math.min(total, Math.max(b + 1, Math.round(word.end * TICKS)));
    if (b >= total) break;
    if (b > at) pairs.push([b - at, kit.silence]);
    const s = slice(word);
    pairs.push([e - b, kit.sound(name).begin(s.begin).end(s.end).speed(s.speed)]);
    at = e;
  }
  if (at < total) pairs.push([total - at, kit.silence]);
  const phrase = kit.timecat(...pairs);
  return layout.cycles > 1 ? phrase.slow(layout.cycles) : phrase;
}

export const midiToHz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

/** Slowest and fastest a word is played: two octaves either way. */
export const SING_MIN_SPEED = 0.25;
export const SING_MAX_SPEED = 4;

/**
 * Each word's speed onto its note. An unvoiced word takes the previous
 * word's pitch (or the line's median when it is the first).
 */
export function wordSpeeds(spokenHz: Array<number | null>, targetMidi: number[]): number[] {
  const voiced = spokenHz.filter((h): h is number => typeof h === "number" && h > 0).sort((a, b) => a - b);
  const fallback = voiced.length ? voiced[voiced.length >> 1] : null;
  let previous = fallback;
  return targetMidi.map((midi, i) => {
    const hz = spokenHz[i % spokenHz.length];
    const spoken = typeof hz === "number" && hz > 0 ? hz : previous;
    if (typeof hz === "number" && hz > 0) previous = hz;
    if (!spoken) return 1;
    return Math.min(SING_MAX_SPEED, Math.max(SING_MIN_SPEED, midiToHz(midi) / spoken));
  });
}
