import { AUDIO_ANALYSER, bandLevels, stepBands } from "../shared/audio-bands";
import * as widgetState from "./state";

interface AudioReactiveHost {
  replSection: HTMLElement;
  isHydraLive(): boolean;
}

/** The analyser owns its graph tap, animation loop, meter and eval globals. */
let replSection: AudioReactiveHost["replSection"];
let isHydraLive: AudioReactiveHost["isHydraLive"];

export function initAudioReactive(host: AudioReactiveHost): void {
  ({
    replSection, isHydraLive,
  } = host);
}

// =============================================================================
// Audio-reactive visuals — `a`, driven by Strudel's OWN output
//
// hydra-synth's `a` comes from `new Audio(...)`, which opens the MICROPHONE via
// getUserMedia and runs Meyda over it. @strudel/hydra passes `detectAudio:false`
// (so `a` is simply undefined in the REPL) — which is right: we do not want a
// permission prompt, and the mic hears the room, not the pattern.
//
// So we build the same object over an AnalyserNode tapped off the SAME master
// bus the recorder taps (`getSuperdoughAudioController().output.destinationGain`).
// Every hydra tutorial that reads `a.fft[0]`, `a0()`, `a.setBins(6)`,
// `a.setSmooth(...)`, `a.setCutoff(...)`, `a.setScale(...)`, `a.show()/hide()`
// works verbatim — but reacting to the music the widget is playing.
//
// Value semantics are ported from hydra-synth 1.4.0 src/lib/audio.js:
//   bins[i]  = raw[i] * (1 - smooth) + prevBins[i] * smooth
//   fft[i]   = max(0, (bins[i] - settings[i].cutoff) / settings[i].scale)
// with the same defaults (4 bins, cutoff 2, scale 10, smooth 0.4, max 15).
// The one deviation: hydra SUMS Meyda's bark-band loudness per band, which has
// no meaning for an FFT magnitude array, so `raw` here is the band's mean
// magnitude normalised 0..1 and then scaled by `max` into hydra's units — which
// is what puts a loud band near fft ≈ 1.3 and silence at 0, the range the
// cutoff/scale defaults were tuned for.
// =============================================================================

// 2048 → 1024 bins of ~23 Hz at 48 kHz, fine enough to give the kick its own
// band. (256 gave 187 Hz bins, so "band 0" ran 0–6 kHz and "band 1" 6–12 kHz —
// the guide's "bass band" was listening to hi-hats.)
const ANALYSER_FFT_SIZE = AUDIO_ANALYSER.fftSize;
const ANALYSER_SMOOTHING = AUDIO_ANALYSER.smoothing;
/** Musical range. The -100..-30 dB default squashes Strudel's output flat. */
const ANALYSER_MIN_DB = AUDIO_ANALYSER.minDecibels;
const ANALYSER_MAX_DB = AUDIO_ANALYSER.maxDecibels;
/** How long to keep looking for Hydra after a render asks for it. */
const ANALYSER_WAIT_MS = 20000;

interface AudioBandSetting {
  cutoff: number;
  scale: number;
  smooth: number;
}

interface StrudelAudioApi {
  vol: number;
  cutoff: number;
  scale: number;
  smooth: number;
  max: number;
  bins: number[];
  prevBins: number[];
  fft: number[];
  settings: AudioBandSetting[];
  isDrawing: boolean;
  setBins(count: number): void;
  setCutoff(value: number): void;
  setSmooth(value: number): void;
  setScale(value: number): void;
  setMax(value: number): void;
  show(): void;
  hide(): void;
  tick(): void;
}

let audioApi: StrudelAudioApi | null = null;
let analyserNode: AnalyserNode | null = null;
let analyserTapSource: AudioNode | null = null;
let analyserBytes: Uint8Array<ArrayBuffer> | null = null;
let analyserRaf: number | null = null;
let analyserDeadline = 0;
let audioMeterCanvas: HTMLCanvasElement | null = null;
/** `a0`…`aN` globals we installed, so teardown can take them back off. */
let installedBandGlobals: string[] = [];

/** Tap the master bus with an AnalyserNode. Idempotent; false until audio exists. */
function ensureAnalyser(): boolean {
  if (analyserNode) return true;
  try {
    // The AudioContext is lazy — it only exists once something has played.
    const ctx: AudioContext | undefined = (window as any).getAudioContext?.();
    if (!ctx) return false;
    const controller = (window as any).getSuperdoughAudioController?.();
    const master: AudioNode | undefined = controller?.output?.destinationGain;
    if (!master?.connect) return false;
    const node = ctx.createAnalyser();
    node.fftSize = ANALYSER_FFT_SIZE;
    node.smoothingTimeConstant = ANALYSER_SMOOTHING;
    node.minDecibels = ANALYSER_MIN_DB;
    node.maxDecibels = ANALYSER_MAX_DB;
    // Tap only: the analyser is never connected onward, so it reads the bus
    // without adding a second path to the speakers.
    master.connect(node);
    analyserTapSource = master;
    analyserNode = node;
    analyserBytes = new Uint8Array(node.frequencyBinCount);
    return true;
  } catch {
    return false;
  }
}

/** hydra-synth's debug meter, ported — `a.show()` draws the live band levels. */
function drawAudioMeter(api: StrudelAudioApi): void {
  if (!audioMeterCanvas) return;
  const ctx = audioMeterCanvas.getContext("2d");
  if (!ctx) return;
  const { width, height } = audioMeterCanvas;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#DFFFFF";
  const spacing = width / Math.max(1, api.bins.length);
  const scale = height / (api.max * 2);
  api.bins.forEach((bin, index) => {
    const barHeight = bin * scale;
    ctx.fillRect(index * spacing, height - barHeight, spacing - 1, barHeight);
  });
}

function createAudioApi(): StrudelAudioApi {
  const api: StrudelAudioApi = {
    vol: 0,
    cutoff: 2,
    scale: 10,
    smooth: 0.4,
    max: 15,
    bins: [],
    prevBins: [],
    fft: [],
    settings: [],
    isDrawing: false,

    setBins(count: number) {
      const n = Math.max(1, Math.floor(count) || 1);
      api.bins = new Array(n).fill(0);
      api.prevBins = new Array(n).fill(0);
      api.fft = new Array(n).fill(0);
      api.settings = new Array(n).fill(0).map(() => ({
        cutoff: api.cutoff,
        scale: api.scale,
        smooth: api.smooth,
      }));
      // hydra installs a0()…aN() alongside a.fft; tutorials use both forms.
      for (const name of installedBandGlobals) delete (window as any)[name];
      installedBandGlobals = [];
      for (let i = 0; i < n; i++) {
        const name = `a${i}`;
        (window as any)[name] = (scale = 1, offset = 0) => () => api.fft[i] * scale + offset;
        installedBandGlobals.push(name);
      }
    },

    setCutoff(value: number) {
      api.cutoff = value;
      api.settings = api.settings.map((s) => ({ ...s, cutoff: value }));
    },
    setSmooth(value: number) {
      api.smooth = value;
      api.settings = api.settings.map((s) => ({ ...s, smooth: value }));
    },
    setScale(value: number) {
      api.scale = value;
      api.settings = api.settings.map((s) => ({ ...s, scale: value }));
    },
    setMax(value: number) {
      api.max = value;
    },

    show() {
      api.isDrawing = true;
      if (!audioMeterCanvas) {
        const canvas = document.createElement("canvas");
        canvas.width = 100;
        canvas.height = 80;
        canvas.className = "audio-meter";
        replSection.appendChild(canvas);
        audioMeterCanvas = canvas;
      }
      audioMeterCanvas.style.display = "block";
    },
    hide() {
      api.isDrawing = false;
      if (audioMeterCanvas) audioMeterCanvas.style.display = "none";
    },

    tick() {
      const node = analyserNode;
      const bytes = analyserBytes;
      if (!node || !bytes) return;
      node.getByteFrequencyData(bytes);
      // Log-spaced bands, so fft[0] is the kick/sub band and fft[3] the hats —
      // not four equal slices of a linear spectrum (src/shared/audio-bands.ts).
      const levels = bandLevels(bytes, node.context.sampleRate, node.fftSize, api.bins.length);
      api.prevBins = api.bins.slice(0);
      api.vol = stepBands(levels, api.prevBins, api.settings, api.max, api.bins, api.fft);
      if (api.isDrawing) drawAudioMeter(api);
    },
  };
  api.setBins(4);
  return api;
}

/**
 * Publish `a` (and a0…a3) into the REPL's eval scope. Installed eagerly once an
 * editor exists, so a shader's `() => a.fft[0] * 4` never sees an undefined `a`
 * on Hydra's first frame — the analyser attaches later, and until it does the
 * bands simply read 0.
 */
export function installAudioReactiveGlobals(): void {
  if (!audioApi) audioApi = createAudioApi();
  (window as any).a = audioApi;
}

/**
 * Drive the band analysis. Runs while Hydra is up or the visuals backdrop is
 * showing — both can react to `a` (a shader, or a hand-drawn onPaint()). With
 * neither there is nothing to react, so the loop stops itself.
 */
export function startAnalyserLoop(): void {
  analyserDeadline = performance.now() + ANALYSER_WAIT_MS;
  if (analyserRaf !== null) return;
  const frame = (now: number) => {
    if (isHydraLive() || widgetState.vizVisible) {
      // Keep the window open while something can react; close it once not.
      analyserDeadline = now + 1000;
      if (analyserNode || ensureAnalyser()) audioApi?.tick();
    } else if (now > analyserDeadline) {
      analyserRaf = null;
      return;
    }
    analyserRaf = requestAnimationFrame(frame);
  };
  analyserRaf = requestAnimationFrame(frame);
}

function stopAnalyserLoop(): void {
  if (analyserRaf !== null) {
    cancelAnimationFrame(analyserRaf);
    analyserRaf = null;
  }
}

export function teardownAudioAnalyser(): void {
  stopAnalyserLoop();
  if (analyserTapSource && analyserNode) {
    try {
      (analyserTapSource as any).disconnect(analyserNode);
    } catch { /* edge may already be gone */ }
  }
  analyserTapSource = null;
  analyserNode = null;
  analyserBytes = null;
  for (const name of installedBandGlobals) delete (window as any)[name];
  installedBandGlobals = [];
  delete (window as any).a;
  audioApi = null;
  audioMeterCanvas?.remove();
  audioMeterCanvas = null;
}

export function hasAudioApi(): boolean { return audioApi !== null; }
