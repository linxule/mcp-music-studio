// Acceptance check for the stage runtime, in a real browser, through the real
// widget: say() lines land on the beat and are audible; cycle() advances;
// onFrame and onEvent run; a re-evaluation leaves exactly one loop.
//
//   bun run build
//   (cd worker && bunx wrangler dev --port 8799)      # serves GET /tts (Workers AI)
//   bunx vite --config dev/vite.config.ts --port 5177 # the ext-apps harness
//   bun scripts/verify-stage.mjs
//
// Speech requests to the hosted origin are routed to the local Worker
// (TTS_ORIGIN), so this runs before a deploy. Audio is measured by tapping
// every AudioContext's destination with an AnalyserNode: per-cycle peak level,
// not "it looked like it played".
import { chromium } from "playwright";

const HARNESS = process.env.HARNESS ?? "http://localhost:5177/";
const TTS_ORIGIN = process.env.TTS_ORIGIN ?? "http://127.0.0.1:8799";
const CPS = 0.5;

// Odd cycles speak; even cycles are silent. The kick is muted so the voice is
// the only sound — loudness per cycle then says whether say() is on schedule.
const CODE = `setcps(${CPS})
const line = say('one, two, three, four', { voice: 'orion' })
let frames = 0, events = 0, taps = 0
onFrame(f => { frames++; window.__stage = { frames, events, taps, cycle: f.cycle, playing: f.playing } })
onEvent(s("bd*4"), () => { events++ })
onTap(() => { taps++ })
stack(s("bd*4").gain(0), line.mask("<0 1>"))`;

const LEVEL_TAP = `
(() => {
  if (!globalThis.BaseAudioContext) return;
  const desc = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'destination');
  const taps = new WeakMap();
  globalThis.__levels = [];
  Object.defineProperty(BaseAudioContext.prototype, 'destination', {
    configurable: true,
    get() {
      if (typeof this.createAnalyser !== 'function' || this instanceof OfflineAudioContext) return desc.get.call(this);
      let t = taps.get(this);
      if (!t) {
        const real = desc.get.call(this);
        const g = this.createGain();
        const a = this.createAnalyser();
        a.fftSize = 2048;
        g.connect(real); g.connect(a);
        Object.defineProperty(g, 'maxChannelCount', { value: real.maxChannelCount || 2 });
        const buf = new Float32Array(a.fftSize);
        setInterval(() => {
          a.getFloatTimeDomainData(buf);
          let peak = 0;
          for (const v of buf) peak = Math.max(peak, Math.abs(v));
          globalThis.__levels.push([this.currentTime, peak]);
        }, 25);
        t = g;
        taps.set(this, t);
      }
      return t;
    },
  });
})();`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};
const ok = (msg) => console.log(`✓ ${msg}`);

const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
await context.addInitScript(LEVEL_TAP);
const ttsRequests = [];
await context.route("https://music-studio.linxule.com/tts**", async (route) => {
  const url = new URL(route.request().url());
  const res = await fetch(`${TTS_ORIGIN}/tts${url.search}`);
  ttsRequests.push(res.status);
  await route.fulfill({
    status: res.status,
    headers: Object.fromEntries(res.headers),
    body: Buffer.from(await res.arrayBuffer()),
  });
});
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error" || /not found/i.test(m.text())) consoleErrors.push(m.text());
});

await page.goto(HARNESS);
await page.waitForFunction(() => document.getElementById("state")?.textContent?.startsWith("connected"), null, { timeout: 30000 });
await page.fill("#args", JSON.stringify({ code: CODE, autoplay: true }));
await page.click("#send");
const frame = () => page.frames().find((f) => f.url().includes("/widgets/"));
for (let i = 0; i < 100 && !frame(); i++) await sleep(100);
await page.mouse.click(600, 700); // a real gesture inside the page, for good measure

// Let it play through two full speak/silent pairs.
let stage;
for (let i = 0; i < 60; i++) {
  await sleep(250);
  stage = await frame()?.evaluate(() => window.__stage).catch(() => undefined);
  if (stage?.cycle > 4.5) break;
}
if (!stage) fail("onFrame never ran (window.__stage unset)");
else {
  stage.frames > 30 ? ok(`onFrame ran ${stage.frames} frames`) : fail(`onFrame ran only ${stage?.frames} frames`);
  stage.cycle > 4 ? ok(`cycle() advanced to ${stage.cycle.toFixed(2)}`) : fail(`cycle() stuck at ${stage.cycle}`);
  // 4 kicks per cycle; allow the first frame's window.
  stage.events >= 14 ? ok(`onEvent fired ${stage.events} times over ~${stage.cycle.toFixed(1)} cycles`) : fail(`onEvent fired ${stage.events} times`);
}
ttsRequests.includes(200) ? ok(`GET /tts served the line (${ttsRequests.join(", ")})`) : fail(`no successful /tts request (${ttsRequests.join(", ") || "none"})`);

// Loudness per cycle, from the tapped AudioContext's own clock.
const levels = (await frame()?.evaluate(() => globalThis.__levels)) ?? [];
const loud = levels.filter(([, p]) => p > 0.02);
if (!loud.length) fail("no audio above -34 dBFS at all — the line never sounded");
else {
  const t0 = loud[0][0];
  const byCycle = new Map();
  for (const [t, p] of levels) {
    const c = Math.floor((t - t0) * CPS + 1e-3);
    if (c >= 0) byCycle.set(c, Math.max(byCycle.get(c) ?? 0, p));
  }
  const row = [...byCycle].sort((a, b) => a[0] - b[0]).map(([c, p]) => `${c}:${p.toFixed(2)}`);
  console.log(`  peak by cycle since first sound: ${row.join("  ")}`);
  // The voice speaks every other cycle: cycle 0 (its first) loud, 1 quiet, 2 loud.
  const [c0, c1, c2] = [byCycle.get(0) ?? 0, byCycle.get(1) ?? 0, byCycle.get(2) ?? 0];
  c0 > 0.05 && c2 > 0.05 && c1 < c0 / 4
    ? ok("say() is audible on its cycles and silent between — on the beat, in the mix")
    : fail(`speech pattern not alternating (c0 ${c0.toFixed(3)}, c1 ${c1.toFixed(3)}, c2 ${c2.toFixed(3)})`);
}

// Re-evaluate the same piece: its loop must REPLACE the old one, not join it.
const before = await frame().evaluate(() => window.__stage.frames);
await page.click("#send");
await sleep(2500);
const rate = await frame().evaluate(async () => {
  const a = window.__stage.frames;
  await new Promise((r) => setTimeout(r, 1000));
  return window.__stage.frames - a;
});
rate > 20 && rate < 75
  ? ok(`after a re-evaluation one loop runs (${rate} frames/s; two would double it), counter restarted from ${before}`)
  : fail(`after a re-evaluation, ${rate} frames/s — expected one loop`);

const notFound = consoleErrors.filter((e) => /say_|not found/i.test(e));
notFound.length ? fail(`console: ${notFound.slice(0, 3).join(" | ")}`) : ok("no missing-sound errors");

// The frozen-clock bug, through the real H() wrapper: H(signal(t => t)) must
// read the cycle, not 0. (First Light v1 and Petri Dish froze at bar 1 on it.)
const clock = await frame().evaluate(async () => {
  const read = globalThis.H(globalThis.signal((t) => t));
  const a = read();
  await new Promise((r) => setTimeout(r, 1000));
  return [a, read()];
});
clock[1] > clock[0] && clock[0] > 0
  ? ok(`H(signal(t => t)) is a running clock (${clock[0].toFixed(2)} → ${clock[1].toFixed(2)})`)
  : fail(`H(signal(t => t)) is frozen: ${clock.join(" → ")}`);

await browser.close();
