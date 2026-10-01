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
// Two random short words: a line the Worker has (almost surely) never
// rendered, so the check covers a FRESH render, and short enough to end
// inside its 2-second cycle.
const WORDS = ["amber", "river", "glass", "orbit", "velvet", "ember", "cedar", "lumen", "quartz", "harbor",
  "violet", "signal", "meadow", "copper", "tidal", "nimbus", "saffron", "hollow", "zephyr", "marble"];

// EVEN cycles speak — including cycle 0 of the very first play, the line a
// fresh render used to miss (superdough drops a sample not decoded by its start
// time). The kick is muted so the voice is the only sound.
const CODE = `setcps(${CPS})
const line = say('${WORDS[Math.floor(Math.random() * WORDS.length)]} ${WORDS[Math.floor(Math.random() * WORDS.length)]}', { voice: 'orion' })
let frames = 0, events = 0, taps = 0
onFrame(f => { frames++; window.__stage = { frames, events, taps, cycle: f.cycle, playing: f.playing } })
onEvent(s("bd*4"), () => { events++ })
onTap(() => { taps++ })
stack(s("bd*4").gain(0), line.mask("<1 0>"))`;

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
          // Binned by the widget's own audible cycle when it has one.
          globalThis.__levels.push([this.currentTime, peak, typeof globalThis.cycle === 'function' ? globalThis.cycle() : NaN]);
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

// --gallery: every gallery piece through the real widget instead — it must
// evaluate without error, keep drawing, and make sound.
if (process.argv.includes("--gallery")) {
  const { STRUDEL_GALLERY } = await import("../src/strudel-gallery.ts");
  const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  for (const piece of STRUDEL_GALLERY) {
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    await context.addInitScript(LEVEL_TAP);
    const tts = [];
    await context.route("https://music-studio.linxule.com/tts**", async (route) => {
      const url = new URL(route.request().url());
      const res = await fetch(`${TTS_ORIGIN}/tts${url.search}`);
      tts.push(res.status);
      await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
    });
    const page = await context.newPage();
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(HARNESS);
    await page.waitForFunction(() => document.getElementById("state")?.textContent?.startsWith("connected"), null, { timeout: 30000 });
    await page.fill("#args", JSON.stringify({ code: piece.code, autoplay: true }));
    await page.click("#send");
    const frame = () => page.frames().find((f) => f.url().includes("/widgets/"));
    for (let i = 0; i < 100 && !frame(); i++) await sleep(100);
    await page.mouse.click(600, 700);
    await sleep(9000);
    const status = await frame().evaluate(() => document.getElementById("status")?.textContent ?? "");
    const levels = (await frame().evaluate(() => globalThis.__levels)) ?? [];
    const peak = levels.reduce((m, [, p]) => Math.max(m, p), 0);
    // Is the stage drawing? A screenshot of the frame (a WebGL canvas reads
    // back black without preserveDrawingBuffer), decoded in the page; then a
    // second one a beat later must DIFFER — a lit but frozen stage fails.
    const shoot = async () => (await (await page.$("iframe")).screenshot()).toString("base64");
    const stats = (b64) => page.evaluate(async (data) => {
      const img = new Image();
      img.src = "data:image/png;base64," + data;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = 96; c.height = 54;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0, 96, 54);
      return Array.from(g.getImageData(0, 0, 96, 54).data);
    }, b64);
    const a = await stats(await shoot());
    await sleep(700);
    const b = await stats(await shoot());
    const mean = a.reduce((n, v) => n + v, 0) / a.length;
    let diff = 0;
    for (let k = 0; k < a.length; k++) diff += Math.abs(a[k] - b[k]);
    diff /= a.length;
    const lit = mean > 8 && diff > 0.5;
    const real = errors.filter((e) => !/favicon|DevTools|Download the React/i.test(e));
    // "Playing" — not merely "no error": DUET once read "Ready" over audible
    // music because the report ran before the held start took effect.
    const good = /^Playing/.test(status) && peak > 0.02 && lit && real.length === 0;
    (good ? ok : fail)(`${piece.id}: status "${status}", peak ${peak.toFixed(2)}, stage ${lit ? "moving" : "still/dark"} (mean ${mean.toFixed(1)}, change ${diff.toFixed(2)})` +
      (tts.length ? `, tts ${tts.join(",")}` : "") + (real.length ? `, errors: ${real.slice(0, 2).join(" | ")}` : ""));
    await context.close();
  }
  await browser.close();
  process.exit(process.exitCode ?? 0);
}

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

// Loudness per cycle, binned by the widget's cycle() — so a line dropped in
// cycle 0 shows as a quiet cycle 0, not as "the first loud cycle".
const levels = (await frame()?.evaluate(() => globalThis.__levels)) ?? [];
const byCycle = new Map();
for (const [, p, c] of levels) {
  if (!Number.isFinite(c) || c < 0) continue;
  const k = Math.floor(c + 1e-3);
  byCycle.set(k, Math.max(byCycle.get(k) ?? 0, p));
}
const row = [...byCycle].sort((a, b) => a[0] - b[0]).map(([c, p]) => `${c}:${p.toFixed(2)}`);
console.log(`  peak by cycle: ${row.join("  ")}`);
const [c0, c1, c2] = [byCycle.get(0) ?? 0, byCycle.get(1) ?? 0, byCycle.get(2) ?? 0];
c0 > 0.05 && c2 > 0.05 && c1 < c0 / 4
  ? ok("say() speaks in bar 0 of the first play, and on the beat after — silent between")
  : fail(`speech not on its cycles (c0 ${c0.toFixed(3)}, c1 ${c1.toFixed(3)}, c2 ${c2.toFixed(3)})`);

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
