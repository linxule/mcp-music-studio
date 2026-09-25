// =============================================================================
// The room's settings and impulse-response math — pure (no Web Audio types),
// so the share page generator, which also runs on the worker, can inline them.
// The Web Audio half is src/room-reverb.ts.
// =============================================================================

export interface RoomSettings {
  /** Seconds for the tail to fall 60 dB (RT60). */
  seconds: number;
  /** Gap before the first reflection, in ms. */
  preDelayMs: number;
  /** Wet level relative to the dry signal. */
  wet: number;
  /** The tail is darker than the direct sound. */
  lowpassHz: number;
  /** PRNG seed for the noise, so the room is the same every time. */
  seed: number;
}

/**
 * `wet` is measured, not guessed: ConvolverNode normalizes the impulse
 * response, so the level after it is far below what the gain suggests. On a
 * 0.5 s decaying A4 (Chromium, OfflineAudioContext), the tail's first 100 ms
 * sat at −27 dB relative to the note with wet 0.22 (inaudible in practice), −20
 * at 0.5, −16 at 0.8, −13 at 1.2; the peak level never moved (the dry path
 * dominates). 0.7 ≈ −17 dB, falling to about −45 dB a second later: a light
 * room, not a hall.
 */
export const ROOM: RoomSettings = {
  seconds: 1.6,
  preDelayMs: 18,
  wet: 0.7,
  lowpassHz: 5200,
  seed: 0x5eed,
};

/** localStorage key for the viewer's Room choice (widget and share page). */
export const ROOM_PREF_KEY = "music-studio:room";

/** mulberry32: a tiny deterministic PRNG in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Samples of a stereo impulse response: independent noise per channel under an
 * exponential envelope that reaches −60 dB at `seconds`, with a few ms fade-in
 * so the onset doesn't click.
 */
export function impulseResponseChannels(
  sampleRate: number,
  settings: RoomSettings = ROOM,
): [Float32Array, Float32Array] {
  const length = Math.max(1, Math.floor(sampleRate * settings.seconds));
  const decayPerSecond = Math.log(1000) / settings.seconds; // −60 dB
  const attack = Math.max(1, Math.floor(sampleRate * 0.004));
  const random = seededRandom(settings.seed);
  const channels: [Float32Array, Float32Array] = [new Float32Array(length), new Float32Array(length)];
  for (let i = 0; i < length; i++) {
    const envelope = Math.exp((-decayPerSecond * i) / sampleRate) * Math.min(1, i / attack);
    channels[0][i] = (random() * 2 - 1) * envelope;
    channels[1][i] = (random() * 2 - 1) * envelope;
  }
  return channels;
}
