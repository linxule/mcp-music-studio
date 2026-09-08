// Showcase recorder: drives the dev harness (real ext-apps AppBridge) with
// Playwright, records the page as video, and taps every AudioContext's
// destination through a MediaStreamDestination so the audio can be muxed back.
import { chromium } from '/Users/xulelin/node_modules/playwright/index.mjs';
import fs from 'node:fs';

const BASE = 'http://localhost:5210/';
const OUT = process.env.SHOWCASE_OUT ?? '/tmp/ms-showcase';
const W = 1280, H = 800;
const only = process.argv[2] ? new Set(process.argv.slice(2)) : null;

const HY = "'https://unpkg.com/hydra-synth@1.4.0'";

const SCENES = [
  {
    id: '01-shader', card: ['Hydra shaders behind the code', 'The model writes the shader and the beat in one block. Pinned hydra-synth, real WebGL.'],
    widget: 'strudel', play: 14,
    args: { title: 'Kaleidoscope', theme: 'tokyoNight', bpm: 128,
      code: `await initHydra({ src: ${HY} })
osc(40, 0.08, 1.2)
  .kaleid(6)
  .rotate(() => time * 0.15)
  .modulate(noise(2, 0.15), 0.08)
  .color(0.35, 0.55, 1.4)
  .contrast(1.4)
  .out(o0)

stack(
  s("bd*4").bank("RolandTR909"),
  s("[~ hh]*4").gain(0.5),
  s("~ cp").bank("RolandTR909").room(0.3),
  note("<c2 c2 eb2 g1>*4").s("sawtooth").lpf(sine.range(300, 1800).slow(8)).decay(0.15).sustain(0)
)` },
  },
  {
    id: '02-kaleid', card: ['visuals presets', 'One parameter on play-live-pattern: hydra-kaleid · hydra-pulse · hydra-wash · hydra-feed.'],
    widget: 'strudel', play: 8,
    args: { title: 'visuals: hydra-kaleid', visuals: 'hydra-kaleid', theme: 'vscodeDark', bpm: 124,
      code: `stack(
  s("bd*2 [~ bd] sd ~").bank("RolandTR808"),
  s("hh*8").gain("0.3 0.5"),
  note("<c3 eb3 g3 bb3>*2").s("gm_epiano1").room(0.5)
)` },
  },
  {
    id: '03-pulse', card: null,
    widget: 'strudel', play: 10,
    args: { title: 'visuals: hydra-pulse', visuals: 'hydra-pulse', theme: 'dracula', bpm: 120,
      code: `stack(
  s("bd*2 [~ bd] bd*2 [~ bd]").bank("RolandTR808"),
  s("~ cp").bank("RolandTR808"),
  s("hh*8").gain(0.5),
  note("<a1 a1 f1 g1>").s("gm_synth_bass_1").lpf(900)
)` },
  },
  {
    id: '04-wash', card: null,
    widget: 'strudel', play: 11,
    args: { title: 'visuals: hydra-wash', visuals: 'hydra-wash', theme: 'nord', bpm: 70,
      code: `stack(
  note("<[c3,e3,g3,b3] [a2,c3,e3,g3] [f2,a2,c3,e3] [g2,b2,d3,f3]>").s("gm_pad_warm").attack(0.5).release(2).room(0.8).gain(0.7),
  note("<e5 g5 b5 d6>/2").s("gm_music_box").delay(0.5).delaytime(0.375).room(0.6).gain(0.5)
)` },
  },
  {
    id: '05-feed', card: null,
    widget: 'strudel', play: 11,
    args: { title: 'visuals: hydra-feed', visuals: 'hydra-feed', theme: 'materialDark', bpm: 110,
      code: `note("<[c3 e3 g3 b3] [a2 c3 e3 g3] [f2 a2 c3 e3] [g2 b2 d3 f3]>*2")
  .s("sawtooth").lpf(1400).decay(0.2).sustain(0.1).delay(0.3)` },
  },
  {
    id: '06-fft', card: ['Audio-reactive: a.fft', 'Hydra\'s `a` object, wired to Strudel\'s own master bus — no microphone. Then Stage mode.'],
    widget: 'strudel', play: 16, stageAt: 8,
    args: { title: 'Audio-reactive', theme: 'gruvboxDark', bpm: 126,
      code: `await initHydra({ src: ${HY} })
a.setCutoff(1)
a.setScale(6)
osc(10, 0.1, () => a.fft[0] * 4)
  .kaleid(() => 3 + Math.round(a.fft[1] * 4))
  .modulateScale(osc(2), () => a.fft[1] * 0.5)
  .rotate(() => a.fft[2] * 2, 0.1)
  .color(1, 0.4, () => 0.5 + a.fft[3])
  .out(o0)

stack(
  s("bd*4").bank("RolandTR909").gain(1.1),
  s("[~ oh]*2 [~ hh]*2").gain(0.4),
  s("~ ~ ~ cp").bank("RolandTR909"),
  note("<c2 eb2 f2 g2>*8").s("square").lpf(saw.range(200, 2500).fast(2)).decay(0.1).sustain(0).gain(0.6)
)` },
  },
  {
    id: '07-pianoroll', card: ['2D visuals + 39 editor themes', 'pianoroll · punchcard · scope · spectrum — themes verified against the live bundle, light ones included.'],
    widget: 'strudel', play: 10,
    args: { title: 'pianoroll · solarizedLight', visuals: 'pianoroll', theme: 'solarizedLight', bpm: 100,
      code: `note("<c3 e3 g3 c4 <b3 a3>>*4".add("<0 3 5>")).s("gm_epiano1").room(0.4).delay(0.25)` },
  },
  {
    id: '08-spectrum', card: null,
    widget: 'strudel', play: 10,
    args: { title: 'spectrum · sonicPink', visuals: 'spectrum', theme: 'sonicPink', bpm: 140,
      code: `stack(
  s("bd ~ [~ bd] ~, ~ sd ~ sd").bank("RolandTR707"),
  s("hh*16").gain(sine.range(0.2, 0.6).fast(4)),
  note("<g1 g1 bb1 c2>*8").s("sawtooth").lpf(600).decay(0.08).sustain(0)
)` },
  },
  {
    id: '09-honest', card: ['Honest feedback', 'A misspelled sound no longer sits at "Playing…" forever — the widget tells the model what is silent.'],
    widget: 'strudel', play: 8,
    args: { title: 'Typo in a sound name', theme: 'githubDark', bpm: 120,
      code: `stack(
  s("bd*4").bank("RolandTR909"),
  s("~ snar").bank("RolandTR909")
)` },
  },
  {
    id: '10-abc', card: ['play-sheet-music', 'Style presets with real drums again, swing that swings, in-widget editor, live cursor, MIDI export.'],
    widget: 'abc', play: 16, editAt: 9,
    args: { title: 'Jazz étude', style: 'jazz', instrument: 'vibraphone', swing: 66, tempo: 132,
      abcNotation: `X:1
T:Jazz Étude
M:4/4
L:1/8
Q:1/4=132
K:F
"Fmaj7"A2 c2 e2 c2 | "Dm7"d2 f2 a2 f2 | "Gm7"g2 _b2 d'2 _b2 | "C7"e2 g2 _b2 g2 |
"Fmaj7"a4 e2 c2 | "Bb7"d2 f2 _a2 f2 | "Gm7"g2 d2 "C7"e2 c2 | "Fmaj7"f8 |]` },
  },
];

const TAP_SCRIPT = `
(() => {
  if (!globalThis.BaseAudioContext) return;
  const desc = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'destination');
  const taps = new WeakMap();
  globalThis.__taps = [];
  Object.defineProperty(BaseAudioContext.prototype, 'destination', {
    configurable: true,
    get() {
      if (typeof this.createMediaStreamDestination !== 'function') return desc.get.call(this);
      let t = taps.get(this);
      if (!t) {
        const real = desc.get.call(this);
        const g = this.createGain();
        const d = this.createMediaStreamDestination();
        g.connect(real); g.connect(d);
        // superdough sizes its channel merger from destination.maxChannelCount;
        // a GainNode has none (→ 0 → "outside the range [1, 32]" and silence).
        Object.defineProperty(g, 'maxChannelCount', { value: real.maxChannelCount || 2 });
        t = { g, d, ctx: this };
        taps.set(this, t);
        globalThis.__taps.push(t);
      }
      return t.g;
    },
  });
})();`;

const RECORDER_SCRIPT = `
async () => {
  for (let i = 0; i < 150 && !(globalThis.__taps && globalThis.__taps.length); i++) await new Promise(r => setTimeout(r, 100));
  if (!globalThis.__taps?.length) return null;
  const t = globalThis.__taps[0];
  const rec = new MediaRecorder(t.d.stream, { mimeType: 'audio/webm;codecs=opus' });
  const chunks = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  globalThis.__stopRec = () => new Promise(res => {
    rec.onstop = async () => {
      const blob = new Blob(chunks, { type: 'audio/webm' });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      res(btoa(s));
    };
    rec.stop();
  });
  rec.start(250);
  return Date.now();
}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const frameOf = page => page.frames().find(f => f.url().includes('/widgets/'));

async function waitReady(page) {
  await page.waitForFunction(() => document.getElementById('state')?.textContent?.startsWith('connected'), null, { timeout: 30000 });
}

const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

const manifest = [];
for (const sc of SCENES) {
  if (only && !only.has(sc.id)) continue;
  console.log('▶', sc.id);
  const t0 = Date.now();
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, colorScheme: 'dark',
    recordVideo: { dir: `${OUT}/video`, size: { width: W, height: H } } });
  const page = await ctx.newPage();
  await page.addInitScript(TAP_SCRIPT);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__harness?.bridge, null, { timeout: 15000 });
  await page.evaluate(w => {
    const sel = document.getElementById('widget');
    if (sel.value !== w) { sel.value = w; sel.dispatchEvent(new Event('change')); } else window.__harness.mount();
  }, sc.widget);
  await waitReady(page);
  // Make the widget the whole show: hide the harness chrome, fill the viewport.
  await page.evaluate(() => {
    let el = document.querySelector('iframe');
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      for (const sib of n.parentElement.children) if (sib !== n) sib.style.display = 'none';
      n.style.cssText += ';margin:0;padding:0;width:100vw;height:100vh;position:fixed;inset:0;border:0;display:block;max-width:none;';
    }
    document.body.style.cssText += ';margin:0;padding:0;background:#0b0b10;overflow:hidden;';
    document.documentElement.style.cssText += ';margin:0;padding:0;background:#0b0b10;overflow:hidden;';
  });
  await sleep(300);
  await page.evaluate(async a => { window.__harness.setArgs(a); await window.__harness.send(); }, sc.args);
  const frame = frameOf(page);
  const tRec = await frame.evaluate(`(${RECORDER_SCRIPT.trim()})()`);
  // Wait for "playing" before we count the scene clock.
  let tPlay = Date.now();
  try {
    await frame.waitForFunction(() => {
      const s = document.getElementById('status')?.textContent ?? '';
      return /playing/i.test(s) || /not found/i.test(s);
    }, null, { timeout: 40000 });
    tPlay = Date.now();
  } catch { console.log('  (never reported playing)'); }
  const status0 = await frame.evaluate(() => document.getElementById('status')?.textContent);
  console.log('  status:', status0, 'play after', ((tPlay - t0) / 1000).toFixed(1), 's');

  const actions = [];
  if (sc.stageAt) actions.push([sc.stageAt, async () => { await frame.click('#stage-btn'); console.log('  stage'); }]);
  if (sc.editAt) actions.push([sc.editAt, async () => {
    await frame.click('button[aria-label="Edit the ABC notation"]');
    await sleep(800);
    // Type a small edit: retitle the piece so the score visibly changes.
    await frame.evaluate(() => {
      const ta = document.getElementById('abc-editor');
      ta.value = ta.value.replace('T:Jazz Étude', 'T:Jazz Étude (edited live)');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    console.log('  edit');
  }]);
  let elapsed = 0;
  for (const [at, fn] of actions) { await sleep(Math.max(0, at * 1000 - elapsed)); elapsed = at * 1000; await fn(); }
  await sleep(Math.max(0, sc.play * 1000 - elapsed));
  const statusEnd = await frame.evaluate(() => document.getElementById('status')?.textContent);
  const tEnd = Date.now();

  let audioPath = null;
  if (tRec) {
    const b64 = await frame.evaluate(() => globalThis.__stopRec());
    audioPath = `${OUT}/audio/${sc.id}.webm`;
    fs.writeFileSync(audioPath, Buffer.from(b64, 'base64'));
  }
  await page.screenshot({ path: `${OUT}/out/${sc.id}.png` });
  const video = page.video();
  await ctx.close();
  const vPath = `${OUT}/video/${sc.id}.webm`;
  await video.saveAs(vPath);
  await video.delete().catch(() => {});
  const entry = { id: sc.id, card: sc.card, video: vPath, audio: audioPath,
    audioOffset: tRec ? (tRec - t0) / 1000 : null, start: (tPlay - t0) / 1000 - 0.6, end: (tEnd - t0) / 1000,
    status: statusEnd, errors };
  manifest.push(entry);
  console.log('  done', JSON.stringify({ offset: entry.audioOffset, start: entry.start, end: entry.end, status: statusEnd, errors: errors.length }));
}
await browser.close();
const mf = `${OUT}/manifest${only ? '-' + [...only].join('_') : ''}.json`;
fs.writeFileSync(mf, JSON.stringify(manifest, null, 2));
console.log('manifest →', mf);
