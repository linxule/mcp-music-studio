// Acceptance check for sing(), in a real browser, through the real widget:
// every step of `sing('still water runs deep', "c4 e4 g4 c5")` is audible, and
// the pitch of what comes OUT of the speakers on each step is within ±1
// semitone of its note — measured with the same YIN the widget uses
// (src/shared/sing-dsp.ts), on the captured output, not on the widget's
// own numbers.
//
// LOCAL ONLY, like verify-stage: it needs real Workers AI (Aura-2 + Whisper),
// so it is not in scripts/ci-browser.sh. A fresh line costs well under a cent.
//
//   bun run build
//   (cd worker && bunx wrangler dev --env lab --port 8841 --inspector-port 9341)
//   bunx vite --config dev/vite.config.ts --port 5177
//   bun scripts/verify-sing.mjs          # BROWSER=webkit for Safari's engine
//
// Requests to the hosted /tts are routed to the local Worker (TTS_ORIGIN).
import { engine, BROWSER } from "./lib/engine.mjs";
import { detectPitch } from "../src/shared/sing-dsp.ts";
import { midiToHz } from "../src/shared/sing.ts";

const HARNESS = process.env.HARNESS ?? "http://localhost:5177/";
const TTS_ORIGIN = process.env.TTS_ORIGIN ?? "http://127.0.0.1:8841";
const LINE = process.env.LINE ?? "still water runs deep";
const NOTES = ["c4", "e4", "g4", "c5"];
const TARGETS = [60, 64, 67, 72];
// One step per second: a spoken word (~0.4 s ÷ its speed) ends well inside it.
const CPS = 0.25;
const CYCLES = 4;
const CODE = `setcps(${CPS})
sing('${LINE}', "${NOTES.join(" ")}")`;

/**
 * A second opinion that shares no code with the widget: the strongest
 * autocorrelation lag between 60 and 1000 Hz over the voiced part.
 */
function autocorrelationHz(x, rate) {
  const minLag = Math.floor(rate / 1000);
  const maxLag = Math.min(Math.ceil(rate / 60), x.length >> 1);
  let best = 0;
  let bestLag = 0;
  const r = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < x.length; i++) sum += x[i] * x[i + lag];
    r[lag] = sum / (x.length - lag);
  }
  for (let lag = minLag + 1; lag <= maxLag; lag++) {
    if (r[lag] > best && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) {
      best = r[lag];
      bestLag = lag;
    }
  }
  return bestLag ? rate / bestLag : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};
const ok = (msg) => console.log(`✓ ${msg}`);

// Records what reaches every AudioContext's destination, with the context
// time of each block and the widget's audible cycle() over time.
const RECORDER = `(() => {
  if (!globalThis.BaseAudioContext) return;
  const desc = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'destination');
  const taps = new WeakMap();
  globalThis.__rec = { rate: 0, chunks: [], clock: [] };
  Object.defineProperty(BaseAudioContext.prototype, 'destination', { configurable: true, get() {
    if (this instanceof OfflineAudioContext || typeof this.createScriptProcessor !== 'function') return desc.get.call(this);
    let t = taps.get(this);
    if (!t) {
      const real = desc.get.call(this), g = this.createGain();
      g.connect(real);
      Object.defineProperty(g, 'maxChannelCount', { value: real.maxChannelCount || 2 });
      const proc = this.createScriptProcessor(4096, 2, 1);
      const mute = this.createGain();
      mute.gain.value = 0;
      g.connect(proc); proc.connect(mute); mute.connect(real);
      globalThis.__rec.rate = this.sampleRate;
      proc.onaudioprocess = (e) => {
        const a = e.inputBuffer.getChannelData(0);
        const b = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : a;
        const mono = new Float32Array(a.length);
        for (let i = 0; i < a.length; i++) mono[i] = (a[i] + b[i]) / 2;
        // The block was captured one block before it plays.
        globalThis.__rec.chunks.push([e.playbackTime - a.length / this.sampleRate, mono]);
      };
      setInterval(() => {
        if (typeof globalThis.cycle === 'function') globalThis.__rec.clock.push([this.currentTime, globalThis.cycle()]);
      }, 20);
      t = g; taps.set(this, t);
    }
    return t;
  } });
})();`;

const browser = await engine.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 1000, height: 900 } });
await context.addInitScript(RECORDER);
const tts = [];
await context.route("https://music-studio.linxule.com/tts**", async (route) => {
  const url = new URL(route.request().url());
  const res = await fetch(`${TTS_ORIGIN}/tts${url.search}`);
  tts.push(`${url.searchParams.get("words") ? "words" : "clip"} ${res.status}`);
  await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
});
const page = await context.newPage();
const errors = [];
page.on("console", (m) => (m.type() === "error" || /could not load|not found/i.test(m.text())) && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(HARNESS);
await page.waitForFunction(() => document.getElementById("state")?.textContent?.startsWith("connected"), null, { timeout: 30000 });
await page.fill("#args", JSON.stringify({ code: CODE, autoplay: true }));
await page.click("#send");
const frame = () => page.frames().find((f) => f.url().includes("/widgets/"));
for (let i = 0; i < 100 && !frame(); i++) await sleep(100);
if (!frame()) throw new Error("the widget never loaded");
await sleep(1500);
await page.mouse.click(500, 700); // a gesture inside the page, after Strudel loaded

// Play until CYCLES full cycles after the first one have been heard.
let heard = 0;
for (let i = 0; i < 160; i++) {
  await sleep(250);
  heard = await frame().evaluate(() => (typeof globalThis.cycle === "function" ? globalThis.cycle() : 0));
  if (heard > CYCLES + 1.2) break;
}
console.log(`  ${BROWSER}; /tts: ${tts.join(", ") || "none"}; played to cycle ${heard.toFixed(2)}`);

const rec = await frame().evaluate(() => {
  const { rate, chunks, clock } = globalThis.__rec;
  const total = chunks.reduce((n, [, c]) => n + c.length, 0);
  const all = new Float32Array(total);
  let at = 0;
  for (const [, c] of chunks) { all.set(c, at); at += c.length; }
  const bytes = new Uint8Array(all.buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { rate, start: chunks[0]?.[0] ?? 0, clock, audio: btoa(bin) };
});
await browser.close();

if (!rec.rate || !rec.audio) {
  fail("no audio was captured");
  process.exit(1);
}
const samples = new Float32Array(new Uint8Array(Buffer.from(rec.audio, "base64")).buffer);
const rate = rec.rate;
// Context time → cycle, by least squares over the clock samples while playing.
const pts = rec.clock.filter(([, c]) => Number.isFinite(c) && c > 0.05);
const n = pts.length;
const mx = pts.reduce((s, [t]) => s + t, 0) / n;
const my = pts.reduce((s, [, c]) => s + c, 0) / n;
const slope = pts.reduce((s, [t, c]) => s + (t - mx) * (c - my), 0) / pts.reduce((s, [t]) => s + (t - mx) ** 2, 0);
const cycleAt = (time) => my + slope * (time - mx);
const timeOf = (cycle) => mx + (cycle - my) / slope;
console.log(`  clock: ${slope.toFixed(4)} cycles/s (expected ${CPS})`);

// Each step of cycles 1..CYCLES: is it audible, and what pitch comes out?
const rows = [];
// Cycle 0 is reported, not asserted: with a fresh line the widget starts
// before the line has loaded unless it holds voiced pieces for sing() too.
for (let c = 0; c <= CYCLES; c++) {
  for (let k = 0; k < NOTES.length; k++) {
    const from = timeOf(c + k / NOTES.length) - rec.start;
    const to = timeOf(c + (k + 1) / NOTES.length) - rec.start;
    const a = Math.max(0, Math.floor(from * rate));
    const b = Math.min(samples.length, Math.floor(to * rate));
    if (b - a < rate * 0.2) continue;
    const step = samples.subarray(a, b);
    let peak = 0;
    for (const v of step) peak = Math.max(peak, Math.abs(v));
    // The voiced part only: frames above a tenth of the step's peak.
    const hop = Math.round(rate * 0.01);
    let first = -1, last = -1;
    for (let i = 0; i + hop <= step.length; i += hop) {
      let sum = 0;
      for (let j = i; j < i + hop; j++) sum += step[j] * step[j];
      if (Math.sqrt(sum / hop) > peak * 0.1) { if (first < 0) first = i; last = i + hop; }
    }
    const hz = first >= 0 ? detectPitch(step, rate, first / rate, last / rate) : null;
    const acf = first >= 0 ? autocorrelationHz(step.subarray(first, last), rate) : null;
    const target = midiToHz(TARGETS[k]);
    const cents = hz ? 1200 * Math.log2(hz / target) : null;
    rows.push({ cycle: c, step: k, note: NOTES[k], peak, hz, acf, target, cents, sounded: first >= 0 ? ((last - first) / rate) : 0 });
  }
}
for (const r of rows) {
  console.log(
    `  cycle ${r.cycle} step ${r.step} ${r.note.padEnd(3)} target ${r.target.toFixed(1).padStart(6)} Hz → ` +
      `${r.hz ? r.hz.toFixed(1).padStart(6) : "  none"} Hz ` +
      `(${r.cents === null ? "—" : `${r.cents >= 0 ? "+" : ""}${r.cents.toFixed(0)} cents`}; autocorrelation ${r.acf ? r.acf.toFixed(1) : "none"} Hz), peak ${r.peak.toFixed(3)}, voiced ${r.sounded.toFixed(2)} s`,
  );
}
const first = rows.filter((r) => r.cycle === 0);
console.log(`  first cycle (not asserted): ${first.filter((r) => r.peak >= 0.02).length} of ${first.length} steps audible`);
rows.splice(0, first.length);
const silent = rows.filter((r) => r.peak < 0.02);
const off = rows.filter((r) => r.cents === null || Math.abs(r.cents) > 100);
rows.length === CYCLES * NOTES.length ? ok(`captured ${rows.length} steps`) : fail(`captured ${rows.length} of ${CYCLES * NOTES.length} steps`);
silent.length === 0 ? ok("every step is audible") : fail(`${silent.length} silent steps: ${silent.map((r) => `${r.cycle}.${r.step}`).join(", ")}`);
off.length === 0
  ? ok(`every step within ±1 semitone of its note (worst ${Math.max(...rows.map((r) => Math.abs(r.cents ?? 0))).toFixed(0)} cents)`)
  : fail(`${off.length} steps off by more than a semitone: ${off.map((r) => `${r.cycle}.${r.step} ${r.cents === null ? "unvoiced" : `${r.cents.toFixed(0)}¢`}`).join(", ")}`);
tts.some((t) => t === "words 200") ? ok("GET /tts?…&words=1 served the timings") : fail(`no words request succeeded (${tts.join(", ")})`);
errors.length === 0 ? ok("no console errors") : fail(`console:\n  ${errors.slice(0, 5).join("\n  ")}`);
