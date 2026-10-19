/**
 * @file Where the Stage's players come from in the sheet widget: abcjs's own
 * audio, read at two moments.
 *
 *  - **Engraved** (`playersFromTune`): before anything plays, so the band is
 *    on stage as soon as the score is. `tune.setUpAudio()` flattens the tune
 *    exactly as the synth will (style preset, program override, voicesOff);
 *    the click-to-hear path already calls it on demand, so it is safe to call
 *    between primes (it only refreshes `midiPitches` on the notes).
 *  - **Primed** (`playersFromBuffer`): `cursorControl.onReady` hands over the
 *    controller after every `go()`. Its buffer holds the flattened sequence it
 *    rendered and the tempo it rendered it at (`millisecondsPerMeasure`
 *    includes the % field), and — when swing is set — the swung note map the
 *    widget captured through `sequenceCallback` (kept as `stage` beside the
 *    `swung` copy that `followSwing` consumes).
 */
import type ABCJS from "abcjs";
import { noteMapFromSequence, playersFrom, type MapNote, type Player } from "./stage-model";

type Tracks = readonly (readonly Record<string, unknown>[])[];

/** Whole notes per measure (3/4 → 0.75); 1 when the tune has no meter. */
function meterWholeNotes(tune: ABCJS.TuneObject): number {
  const meter = tune.getMeterFraction();
  return meter?.den ? meter.num / meter.den : 1;
}

export interface StageFeed {
  players: Player[];
  /** One beat, for how far ahead "next" looks. */
  beatSeconds: number;
}

export function playersFromTune(tune: ABCJS.TuneObject, options: Record<string, unknown>): StageFeed | null {
  const flat = tune.setUpAudio(options as ABCJS.SynthOptions) as unknown as { tracks?: Tracks; tempo?: number };
  if (!flat?.tracks) return null;
  // The tempo go() primes at: millisecondsPerMeasure() with no argument (its
  // getBpm() default for 6/8 differs from the sequencer's own 180-qpm default).
  const wholeSeconds = tune.millisecondsPerMeasure() / 1000 / meterWholeNotes(tune);
  return { players: playersFrom(noteMapFromSequence(flat.tracks), wholeSeconds), beatSeconds: beatOf(tune, wholeSeconds) };
}

interface BufferInternals {
  flattened?: { tracks?: Tracks };
  millisecondsPerMeasure?: number;
  meterSize?: number;
  callbackContext?: { stage?: MapNote[][] | null };
}

export function playersFromBuffer(controller: unknown, tune: ABCJS.TuneObject | undefined): StageFeed | null {
  const buffer = (controller as { midiBuffer?: BufferInternals } | null)?.midiBuffer;
  const tracks = buffer?.flattened?.tracks;
  const ms = buffer?.millisecondsPerMeasure;
  if (!tracks || !(typeof ms === "number" && ms > 0)) return null;
  const wholeSeconds = ms / 1000 / (buffer.meterSize && buffer.meterSize > 0 ? buffer.meterSize : 1);
  const map = buffer.callbackContext?.stage ?? noteMapFromSequence(tracks);
  return { players: playersFrom(map, wholeSeconds), beatSeconds: tune ? beatOf(tune, wholeSeconds) : wholeSeconds / 4 };
}

/** A beat: the meter's denominator, or a dotted quarter in 6/8-style compound time. */
function beatOf(tune: ABCJS.TuneObject, wholeSeconds: number): number {
  const meter = tune.getMeterFraction();
  const den = meter?.den || 4;
  const compound = den === 8 && meter.num % 3 === 0 && meter.num > 3;
  return (wholeSeconds / den) * (compound ? 3 : 1);
}
