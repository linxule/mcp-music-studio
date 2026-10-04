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
//   LINE='one two three four' NOTES='c4 e4 g4 c5' VOICE=orion bun scripts/verify-sing.mjs
//   SUMMARY=out.jsonl appends one JSON line per run (for a lines × voices matrix)
//   OCTAVE=0 pins the notes as written; unset, sing() picks the octave ('auto')
//   and the targets follow what its report says it chose
//
// Requests to the hosted /tts are routed to the local Worker (TTS_ORIGIN).
import { appendFileSync } from "node:fs";
import { engine, BROWSER } from "./lib/engine.mjs";
import { yin } from "../src/shared/sing-dsp.ts";
import { midiToHz } from "../src/shared/sing.ts";
import { noteNameToMidi } from "../src/shared/hap-number.ts";

const HARNESS = process.env.HARNESS ?? "http://localhost:5177/";
const TTS_ORIGIN = process.env.TTS_ORIGIN ?? "http://127.0.0.1:8841";
const LINE = process.env.LINE ?? "still water runs deep";
const NOTES = (process.env.NOTES ?? "c4 e4 g4 c5").trim().split(/\s+/);
const TARGETS = NOTES.map((n) => {
  const midi = noteNameToMidi(n);
  if (midi === null) throw new Error(`NOTES: "${n}" is not a note name`);
  return midi;
});
const VOICE = process.env.VOICE ?? "luna";
/** OCTAVE=n plays the notes exactly n octaves away; unset = the default, 'auto' (read back from the widget's report). */
const OCTAVE = process.env.OCTAVE;
/** Optional: append one JSON line per run (line, voice, engine, cents) — for a matrix. */
const SUMMARY = process.env.SUMMARY;
// One step per second: a spoken word (~0.4 s ÷ its speed) ends well inside it.
const CPS = 0.25;
const CYCLES = 4;
const CODE = `setcps(${CPS})
sing('${LINE}', "${NOTES.join(" ")}", { voice: '${VOICE}'${OCTAVE !== undefined ? `, octave: ${Number(OCTAVE)}` : ""} })`;

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

/**
 * The yardstick, fixed on purpose: YIN (the unchanged single-window function)
 * on 10 ms hops across the whole voiced span at the native rate. `median` is
 * the plain median of the voiced windows (asserted); `weighted` weights each
 * window by its energy (RMS²) — closer to what is heard. It does not use the
 * widget's anchor, so changing that anchor doesn't move the yardstick.
 */
function measure(x, rate) {
  let window = Math.round(rate * 0.04);
  const tau = Math.ceil(rate / 60);
  if (x.length < window + tau + 1) window = Math.round(rate * 0.02);
  const hop = Math.round(rate * 0.01);
  const found = [];
  for (let at = 0; at + window + tau + 1 <= x.length; at += hop) {
    const hz = yin(x, rate, at, window);
    if (hz === null) continue;
    let e = 0;
    for (let i = at; i < at + window; i++) e += x[i] * x[i];
    found.push([hz, e]);
  }
  if (!found.length) return { median: null, weighted: null, windows: 0 };
  const sorted = found.map(([hz]) => hz).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const byHz = [...found].sort((a, b) => a[0] - b[0]);
  const total = byHz.reduce((n, [, e]) => n + e, 0);
  let acc = 0;
  let weighted = byHz[byHz.length - 1][0];
  for (const [hz, e] of byHz) {
    acc += e;
    if (acc >= total / 2) { weighted = hz; break; }
  }
  return { median, weighted, windows: found.length };
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
// The harness page (the host) receives the widget's model reports: keep them,
// to read which octave 'auto' chose.
await context.addInitScript(`(() => {
  if (window !== window.top) return;
  globalThis.__reports = [];
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (d && d.method === 'ui/update-model-context') {
      for (const c of d.params?.content ?? []) if (c?.type === 'text') globalThis.__reports.push(String(c.text));
    }
  });
})();`);
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

const reports = await page.evaluate(() => globalThis.__reports ?? []);
const sungNote = reports.map((t) => /sing: .*/.exec(t)?.[0]).filter(Boolean).at(-1) ?? null;
const chosen = OCTAVE !== undefined ? Number(OCTAVE) : Number(/: octave ([+-]?\d+)/.exec(sungNote ?? "")?.[1] ?? NaN);
console.log(`  widget: ${sungNote ?? "(no sing note in its reports)"}`);
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
    const m = first >= 0 ? measure(step.subarray(first, last), rate) : { median: null, weighted: null, windows: 0 };
    const hz = m.median;
    const acf = first >= 0 ? autocorrelationHz(step.subarray(first, last), rate) : null;
    const target = midiToHz(TARGETS[k] + 12 * (Number.isFinite(chosen) ? chosen : 0));
    const cents = hz ? 1200 * Math.log2(hz / target) : null;
    const weighted = m.weighted ? 1200 * Math.log2(m.weighted / target) : null;
    rows.push({ cycle: c, step: k, note: NOTES[k], peak, hz, acf, target, cents, weighted, sounded: first >= 0 ? ((last - first) / rate) : 0 });
  }
}
for (const r of rows) {
  console.log(
    `  cycle ${r.cycle} step ${r.step} ${r.note.padEnd(3)} target ${r.target.toFixed(1).padStart(6)} Hz → ` +
      `${r.hz ? r.hz.toFixed(1).padStart(6) : "  none"} Hz ` +
      `(${r.cents === null ? "—" : `${r.cents >= 0 ? "+" : ""}${r.cents.toFixed(0)} cents`}; energy-weighted ${r.weighted === null ? "—" : `${r.weighted >= 0 ? "+" : ""}${r.weighted.toFixed(0)}`}; autocorrelation ${r.acf ? r.acf.toFixed(1) : "none"} Hz), peak ${r.peak.toFixed(3)}, voiced ${r.sounded.toFixed(2)} s`,
  );
}
const first = rows.filter((r) => r.cycle === 0);
console.log(`  first cycle (not asserted): ${first.filter((r) => r.peak >= 0.02).length} of ${first.length} steps audible`);
rows.splice(0, first.length);
const silent = rows.filter((r) => r.peak < 0.02);
const abs = (key) => rows.filter((r) => r[key] !== null).map((r) => Math.abs(r[key])).sort((a, b) => a - b);
const mid = (xs) => (xs.length ? (xs.length % 2 ? xs[xs.length >> 1] : (xs[(xs.length >> 1) - 1] + xs[xs.length >> 1]) / 2) : null);
const plain = abs("cents");
const perceived = abs("weighted");
const fmt = (x) => (x === null || x === undefined ? "—" : x.toFixed(0));
console.log(
  `  median cents ${fmt(mid(plain))} (worst ${fmt(plain.at(-1))}); energy-weighted median ${fmt(mid(perceived))} (worst ${fmt(perceived.at(-1))}); ` +
    `unmeasured ${rows.length - plain.length} of ${rows.length}`,
);
if (SUMMARY) {
  appendFileSync(SUMMARY, JSON.stringify({
    line: LINE, voice: VOICE, notes: NOTES.join(" "), engine: BROWSER, octave: chosen, clamped: Number(/(\d+) of \d+ words at the speed limit/.exec(sungNote ?? "")?.[1] ?? 0),
    median: mid(plain), worst: plain.at(-1) ?? null, weightedMedian: mid(perceived), weightedWorst: perceived.at(-1) ?? null,
    unmeasured: rows.length - plain.length, steps: rows.length,
    perNote: NOTES.map((n, k) => ({ note: n, cents: rows.find((r) => r.step === k)?.cents ?? null })),
  }) + "\n");
}
const off = rows.filter((r) => r.cents === null || Math.abs(r.cents) > 100);
rows.length === CYCLES * NOTES.length ? ok(`captured ${rows.length} steps`) : fail(`captured ${rows.length} of ${CYCLES * NOTES.length} steps`);
silent.length === 0 ? ok("every step is audible") : fail(`${silent.length} silent steps: ${silent.map((r) => `${r.cycle}.${r.step}`).join(", ")}`);
off.length === 0
  ? ok(`every step within ±1 semitone of its note (worst ${Math.max(...rows.map((r) => Math.abs(r.cents ?? 0))).toFixed(0)} cents)`)
  : fail(`${off.length} steps off by more than a semitone: ${off.map((r) => `${r.cycle}.${r.step} ${r.cents === null ? "unvoiced" : `${r.cents.toFixed(0)}¢`}`).join(", ")}`);
Number.isFinite(chosen) ? ok(`octave ${chosen}${OCTAVE !== undefined ? " (given)" : " (auto, from the widget's report)"}`) : fail("the widget never reported which octave it chose");
tts.some((t) => t === "words 200") ? ok("GET /tts?…&words=1 served the timings") : fail(`no words request succeeded (${tts.join(", ")})`);
errors.length === 0 ? ok("no console errors") : fail(`console:\n  ${errors.slice(0, 5).join("\n  ")}`);
