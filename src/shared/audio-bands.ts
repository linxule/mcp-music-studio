// =============================================================================
// Audio-reactive `a` — the band math, pure, shared by the widget and the share
// page (whose inline script carries a copy held to this one by
// tests/share-page-audio.test.ts).
//
// Value semantics are hydra-synth 1.4.0's (src/lib/audio.js):
//   bins[i] = raw[i] * (1 - smooth) + prevBins[i] * smooth
//   fft[i]  = max(0, (bins[i] - cutoff) / scale)
// with raw[i] the band's mean FFT magnitude (0..1) scaled by `max` — hydra sums
// bark-band loudness, which has no meaning for FFT magnitudes. Bands are
// log-spaced over 20 Hz–12 kHz, so fft[0] is the kick and fft[3] the hats.
// =============================================================================

/** AnalyserNode settings; the dB window is musical (the default flattens Strudel). */
export const AUDIO_ANALYSER = {
  fftSize: 2048,
  smoothing: 0.8,
  minDecibels: -90,
  maxDecibels: -20,
  lowHz: 20,
  highHz: 12_000,
} as const;

/** hydra-synth's defaults for the `a` object. */
export const AUDIO_DEFAULTS = { bins: 4, cutoff: 2, scale: 10, smooth: 0.4, max: 15 } as const;

/**
 * Mean magnitude (0..1) of each of `count` log-spaced bands, from an
 * AnalyserNode's getByteFrequencyData() output.
 */
export function bandLevels(
  bytes: ArrayLike<number>,
  sampleRate: number,
  fftSize: number,
  count: number,
  lowHz: number = AUDIO_ANALYSER.lowHz,
  highHz: number = AUDIO_ANALYSER.highHz,
): number[] {
  const hzPerBin = sampleRate / fftSize;
  const ratio = Math.pow(highHz / lowHz, 1 / count);
  const levels: number[] = [];
  for (let i = 0; i < count; i++) {
    const lo = lowHz * Math.pow(ratio, i);
    const hi = lo * ratio;
    const start = Math.min(bytes.length - 1, Math.floor(lo / hzPerBin));
    const end = Math.min(bytes.length, Math.max(start + 1, Math.ceil(hi / hzPerBin)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += bytes[j];
    levels.push(sum / Math.max(1, end - start) / 255);
  }
  return levels;
}

export interface BandSetting {
  cutoff: number;
  scale: number;
  smooth: number;
}

/**
 * One frame of hydra's smoothing: writes `bins` and `fft` in place from the
 * previous bins, returns the new `vol` (mean of bins).
 */
export function stepBands(
  levels: readonly number[],
  prevBins: readonly number[],
  settings: readonly BandSetting[],
  max: number,
  bins: number[],
  fft: number[],
): number {
  let total = 0;
  for (let i = 0; i < levels.length; i++) {
    const smooth = settings[i].smooth;
    bins[i] = levels[i] * max * (1 - smooth) + (prevBins[i] ?? 0) * smooth;
    total += bins[i];
  }
  for (let i = 0; i < levels.length; i++) {
    fft[i] = Math.max(0, (bins[i] - settings[i].cutoff) / settings[i].scale);
  }
  return total / Math.max(1, levels.length);
}
