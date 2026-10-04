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
 * long, 2/4: half).
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

export interface AuditionRequest {
  pitches: readonly AuditionPitch[];
  graces?: readonly AuditionPitch[];
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

let latest = 0;
let sounding: Startable | null = null;

/** Sound `request`; a newer audition (or {@link stopAudition}) cuts this one off. */
export async function auditionNote(request: AuditionRequest): Promise<boolean> {
  const id = ++latest;
  if (request.pitches.length === 0 || !(request.msPerWholeNote > 0)) return false;
  const maxWhole = (AUDITION_MAX_SECONDS * 1000) / request.msPerWholeNote;
  const sequence = new ABCJS.synth.SynthSequence();
  request.pitches.forEach((note, i) => {
    const track = sequence.addTrack() as unknown as number; // typed AudioTrack; returns the index
    sequence.setInstrument(track, note.instrument);
    if (i === 0) {
      for (const grace of request.graces ?? []) {
        sequence.appendNote(track, grace.pitch, 1 / 64, grace.volume || AUDITION_FALLBACK_VOLUME, grace.cents ?? 0);
      }
    }
    sequence.appendNote(
      track,
      note.pitch,
      Math.min(note.duration, maxWhole),
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
  await buffer.prime();
  if (id !== latest) return false;
  request.route?.(buffer);
  stopAudition();
  buffer.start();
  sounding = buffer;
  return true;
}

/** Silence the last clicked note, if it is still ringing. */
export function stopAudition(): void {
  try {
    sounding?.stop();
  } catch {
    // Already ended.
  }
  sounding = null;
}
