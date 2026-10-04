/**
 * @file Sound one clicked note through the widget's own synth settings.
 *
 * Built on the same parts as `ABCJS.synth.playEvent()` (a SynthSequence fed to
 * a fresh CreateSynth), not on playEvent itself, which differs from the tune's
 * own playback in three ways (abcjs 6.7.1 play-event.js / create-synth.js):
 * it passes only `soundFontUrl`, so `fadeLength` falls back to abcjs's 200 ms
 * clip instead of the widget's 500 ms release and the bank's volume
 * multiplier is guessed from its URL; it connects straight to the destination,
 * past the Room; and it hands CreateSynth the tune's milliseconds per MEASURE,
 * which a sequence (meterSize 1) reads as milliseconds per WHOLE NOTE — so in
 * any meter but 4/4 the note's length is off (3/4 and 6/8: three quarters as
 * long, 2/4: half). Grace notes follow the tune's playback too
 * (abc_midi_flattener.js writeGraceNotes): played once, each its written
 * length, and every chord tone starts after them — playEvent gives each grace
 * 1/64 and puts them in front of the first chord tone only, so the others
 * sound with the graces.
 */
import ABCJS from "abcjs";

/** A clicked element's sounding pitches (abcjs `abcelem.midiPitches`). */
export interface AuditionPitch {
  pitch: number;
  /** Whole notes. */
  duration: number;
  volume: number;
  instrument: number;
  cents?: number;
}

/** A clicked element's grace notes (abcjs `abcelem.midiGraceNotePitches`). */
export interface AuditionGrace {
  pitch: number;
  /** Whole notes. abcjs makes the graces fill half the main note's length. */
  durationInMeasures: number;
  volume: number;
  cents?: number;
}

export interface AuditionRequest {
  pitches: readonly AuditionPitch[];
  graces?: readonly AuditionGrace[];
  /** Milliseconds per whole note at the current tempo. */
  msPerWholeNote: number;
  synthOptions: Record<string, unknown>;
  /** Route the new buffer's output (the Room), before it starts. */
  route?(midiBuffer: unknown): void;
}

/** A clicked note sounds at most this long, however long it is written. */
export const AUDITION_MAX_SECONDS = 1.5;
/** A muted voice's notes carry volume 0 in the last prime; sound them anyway. */
const AUDITION_FALLBACK_VOLUME = 80;

interface Startable {
  init(params: unknown): Promise<unknown>;
  prime(): Promise<unknown>;
  start(): void;
  stop(): unknown;
}

/** Generation of the newest audition; {@link stopAudition} bumps it too. */
let latest = 0;
let sounding: Startable | null = null;

/** Sound `request`; a newer audition (or {@link stopAudition}) cuts this one off. */
export async function auditionNote(request: AuditionRequest): Promise<boolean> {
  const id = ++latest;
  if (request.pitches.length === 0 || !(request.msPerWholeNote > 0)) return false;
  const maxWhole = (AUDITION_MAX_SECONDS * 1000) / request.msPerWholeNote;
  const sequence = new ABCJS.synth.SynthSequence();
  // The track's write position (abcjs 6.7.1 synth-sequence.js `starts`); the
  // typed API has no rest, and a chord tone must wait for the graces.
  const startAt = (track: number, wholeNotes: number) => {
    (sequence as unknown as { starts: number[] }).starts[track] = wholeNotes;
  };
  const graces = request.graces ?? [];
  const written = graces.reduce((sum, grace) => sum + (grace.durationInMeasures > 0 ? grace.durationInMeasures : 0), 0);
  // Graces take at most half the audition, like they take half the note.
  const scale = written > maxWhole / 2 ? maxWhole / 2 / written : 1;
  let graceLength = 0;
  if (graces.length > 0 && written > 0) {
    const track = sequence.addTrack() as unknown as number; // typed AudioTrack; returns the index
    sequence.setInstrument(track, request.pitches[0].instrument);
    for (const grace of graces) {
      if (!(grace.durationInMeasures > 0)) continue;
      const length = grace.durationInMeasures * scale;
      sequence.appendNote(track, grace.pitch, length, grace.volume || AUDITION_FALLBACK_VOLUME, grace.cents ?? 0);
      graceLength += length;
    }
  }
  request.pitches.forEach((note) => {
    const track = sequence.addTrack() as unknown as number;
    sequence.setInstrument(track, note.instrument);
    if (graceLength > 0) startAt(track, graceLength);
    sequence.appendNote(
      track,
      note.pitch,
      Math.min(note.duration, maxWhole - graceLength),
      note.volume || AUDITION_FALLBACK_VOLUME,
      note.cents ?? 0,
    );
  });
  const buffer = new ABCJS.synth.CreateSynth() as unknown as Startable;
  await buffer.init({
    sequence,
    millisecondsPerMeasure: request.msPerWholeNote,
    options: request.synthOptions,
  });
  if (id !== latest) return discard(buffer);
  await buffer.prime();
  if (id !== latest) return discard(buffer);
  request.route?.(buffer);
  silenceSounding();
  buffer.start();
  sounding = buffer;
  return true;
}

/** Release a buffer an audition abandoned before it started. */
function discard(buffer: Startable): false {
  try {
    buffer.stop();
  } catch {
    // Never started.
  }
  return false;
}

function silenceSounding(): void {
  try {
    sounding?.stop();
  } catch {
    // Already ended.
  }
  sounding = null;
}

/**
 * Silence the last clicked note, if it is still ringing, and cancel one still
 * loading: it discards itself after its `init`/`prime` instead of starting.
 */
export function stopAudition(): void {
  latest++;
  silenceSounding();
}
