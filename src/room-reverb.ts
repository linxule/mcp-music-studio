// =============================================================================
// Room — a light reverb under the sheet-music synth
//
// abcjs renders every note at full level for its written length, then fades it
// out linearly over `fadeLength` (200 ms by default) straight into digital
// silence (abcjs/src/synth/place-note.js). With a style's rests between chord
// hits (`%%MIDI gchord fzcz`), that is a clipped stab and then nothing — no
// room, no decay. Two changes answer it: a longer release (NOTE_FADE_MS in
// src/music-logic.ts, a synth option) and this room.
//
// The impulse response is generated, not fetched: decaying stereo noise from a
// fixed seed, so the widget needs no new CSP domain and every run — live
// playback and the WAV export — hears the same room.
//
// Live playback: abcjs's `_kickOffSound()` connects its buffer sources straight
// to `ctx.destination`. `routeThroughRoom()` wraps it so those connections land
// on the room's input instead; the dry path still reaches the destination at
// full level, and the room adds a wet path. Toggling the room only moves the
// wet gain, so it needs no re-prime.
// =============================================================================

import {
  ROOM,
  impulseResponseChannels,
  type RoomSettings,
} from "./room-settings";

export { ROOM, ROOM_PREF_KEY, impulseResponseChannels, seededRandom, type RoomSettings } from "./room-settings";

function impulseResponse(ctx: BaseAudioContext, settings: RoomSettings): AudioBuffer {
  const [left, right] = impulseResponseChannels(ctx.sampleRate, settings);
  const buffer = ctx.createBuffer(2, left.length, ctx.sampleRate);
  buffer.getChannelData(0).set(left);
  buffer.getChannelData(1).set(right);
  return buffer;
}

export interface RoomGraph {
  /** Connect sources here. */
  input: GainNode;
  /** The wet path's level; 0 turns the room off. */
  wet: GainNode;
}

/** input → output (dry), and input → pre-delay → convolver → lowpass → wet → output. */
export function buildRoom(
  ctx: BaseAudioContext,
  output: AudioNode,
  { enabled = true, settings = ROOM }: { enabled?: boolean; settings?: RoomSettings } = {},
): RoomGraph {
  const input = ctx.createGain();
  input.connect(output);

  const preDelay = ctx.createDelay(1);
  preDelay.delayTime.value = settings.preDelayMs / 1000;
  const convolver = ctx.createConvolver();
  convolver.buffer = impulseResponse(ctx, settings);
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = settings.lowpassHz;
  const wet = ctx.createGain();
  wet.gain.value = enabled ? settings.wet : 0;

  input.connect(preDelay);
  preDelay.connect(convolver);
  convolver.connect(lowpass);
  lowpass.connect(wet);
  wet.connect(output);
  return { input, wet };
}

/**
 * The live room for the widget. Built lazily, once per AudioContext, and left
 * connected: an idle convolver costs next to nothing.
 */
export class LiveRoom {
  private graphs = new WeakMap<BaseAudioContext, RoomGraph>();
  private enabled: boolean;

  constructor(enabled = true, private readonly settings: RoomSettings = ROOM) {
    this.enabled = enabled;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** The node abcjs's sources should connect to, for `ctx`. */
  inputFor(ctx: AudioContext): AudioNode {
    let graph = this.graphs.get(ctx);
    if (!graph) {
      graph = buildRoom(ctx, ctx.destination, { enabled: this.enabled, settings: this.settings });
      this.graphs.set(ctx, graph);
    }
    return graph.input;
  }

  /** Turn the wet path on or off; `ctx` is the one playing, if any. */
  setEnabled(enabled: boolean, ctx?: AudioContext | null): void {
    this.enabled = enabled;
    const graph = ctx ? this.graphs.get(ctx) : undefined;
    if (!graph || !ctx) return;
    // A short glide, so switching mid-note doesn't click.
    graph.wet.gain.setTargetAtTime(enabled ? this.settings.wet : 0, ctx.currentTime, 0.03);
  }
}

/** The slice of abcjs's internal CreateSynth that playback goes through. */
interface KickOff {
  _kickOffSound?: (seconds: number) => void;
}

const routed = new WeakSet<object>();

/**
 * Make abcjs's playback sources connect to `inputFor(ctx)` instead of
 * `ctx.destination`. Idempotent per midiBuffer; abcjs keeps one per
 * controller, so calling this from `onReady` (after every `go()`) is enough.
 *
 * `_kickOffSound` creates, connects and starts its sources synchronously, so
 * shadowing `createBufferSource` on the context for exactly that call reroutes
 * the connection BEFORE `start()` — nothing plays dry for a render quantum.
 */
export function routeThroughRoom(
  midiBuffer: unknown,
  context: () => AudioContext | null,
  inputFor: (ctx: AudioContext) => AudioNode,
): boolean {
  const target = midiBuffer as KickOff | null;
  if (!target || typeof target._kickOffSound !== "function") return false;
  if (routed.has(target)) return true;
  routed.add(target);
  const original = target._kickOffSound;
  target._kickOffSound = function (this: unknown, seconds: number) {
    const ctx = context();
    if (!ctx) return original.call(this, seconds);
    let input: AudioNode;
    try {
      input = inputFor(ctx);
    } catch {
      return original.call(this, seconds);
    }
    const own = Object.prototype.hasOwnProperty.call(ctx, "createBufferSource");
    const previous = ctx.createBufferSource;
    ctx.createBufferSource = function (this: AudioContext) {
      const source = previous.call(this);
      const connect = source.connect.bind(source) as (...args: unknown[]) => unknown;
      (source as { connect: unknown }).connect = (node: unknown, ...rest: unknown[]) =>
        connect(node === ctx.destination ? input : node, ...rest);
      return source;
    };
    try {
      return original.call(this, seconds);
    } finally {
      if (own) ctx.createBufferSource = previous;
      else delete (ctx as { createBufferSource?: unknown }).createBufferSource;
    }
  };
  return true;
}

/**
 * Render `buffer` through the same room offline, with room for the tail — for
 * the WAV export, so the file sounds like the playback.
 */
export async function renderWithRoom(
  buffer: AudioBuffer,
  settings: RoomSettings = ROOM,
): Promise<AudioBuffer> {
  const OfflineCtx =
    globalThis.OfflineAudioContext ??
    (globalThis as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  if (!OfflineCtx) return buffer;
  const channels = Math.max(2, buffer.numberOfChannels);
  const tail = Math.ceil((settings.seconds + settings.preDelayMs / 1000) * buffer.sampleRate);
  const offline = new OfflineCtx(channels, buffer.length + tail, buffer.sampleRate);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  const room = buildRoom(offline, offline.destination, { enabled: true, settings });
  source.connect(room.input);
  source.start(0);
  return offline.startRendering();
}
