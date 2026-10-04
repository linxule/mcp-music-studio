// =============================================================================
// sing() signal processing — how high a spoken word is, and where it starts
//
// sing(line, notes) plays one rendered line word by word, each word sped up or
// slowed down onto a note. The speed is target ÷ spoken pitch, so the spoken
// pitch must be measured: YIN (de Cheveigné & Kawahara, 2002) every 10 ms
// across each word, and the energy-weighted median of those windows — the
// pitch its loud part sits at. Whisper's word boundaries can be off by
// a couple of hundred milliseconds, so each start is moved to the nearest
// energy onset — a word then lands ON its note instead of a breath before it.
//
// Pure (plain arrays, no Web Audio): the widget and the share page run it on a
// decoded clip; tests run it on synthetic signals.
// =============================================================================

export interface PitchOptions {
  minHz?: number;
  maxHz?: number;
  /** YIN's absolute threshold on the cumulative mean normalized difference. */
  threshold?: number;
}

/** Speech pitch range searched (a deep male voice to a high child's). */
export const PITCH_MIN_HZ = 60;
export const PITCH_MAX_HZ = 600;
const YIN_THRESHOLD = 0.2;
/** Pitch is measured at ≈16 kHz: ample for 600 Hz, and 9× less work at 48 kHz. */
const ANALYSIS_RATE = 16_000;

/** Box-filter decimation by an integer factor (the average is the anti-alias). */
function decimate(samples: Float32Array, factor: number): Float32Array {
  if (factor <= 1) return samples;
  const out = new Float32Array(Math.floor(samples.length / factor));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (let k = 0; k < factor; k++) sum += samples[i * factor + k];
    out[i] = sum / factor;
  }
  return out;
}

/**
 * YIN on one window starting at `offset`: the fundamental in Hz, or null when
 * the window isn't periodic enough (unvoiced, silence).
 */
export function yin(
  samples: Float32Array,
  sampleRate: number,
  offset: number,
  windowSize: number,
  { minHz = PITCH_MIN_HZ, maxHz = PITCH_MAX_HZ, threshold = YIN_THRESHOLD }: PitchOptions = {},
): number | null {
  const tauMin = Math.max(2, Math.floor(sampleRate / maxHz));
  const tauMax = Math.min(Math.ceil(sampleRate / minHz), samples.length - offset - windowSize);
  if (tauMax <= tauMin + 2) return null;
  const d = new Float64Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    for (let i = 0; i < windowSize; i++) {
      const delta = samples[offset + i] - samples[offset + i + tau];
      sum += delta * delta;
    }
    d[tau] = sum;
  }
  // Cumulative mean normalized difference.
  const cmnd = new Float64Array(tauMax + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    running += d[tau];
    cmnd[tau] = running > 0 ? (d[tau] * tau) / running : 1;
  }
  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (cmnd[t] < threshold) {
      // Walk down to the local minimum.
      while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) return null;
  // Parabolic interpolation around the minimum.
  let refined = tau;
  if (tau > 1 && tau < tauMax) {
    const a = cmnd[tau - 1];
    const b = cmnd[tau];
    const c = cmnd[tau + 1];
    const denom = a - 2 * b + c;
    if (denom !== 0) refined = tau + (a - c) / (2 * denom);
  }
  return sampleRate / refined;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** One measured window: its pitch and its energy (sum of squares). */
export interface PitchWindow {
  hz: number;
  energy: number;
  /** Where the window starts, seconds into the span it was measured on. */
  at: number;
}

/**
 * How a word's windows become ONE pitch. A spoken word glides (Aura-2's
 * "deep" rose 208 → 278 Hz) and its quiet edges are where YIN is least sure,
 * so the plain median of six windows in a word's middle swung by up to a
 * semitone between slices a few milliseconds apart (Chromium and WebKit
 * decode the clip slightly differently; measured over 9 Aura-2 lines × 15
 * slice shifts of ±20 ms: plain median spread 58¢ median / 466¢ worst,
 * dense energy-weighted 7¢ / 99¢). `weighted`: the energy-weighted median — the pitch
 * the loud part of the word sits at, which is what is heard. `loudest`: the
 * median of the loudest 40% of windows. `median`: the plain median (≤ 0.12).
 */
export type PitchAnchor = "weighted" | "loudest" | "median";
export const DEFAULT_PITCH_ANCHOR: PitchAnchor = "weighted";

export function anchorPitch(windows: PitchWindow[], anchor: PitchAnchor = DEFAULT_PITCH_ANCHOR): number | null {
  if (!windows.length) return null;
  if (anchor === "median") return median(windows.map((w) => w.hz));
  if (anchor === "loudest") {
    const loud = [...windows].sort((a, b) => b.energy - a.energy).slice(0, Math.max(1, Math.ceil(windows.length * 0.4)));
    return median(loud.map((w) => w.hz));
  }
  const byHz = [...windows].sort((a, b) => a.hz - b.hz);
  const total = byHz.reduce((n, w) => n + w.energy, 0);
  if (!(total > 0)) return median(byHz.map((w) => w.hz));
  let acc = 0;
  for (const w of byHz) {
    acc += w.energy;
    if (acc >= total / 2) return w.hz;
  }
  return byHz[byHz.length - 1].hz;
}

/** Hop between pitch windows. Dense, so a short word still gets several. */
const HOP_SECONDS = 0.01;

/**
 * The voiced windows of `samples[from, to)` (seconds), at ≈16 kHz: 40 ms
 * windows every 10 ms across the WHOLE span (25 ms windows when 40 ms don't
 * fit — 0.08 s of voice is common). The whole span, not its middle: a word's
 * pitch can jump (Aura-2 asteria's "deep." sat at 178 Hz, then at 266–275 Hz,
 * twice as loud), and the energy weighting, not the slice, decides which part
 * counts.
 */
export function pitchWindows(
  samples: Float32Array,
  sampleRate: number,
  from = 0,
  to = samples.length / sampleRate,
  options: PitchOptions & { hopSeconds?: number } = {},
): PitchWindow[] {
  const factor = Math.max(1, Math.floor(sampleRate / ANALYSIS_RATE));
  const rate = sampleRate / factor;
  const tauMax = Math.ceil(rate / (options.minHz ?? PITCH_MIN_HZ));
  const a = Math.max(0, Math.floor(from * sampleRate));
  const b = Math.min(samples.length, Math.ceil(to * sampleRate));
  if (b <= a) return [];
  const region = decimate(samples.subarray(a, b), factor);
  let windowSize = Math.round(rate * 0.04);
  if (region.length < windowSize + tauMax + 1) windowSize = Math.round(rate * 0.025);
  const need = windowSize + tauMax + 1;
  const hop = Math.max(1, Math.round(rate * (options.hopSeconds ?? HOP_SECONDS)));
  const out: PitchWindow[] = [];
  for (let at = 0; at + need <= region.length; at += hop) {
    const hz = yin(region, rate, at, windowSize, options);
    if (hz === null) continue;
    let energy = 0;
    for (let i = at; i < at + windowSize; i++) energy += region[i] * region[i];
    out.push({ hz, energy, at: at / rate });
  }
  return out;
}

/**
 * The pitch of `samples[from, to)` (seconds) in Hz — see pitchWindows and
 * PitchAnchor. Null when no window is voiced.
 */
export function detectPitch(
  samples: Float32Array,
  sampleRate: number,
  from = 0,
  to = samples.length / sampleRate,
  options: PitchOptions & { anchor?: PitchAnchor; hopSeconds?: number } = {},
): number | null {
  return anchorPitch(pitchWindows(samples, sampleRate, from, to, options), options.anchor);
}

/** RMS of 10 ms frames over [from, to) seconds; frame k starts at from + k·10 ms. */
function rmsFrames(samples: Float32Array, sampleRate: number, from: number, to: number): number[] {
  const hop = Math.max(1, Math.round(sampleRate * 0.01));
  const out: number[] = [];
  for (let a = Math.round(from * sampleRate); a + hop <= Math.round(to * sampleRate); a += hop) {
    let sum = 0;
    let n = 0;
    for (let i = Math.max(0, a); i < Math.min(samples.length, a + hop); i++) {
      sum += samples[i] * samples[i];
      n++;
    }
    out.push(n ? Math.sqrt(sum / n) : 0);
  }
  return out;
}

/** How far a word's start may move from the ASR boundary. */
export const ONSET_SEARCH_SECONDS = 0.15;
/** Below this fraction of a word's peak (−34 dB) a frame is silence. */
const SILENCE_FRACTION = 0.02;
/** Silence this long (seconds) separates words; a stop consonant's closure is shorter. */
const GAP_SECONDS = 0.06;
/** A dip between running words: a local minimum under a quarter of both sides' peaks. */
const DIP_FRACTION = 0.25;
/** A word's end is where energy falls under this fraction of its peak (−20 dB). */
const OFFSET_FRACTION = 0.1;
/** How far a word's end may grow past the ASR boundary to keep its tail. */
const OFFSET_GROW_SECONDS = 0.2;

/**
 * Where a word's sound starts, near Whisper's `at` (seconds). Whisper's word
 * boundaries are coarse; measured on Aura-2's "still water runs deep":
 * "Still" at 0.00 (its s begins at 0.15), "deep." at 1.28 (silence until its
 * d at 1.53 — a quarter second early), "runs" at 0.88 (the dip between words
 * is at 0.97). In 10 ms RMS frames over [at − 150 ms, wordEnd):
 *   1. the first sound after the last silence (≥ 60 ms under 2% of the
 *      word's peak) before the word's loudest frame — the window opening in
 *      silence counts as one;
 *   2. else, words run together: the deepest dip within ±150 ms of `at`;
 *   3. else `at`.
 */
export function snapOnset(samples: Float32Array, sampleRate: number, at: number, wordEnd = at + 0.3, notBefore = 0): number {
  const duration = samples.length / sampleRate;
  // Never back into the previous word: the search opens no earlier than
  // `notBefore` (its loudest frame). Without it, "night" after "the" with no
  // gap between them took the silence BEFORE "the" as its onset and every
  // note began with the previous word's tail ("he he-llo-llo", field report).
  const from = Math.max(0, at - ONSET_SEARCH_SECONDS, notBefore);
  const to = Math.min(duration, Math.max(wordEnd, at + ONSET_SEARCH_SECONDS));
  const frames = rmsFrames(samples, sampleRate, from, to);
  if (frames.length < 2) return at;
  const time = (k: number) => from + k * 0.01;
  const own = Math.max(0, Math.min(frames.length - 1, Math.round((at - from) / 0.01)));
  const ownEnd = Math.max(own + 1, Math.min(frames.length, Math.round((wordEnd - from) / 0.01)));
  let peakK = own;
  for (let k = own; k < ownEnd; k++) if (frames[k] > frames[peakK]) peakK = k;
  const peak = frames[peakK];
  if (peak <= 0) return at;
  // 1. After silence.
  const silent = peak * SILENCE_FRACTION;
  const gap = Math.round(GAP_SECONDS / 0.01);
  let run = 0;
  let onset = -1;
  for (let k = 0; k <= peakK; k++) {
    if (frames[k] < silent) run++;
    else {
      if (run >= gap || (run > 0 && run === k) || (k === 0 && from === 0)) onset = k;
      run = 0;
    }
  }
  if (onset >= 0) return time(onset);
  // 2. The deepest dip near `at`.
  const side = 10;
  let best = -1;
  let bestRatio = DIP_FRACTION;
  for (let k = 1; k < frames.length - 1; k++) {
    if (Math.abs(time(k) - at) > ONSET_SEARCH_SECONDS + 1e-9) continue;
    if (frames[k] > frames[k - 1] || frames[k] > frames[k + 1]) continue;
    const left = Math.max(...frames.slice(Math.max(0, k - side), k));
    const right = Math.max(...frames.slice(k + 1, k + 1 + side));
    const ratio = frames[k] / Math.min(left, right);
    if (ratio < bestRatio) {
      bestRatio = ratio;
      best = k;
    }
  }
  return best >= 0 ? time(best) : at;
}

/**
 * Where a word's sound really ends, near the ASR's `at`: grown (≤ 200 ms, never
 * past `limit`) while the energy is still above 10% of the word's peak, or
 * pulled back over trailing silence. Measured: Whisper ended "deep." at 1.68 s,
 * its vowel ran to 1.79 s.
 */
export function snapOffset(samples: Float32Array, sampleRate: number, start: number, at: number, limit: number): number {
  const duration = samples.length / sampleRate;
  const to = Math.min(duration, limit, at + OFFSET_GROW_SECONDS);
  const frames = rmsFrames(samples, sampleRate, start, to);
  if (frames.length < 2) return at;
  const peak = Math.max(...frames);
  if (peak <= 0) return at;
  const threshold = peak * OFFSET_FRACTION;
  let last = -1;
  for (let k = 0; k < frames.length; k++) {
    if (frames[k] >= threshold) last = k;
    else if (last >= 0 && start + k * 0.01 >= at) break; // quiet again past the ASR end
  }
  return last < 0 ? at : Math.min(to, start + (last + 1) * 0.01);
}

export interface TimedWord {
  word: string;
  start: number;
  end: number;
}

export interface AnalysedWord extends TimedWord {
  /** The spoken pitch; null when the word had no voiced window. */
  hz: number | null;
  /** A loop window in the voiced middle (seconds) that sustains the word; null when none fits. */
  loop: LoopWindow | null;
}

/** How long a loop window is, about: a whole number of pitch periods near this. */
export const LOOP_SECONDS = 0.08;
/**
 * Shorter windows tried when no flat 80 ms exists (a short vowel: "is" falls
 * 15 dB into its z within 80 ms); below the last, the word plays once.
 */
const LOOP_LADDER_SECONDS = [LOOP_SECONDS, 0.05, 0.035];
/** A loop window's local pitch must sit this close to the word's anchor pitch. */
const LOOP_MAX_CENTS = 50;
/** Preferred: the pitch moves no more than this across the loop span. */
const LOOP_STEADY_CENTS = 30;
/** Preferred: the loudness moves no more than this across the loop span (× in energy = 3 dB). */
const LOOP_STEADY_ENERGY = 2;
/** A loop span is voiced throughout when at least this many 10 ms-hop pitch windows start inside it. */
const LOOP_MIN_WINDOWS = 5;

export interface LoopWindow {
  start: number;
  end: number;
  /** The pitch inside the window — what a held word is heard at, so its speed comes from this. */
  hz: number;
}

/**
 * A window inside `[from, to)` seconds that can repeat without a click: a
 * whole number of periods (≈ LOOP_SECONDS long) starting and ending at a
 * rising zero crossing, taken from a loud part of the word whose local pitch
 * is within LOOP_MAX_CENTS of `anchorHz` (a word glides — "deep" rose 208 →
 * 278 Hz — and the loop must repeat the part the anchor describes), chosen
 * for the best match of the waveform across the seam. Null when nothing
 * fits — the word then plays once, as spoken.
 */
export function findLoop(
  samples: Float32Array,
  sampleRate: number,
  from: number,
  to: number,
  anchorHz: number,
  windows: PitchWindow[] = pitchWindows(samples, sampleRate, from, to),
): LoopWindow | null {
  // The first length with a flat window wins; a word with none plays once.
  for (const seconds of LOOP_LADDER_SECONDS) {
    const loop = findLoopOfLength(samples, sampleRate, from, to, anchorHz, windows, seconds);
    if (loop) return loop;
  }
  return null;
}

function findLoopOfLength(
  samples: Float32Array,
  sampleRate: number,
  from: number,
  to: number,
  anchorHz: number,
  windows: PitchWindow[],
  loopSeconds: number,
): LoopWindow | null {
  if (!(anchorHz > 0) || !windows.length) return null;
  const a = Math.max(0, Math.floor(from * sampleRate));
  const b = Math.min(samples.length, Math.ceil(to * sampleRate));
  const peak = Math.max(...windows.map((w) => w.energy));
  if (!(peak > 0)) return null;
  const rising = (i: number) => samples[i - 1] <= 0 && samples[i] > 0;
  // A voice has several rising crossings per period, so the seam is judged
  // over a WHOLE period after each end (relative to the signal's own power):
  // an end one crossing early repeats a truncated period and plays sharp
  // (measured: +75 ¢ on "water", +132 ¢ on "deep" with a 64-sample seam).
  const seam = (start: number, end: number, span: number) => {
    let d = 0;
    let p = 0;
    for (let i = 0; i < span; i++) {
      const x = samples[start + i] - samples[end + i];
      d += x * x;
      p += samples[start + i] * samples[start + i];
    }
    return p > 0 ? d / p : Infinity;
  };
  // Candidates: loud, near the anchor — and, when any are, stable in pitch
  // across the loop span (a window on a glide repeats an average pitch; "deep"
  // rose 202 → 250 Hz in 0.12 s and its loop played 10% sharp of its tag).
  const cents = (x: number, y: number) => Math.abs(1200 * Math.log2(x / y));
  const near = windows.filter((w) => cents(w.hz, anchorHz) <= LOOP_MAX_CENTS);
  // Loud first; a word whose loudest part is a glide away from the anchor
  // (asteria's "orbit" played once, 0.29 s) still gets its quieter steady part.
  const loud = near.filter((w) => w.energy >= peak * 0.5);
  const quieter = loud.length ? loud : near.filter((w) => w.energy >= peak * 0.2);
  const glide = (w: PitchWindow) =>
    Math.max(0, ...windows.filter((x) => x.at >= w.at && x.at <= w.at + loopSeconds).map((x) => cents(x.hz, w.hz)));
  const steady = quieter.filter((w) => glide(w) <= LOOP_STEADY_CENTS);
  // And steady in loudness: a window on a swell or a decay repeats that ramp
  // at the loop rate (12.5 Hz) and the held vowel stutters — "kind" wobbled
  // ±6 dB every 80 ms and sounded like "ki-ki-ki" (field report, 0.12.3).
  // The span must be voiced all the way: pitch windows exist only where YIN
  // found a pitch, so a window at the end of the vowel ("kind": the n and the
  // d closure follow) has a span that looks flat over its two windows and a
  // loop that runs into near-silence — 22 dB of flutter (measured).
  const spanWindows = (w: PitchWindow) => windows.filter((x) => x.at >= w.at && x.at <= w.at + loopSeconds);
  const covered = (w: PitchWindow) => {
    const span = spanWindows(w);
    return span.length >= Math.min(LOOP_MIN_WINDOWS, Math.round(loopSeconds / 0.01) - 3) && span[span.length - 1].at >= w.at + loopSeconds - 0.045;
  };
  const whole = (steady.length ? steady : quieter).filter(covered);
  const pool = whole.length ? whole : steady.length ? steady : quieter;
  // Loudness across the exact segment, in 10 ms frames: a segment that dips
  // (the vowel of "is" falling 16 dB into its z) repeats that dip at the loop
  // rate and stutters. Preferred: within LOOP_STEADY_ENERGY; else the flattest.
  const frame = Math.max(1, Math.round(sampleRate * 0.01));
  const ripple = (start: number, end: number) => {
    let lo = Infinity;
    let hi = 0;
    for (let i = start; i + frame <= end; i += frame) {
      let e = 0;
      for (let j = i; j < i + frame; j++) e += samples[j] * samples[j];
      lo = Math.min(lo, e);
      hi = Math.max(hi, e);
    }
    return lo > 0 ? hi / lo : Infinity;
  };
  type Candidate = { start: number; end: number; d: number; r: number; whz: number };
  const candidates: Candidate[] = [];
  for (const w of pool) {
    const period = sampleRate / w.hz;
    const span = Math.round(period);
    const periods = Math.max(2, Math.round((loopSeconds * sampleRate) / period));
    const length = Math.round(periods * period);
    const windowStart = a + Math.round(w.at * sampleRate);
    // Rising crossings within this window's first period.
    for (let start = Math.max(a + 1, windowStart); start < windowStart + period; start++) {
      if (!rising(start)) continue;
      const target = start + length;
      // Every rising crossing within half a period of the target: the seam decides.
      for (let end = Math.max(start + 1, Math.floor(target - period / 2)); end <= target + period / 2; end++) {
        if (end + span > b || !rising(end)) continue;
        const r = ripple(start, end);
        if (r <= LOOP_STEADY_ENERGY) candidates.push({ start, end, d: seam(start, end, span), r, whz: w.hz });
      }
    }
  }
  candidates.sort((x, y) => x.d - y.d);
  // The pitch of what the loop plays: the segment repeated, measured as one
  // sound. It must agree with the window's own pitch — a seam that is not a
  // whole number of periods repeats at a pitch of its own (WebKit's decode of
  // "night": 247 Hz claimed, 219 Hz heard, −192 ¢). Such a candidate is skipped.
  for (const c of candidates.slice(0, 12)) {
    const segment = samples.subarray(c.start, c.end);
    const repeats = Math.max(2, Math.ceil((0.25 * sampleRate) / segment.length));
    const looped = new Float32Array(segment.length * repeats);
    for (let i = 0; i < repeats; i++) looped.set(segment, i * segment.length);
    const hz = detectPitch(looped, sampleRate);
    if (hz !== null && cents(hz, c.whz) <= LOOP_MAX_CENTS) return { start: c.start / sampleRate, end: c.end / sampleRate, hz };
  }
  return null;
}

/** Each word's start and end snapped to its sound, and its spoken pitch. */
export function analyseWords(samples: Float32Array, sampleRate: number, words: TimedWord[]): AnalysedWord[] {
  const duration = samples.length / sampleRate;
  const starts: number[] = [];
  let notBefore = 0;
  words.forEach((w, i) => {
    const end = Math.min(duration, Math.max(w.end, w.start + 0.03));
    const start = Math.max(0, notBefore, Math.min(snapOnset(samples, sampleRate, w.start, end, notBefore), end - 0.03));
    starts.push(start);
    // The next word starts after this one's loudest frame, and after its start.
    const frames = rmsFrames(samples, sampleRate, start, Math.max(start + 0.03, Math.min(end, i + 1 < words.length ? words[i + 1].end : duration)));
    let peak = 0;
    for (let k = 1; k < frames.length; k++) if (frames[k] > frames[peak]) peak = k;
    notBefore = Math.max(start + 0.03, start + peak * 0.01);
  });
  return words.map((w, i) => {
    const start = starts[i];
    const limit = i + 1 < words.length ? Math.max(starts[i + 1], w.end) : duration;
    const end = Math.max(start + 0.03, Math.min(duration, snapOffset(samples, sampleRate, start, Math.min(duration, w.end), limit)));
    const windows = pitchWindows(samples, sampleRate, start, end);
    const hz = anchorPitch(windows);
    return { word: w.word, start, end, hz, loop: hz ? findLoop(samples, sampleRate, start, end, hz, windows) : null };
  });
}
