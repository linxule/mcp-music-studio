/**
 * @file Playing along: notes that sound while held, several at once, from the
 * same samples the score plays (abcjs's sample cache, through its own loader,
 * so the current Sound bank and anything already fetched are shared).
 *
 * `auditionNote()` renders a fixed-length note through CreateSynth, and a new
 * one cuts the last — right for "what does this note sound like", wrong for a
 * person playing a part: a held key must ring until it is let go, a chord must
 * sound together, and a press must sound at once. So a press here is a buffer
 * source on the live context: start now, and on release fade over
 * `RELEASE_S` (a damper, not a cut).
 *
 * - **Holds are counted per pitch.** The same note held from two places (a
 *   letter and the mouse, MIDI and a letter, two overlapping rows) sounds
 *   until the last of them lets go; a new press re-strikes it.
 * - **A sample not fetched yet is fetched first.** A press released before it
 *   arrives still sounds, briefly, if the sample comes within `LATE_S` — a
 *   quick tap on an uncached key is not silent. `preload()` warms a range.
 */
import ABCJS from "abcjs";
import getNote from "abcjs/src/synth/load-note.js";
import pitchToNoteName from "abcjs/src/synth/pitch-to-note-name.js";

/** How long a let-go note takes to fade (a piano's damper is about this). */
export const RELEASE_S = 0.25;
/** A press released before its sample arrived still sounds if the sample comes within this. */
const LATE_S = 1;
/** How long such a late, already-released press sounds before it fades. */
const LATE_HOLD_S = 0.15;
/** abcjs's volume curve (place-note.js): gain = volume / 96 × the bank's multiplier. */
const VOLUME_DIVISOR = 96;
/** Samples fetched at once while warming a range. */
const PRELOAD_CONCURRENCY = 6;

/**
 * abcjs 6.7.1's onset offsets for its original bank (create-synth.js,
 * `originalSoundFontUrl`): those samples start with silence, which the score's
 * renderer skips (place-note.js `start(0, ofsMs / 1000)`); a pressed note must
 * skip the same or it lands late. Other banks have none. (abcjs, MIT.)
 */
const ORIGINAL_BANK_OFFSETS_MS: Record<string, number> = {
  bright_acoustic_piano: 20, honkytonk_piano: 20, electric_piano_1: 30, electric_piano_2: 30,
  harpsichord: 40, clavinet: 20, celesta: 20, glockenspiel: 40, vibraphone: 30, marimba: 35,
  xylophone: 30, tubular_bells: 35, dulcimer: 30, drawbar_organ: 20, percussive_organ: 25,
  rock_organ: 20, church_organ: 40, reed_organ: 40, accordion: 40, harmonica: 40,
  acoustic_guitar_nylon: 20, acoustic_guitar_steel: 30, electric_guitar_jazz: 25,
  electric_guitar_clean: 15, electric_guitar_muted: 35, overdriven_guitar: 25, distortion_guitar: 20,
  guitar_harmonics: 30, electric_bass_finger: 15, electric_bass_pick: 30, fretless_bass: 40,
  violin: 105, viola: 50, cello: 40, contrabass: 60, trumpet: 10, trombone: 90, alto_sax: 20,
  tenor_sax: 20, clarinet: 20, flute: 50, banjo: 50, woodblock: 20,
};
const ORIGINAL_BANK = /\/midi-js-soundfonts\/abcjs\/$/;

interface Voice {
  /** Presses holding this pitch now. */
  holds: number;
  /** The latest press; an arriving sample for an older one is dropped. */
  serial: number;
  /** When the latest press came (performance.now). */
  at: number;
  sounding?: { source: AudioBufferSourceNode; gain: GainNode };
}

export interface LiveVoiceHost {
  context(): AudioContext | null;
  /** Where the dry signal goes: the Room's input, or the destination. */
  output(ctx: AudioContext): AudioNode;
  /** The current bank: `soundFontUrl` and `soundFontVolumeMultiplier`. */
  bank(): { url: string; multiplier: number };
}

export class LiveVoice {
  private voices = new Map<string, Voice>();
  private serial = 0;

  constructor(private readonly host: LiveVoiceHost) {}

  private sample(program: number, pitch: number): Promise<AudioBuffer> | null {
    const ctx = this.host.context();
    const name = (pitchToNoteName as Record<number, string>)[pitch];
    const instrument = ABCJS.synth.instrumentIndexToName[program];
    if (!ctx || !name || !instrument) return null;
    return (getNote(this.host.bank().url, instrument, name, ctx) as Promise<{ audioBuffer: AudioBuffer }>).then((r) => r.audioBuffer);
  }

  /** Whether `pitch` has a sample at all (abcjs banks run A0–C8). */
  static playable(pitch: number): boolean {
    return Boolean((pitchToNoteName as Record<number, string>)[pitch]);
  }

  /** Fetch the samples for `low…high` on `program`, a few at a time, so later presses are instant. */
  async preload(program: number, low: number, high: number): Promise<void> {
    const queue: number[] = [];
    for (let p = Math.max(21, Math.round(low)); p <= Math.min(108, Math.round(high)); p++) queue.push(p);
    const worker = async () => {
      for (let p = queue.shift(); p !== undefined; p = queue.shift()) await this.sample(program, p)?.catch(() => undefined);
    };
    await Promise.all(Array.from({ length: PRELOAD_CONCURRENCY }, worker));
  }

  /** Press `pitch` on `program`. `velocity` 1–127, as MIDI. Every noteOn wants one noteOff. */
  noteOn(program: number, pitch: number, velocity = 90): void {
    const id = `${program}:${pitch}`;
    let v = this.voices.get(id);
    if (!v) this.voices.set(id, (v = { holds: 0, serial: 0, at: 0 }));
    const voice = v;
    voice.holds++;
    const serial = (voice.serial = ++this.serial);
    voice.at = performance.now();
    const sample = this.sample(program, pitch);
    if (!sample) {
      voice.holds--;
      this.forget(id, voice);
      return;
    }
    void sample.then((buffer) => {
      if (voice.serial !== serial) return; // a newer press of this pitch took over
      const late = voice.holds === 0;
      if (late && performance.now() - voice.at > LATE_S * 1000) return this.forget(id, voice);
      const ctx = this.host.context();
      if (!ctx) return;
      // A re-strike: the ringing note gives way quickly to the new one.
      if (voice.sounding) this.fade(voice.sounding, 0.03);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = (velocity / VOLUME_DIVISOR) * this.host.bank().multiplier;
      source.connect(gain).connect(this.host.output(ctx));
      const instrument = ABCJS.synth.instrumentIndexToName[program] ?? "";
      const offset = ORIGINAL_BANK.test(this.host.bank().url) ? (ORIGINAL_BANK_OFFSETS_MS[instrument] ?? 0) / 1000 : 0;
      source.start(0, offset);
      const sounding = { source, gain };
      voice.sounding = sounding;
      source.onended = () => {
        gain.disconnect();
        if (voice.sounding === sounding) {
          voice.sounding = undefined;
          this.forget(id, voice);
        }
      };
      if (late) {
        voice.sounding = undefined;
        this.fade(sounding, RELEASE_S, LATE_HOLD_S);
        this.forget(id, voice);
      }
    }).catch(() => {
      if (voice.serial === serial) this.forget(id, voice);
    });
  }

  /** Let go of one press of `pitch`: when no press holds it any more it fades over `RELEASE_S`. */
  noteOff(program: number, pitch: number): void {
    const id = `${program}:${pitch}`;
    const v = this.voices.get(id);
    if (!v || v.holds === 0) return;
    v.holds--;
    if (v.holds > 0 || !v.sounding) return;
    this.fade(v.sounding, RELEASE_S);
    v.sounding = undefined;
  }

  allOff(): void {
    for (const v of this.voices.values()) {
      v.holds = 0;
      v.serial = ++this.serial; // samples still on their way are dropped
      if (v.sounding) this.fade(v.sounding, RELEASE_S);
      v.sounding = undefined;
    }
    this.voices.clear();
  }

  /** How many pitches are sounding now. */
  get count(): number {
    let n = 0;
    for (const v of this.voices.values()) if (v.sounding) n++;
    return n;
  }

  private fade(s: { source: AudioBufferSourceNode; gain: GainNode }, release: number, after = 0): void {
    const now = s.source.context.currentTime;
    const g = s.gain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now + after);
    g.linearRampToValueAtTime(0, now + after + release);
    try { s.source.stop(now + after + release + 0.02); } catch { /* already stopped */ }
  }

  private forget(id: string, v: Voice): void {
    if (v.holds === 0 && !v.sounding && this.voices.get(id) === v) this.voices.delete(id);
  }
}
