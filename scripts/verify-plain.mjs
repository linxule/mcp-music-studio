// Acceptance check for the plain path — the one most chats take: ask for a
// beat, get one player. No session, no controls, no sensors, no stage. In a
// real browser, through the real widget (dev harness, no Worker needed):
//
//   - it sounds (measured at the output);
//   - none of the optional modules wakes up: no controls strip, no stage,
//     no session badge/Pass/End, no request to a session route, no microphone
//     or motion permission asked, no console errors.
//
// Then a negative control: the same pattern with a fader and tilt() must put
// controls on the strip, so the probes are shown to be able to fail (a sensor
// always puts its by-hand backup on the strip, which covers sensors where
// headless Chromium has no motion events to spy on).
//
//   bun run build
//   bunx vite --config dev/vite.config.ts --port 5177
//   node scripts/verify-plain.mjs
import { engine } from "./lib/engine.mjs";

const HARNESS = process.env.HARNESS ?? "http://localhost:5177/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};
const ok = (msg) => console.log(`✓ ${msg}`);

// Output level meter + spies on every permission an optional module could ask for.
const PROBES = `(() => {
  const desc = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'destination');
  const taps = new WeakMap();
  globalThis.__peak = 0;
  Object.defineProperty(BaseAudioContext.prototype, 'destination', { configurable: true, get() {
    if (this instanceof OfflineAudioContext) return desc.get.call(this);
    let t = taps.get(this);
    if (!t) {
      const real = desc.get.call(this), g = this.createGain(), a = this.createAnalyser();
      a.fftSize = 512; g.connect(real); g.connect(a);
      Object.defineProperty(g, 'maxChannelCount', { value: real.maxChannelCount || 2 });
      const buf = new Float32Array(512);
      setInterval(() => { a.getFloatTimeDomainData(buf); let p = 0; for (const v of buf) p = Math.max(p, Math.abs(v)); globalThis.__peak = Math.max(globalThis.__peak, p); }, 10);
      t = g; taps.set(this, t);
    }
    return t;
  } });
  globalThis.__asked = [];
  const md = navigator.mediaDevices;
  if (md?.getUserMedia) { const g = md.getUserMedia.bind(md); md.getUserMedia = (c) => { globalThis.__asked.push('getUserMedia'); return g(c); }; }
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, ...rest) {
    if (type === 'deviceorientation' || type === 'devicemotion') globalThis.__asked.push(type);
    return add.call(this, type, ...rest);
  };
  for (const E of [globalThis.DeviceOrientationEvent, globalThis.DeviceMotionEvent]) {
    if (!E) continue;
    const real = E.requestPermission;
    E.requestPermission = (...a) => { globalThis.__asked.push(E.name + '.requestPermission'); return real ? real.apply(E, a) : Promise.resolve('granted'); };
  }
})();`;

const CODE = `setcps(0.5)
stack(
  s("bd*4").bank('RolandTR909'),
  s("~ hh ~ hh").bank('RolandTR909'),
  note("c2 eb2 g2 bb2").s('sawtooth').lpf(800)
).pianoroll()`;

const NEGATIVE = CODE.replace(".lpf(800)", ".lpf(tilt().x.range(300, 2000)).gain(fader('vol'))");
if (NEGATIVE === CODE) throw new Error("negative control did not change the code");

const browser = await engine.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });

async function play(code) {
  const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
  await context.addInitScript(PROBES);
  const page = await context.newPage();
  const consoleErrors = [];
  const sessionRequests = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("request", (r) => /\/session(\/|$)/.test(new URL(r.url()).pathname) && sessionRequests.push(r.url()));
  await page.goto(HARNESS);
  await page.waitForFunction(() => document.getElementById("state")?.textContent?.startsWith("connected"), null, { timeout: 30000 });
  await page.fill("#args", JSON.stringify({ code, autoplay: true }));
  await page.click("#send");
  const frame = () => page.frames().find((f) => f.url().includes("/widgets/"));
  for (let i = 0; i < 100 && !frame(); i++) await sleep(100);
  if (!frame()) throw new Error("the widget never loaded");
  let peak = 0;
  for (let i = 0; i < 40 && peak < 0.05; i++) {
    await sleep(250);
    peak = await frame().evaluate(() => globalThis.__peak);
  }
  await sleep(3000); // let anything lazy wake up, if it would
  const ui = await frame().evaluate(() => {
    // Fail closed: a renamed element must break the check, not pass it.
    const need = (sel) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`selector ${sel} matched nothing — update verify-plain`);
      return el;
    };
    return {
      // The strip exists only once a control is declared; the negative
      // control below proves this selector still finds it.
      controls: document.querySelectorAll(".ms-controls > *").length,
      stage: need(".repl-section").classList.contains("stage-on"),
      badge: !need("#session-badge").hidden,
      pass: !need("#pass-btn").hidden,
      end: !need("#end-btn").hidden,
      asked: globalThis.__asked,
    };
  });
  await context.close();
  return { peak, ui, sessionRequests, consoleErrors: consoleErrors.filter((e) => !/favicon|DevTools/.test(e)) };
}

const plain = await play(CODE);
plain.peak > 0.05 ? ok(`it plays (peak ${plain.peak.toFixed(3)})`) : fail(`no sound (peak ${plain.peak})`);
const { ui } = plain;
ui.controls === 0 ? ok("no controls strip") : fail(`${ui.controls} controls on the strip`);
!ui.stage ? ok("the stage stays closed (code in view)") : fail("the stage opened by itself");
!ui.badge && !ui.pass && !ui.end ? ok("no session badge, Pass or End") : fail(`session UI showing: ${JSON.stringify(ui)}`);
plain.sessionRequests.length === 0 ? ok("no request to a session route") : fail(`session requests: ${plain.sessionRequests.join(", ")}`);
ui.asked.length === 0 ? ok("no microphone or motion permission asked") : fail(`asked for: ${ui.asked.join(", ")}`);
plain.consoleErrors.length === 0 ? ok("no console errors") : fail(`console errors:\n${plain.consoleErrors.join("\n")}`);

const negative = await play(NEGATIVE);
negative.ui.controls >= 2
  ? ok(`negative control: a fader and tilt() put ${negative.ui.controls} controls on the strip`)
  : fail(`negative control: expected ≥2 controls, got ${negative.ui.controls} — the strip probe can't fail`);
await browser.close();
