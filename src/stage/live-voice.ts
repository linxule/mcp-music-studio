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
 * `RELEASE_S` (a damper, not a cut). A sample that is not cached yet is
 * fetched first; `preload()` fetches a range ahead, when someone joins.
 */
import ABCJS from "abcjs";
import getNote from "abcjs/src/synth/load-note.js";
import pitchToNoteName from "abcjs/src/synth/pitch-to-note-name.js";

/** How long a let-go note takes to fade (a piano's damper is about this). */
export const RELEASE_S = 0.25;
/** abcjs's volume curve (place-note.js): gain = volume / 96 × the bank's multiplier. */
const VOLUME_DIVISOR = 96;

interface Sounding {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

export interface LiveVoiceHost {
  context(): AudioContext | null;
  /** Where the dry signal goes: the Room's input, or the destination. */
  output(ctx: AudioContext): AudioNode;
  /** The current bank: `soundFontUrl` and `soundFontVolumeMultiplier`. */
  bank(): { url: string; multiplier: number };
}

export class LiveVoice {
  private sounding = new Map<string, Sounding>();
  /** Presses whose sample is still loading: released before it arrived = never sound. */
  private pending = new Map<string, number>();
  private serial = 0;

  constructor(private readonly host: LiveVoiceHost) {}

  private sample(program: number, pitch: number): Promise<AudioBuffer> | null {
    const ctx = this.host.context();
    const name = (pitchToNoteName as Record<number, string>)[pitch];
    const instrument = ABCJS.synth.instrumentIndexToName[program];
    if (!ctx || !name || !instrument) return null;
    return (getNote(this.host.bank().url, instrument, name, ctx) as Promise<{ audioBuffer: AudioBuffer }>).then((r) => r.audioBuffer);
  }

  /** Fetch the samples for `low…high` on `program` now, so the first press is instant. */
  preload(program: number, low: number, high: number): Promise<void> {
    const all: Promise<unknown>[] = [];
    for (let p = Math.max(21, low); p <= Math.min(108, high); p++) {
      const s = this.sample(program, p);
      if (s) all.push(s.catch(() => undefined));
    }
    return Promise.all(all).then(() => undefined);
  }

  /** Start `pitch` on `program`. `velocity` 1–127, as MIDI. */
  noteOn(program: number, pitch: number, velocity = 90): void {
    const id = `${program}:${pitch}`;
    this.noteOff(program, pitch, 0.03);
    const serial = ++this.serial;
    this.pending.set(id, serial);
    const sample = this.sample(program, pitch);
    if (!sample) return;
    void sample.then((buffer) => {
      if (this.pending.get(id) !== serial) return;
      this.pending.delete(id);
      const ctx = this.host.context();
      if (!ctx) return;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = (velocity / VOLUME_DIVISOR) * this.host.bank().multiplier;
      source.connect(gain).connect(this.host.output(ctx));
      source.start();
      source.onended = () => {
        if (this.sounding.get(id)?.source === source) this.sounding.delete(id);
        gain.disconnect();
      };
      this.sounding.set(id, { source, gain });
    }).catch(() => this.pending.delete(id));
  }

  /** Let `pitch` go: it fades over `release` seconds. */
  noteOff(program: number, pitch: number, release = RELEASE_S): void {
    const id = `${program}:${pitch}`;
    this.pending.delete(id);
    const s = this.sounding.get(id);
    if (!s) return;
    this.sounding.delete(id);
    const ctx = s.source.context;
    const now = ctx.currentTime;
    s.gain.gain.cancelScheduledValues(now);
    s.gain.gain.setValueAtTime(s.gain.gain.value, now);
    s.gain.gain.linearRampToValueAtTime(0, now + release);
    try { s.source.stop(now + release + 0.02); } catch { /* already stopped */ }
  }

  allOff(): void {
    this.pending.clear();
    for (const id of [...this.sounding.keys()]) {
      const [program, pitch] = id.split(":").map(Number);
      this.noteOff(program, pitch);
    }
  }

  get count(): number {
    return this.sounding.size;
  }
}
