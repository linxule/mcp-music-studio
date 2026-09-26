// Observe real rendered samples without replacing sources or the scheduler.
// Keep the actual destination connected, including its channel-count contract.
export function installAudioProbe() {
  const descriptor = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, "destination")!;
  const taps = new WeakMap<BaseAudioContext, GainNode>();
  const meters: AnalyserNode[] = [];
  Object.defineProperty(BaseAudioContext.prototype, "destination", {
    configurable: true,
    get(this: AudioContext) {
      if (!(this instanceof AudioContext)) return descriptor.get!.call(this);
      let tap = taps.get(this);
      if (!tap) {
        const destination = descriptor.get!.call(this) as AudioDestinationNode;
        tap = this.createGain();
        const meter = this.createAnalyser();
        meter.fftSize = 2048;
        tap.connect(destination);
        tap.connect(meter);
        Object.defineProperty(tap, "maxChannelCount", { value: destination.maxChannelCount });
        taps.set(this, tap);
        meters.push(meter);
      }
      return tap;
    },
  });
  (window as any).__audioProbe = async (duration = 600) => {
    let peakRms = 0;
    const end = performance.now() + duration;
    do {
      for (const meter of meters) {
        const samples = new Float32Array(meter.fftSize);
        meter.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length);
        peakRms = Math.max(peakRms, rms);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (performance.now() < end);
    return { peakRms, contexts: meters.length };
  };
}
