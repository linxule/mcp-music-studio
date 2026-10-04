// Acceptance check for the full player on share links, in a real browser,
// against the real Worker (wrangler dev):
//   - /play?c=… hosts the REAL widget (stage, visuals, controls), with the
//     frame granted mic / motion / MIDI / fullscreen;
//   - nothing plays until Play is pressed, and then it is audible (measured);
//   - downloads are offered (this host implements them);
//   - /s/<id> loads a live session's pattern and joins it as a second screen.
//
//   bun run build
//   (cd worker && bunx wrangler dev --port 8798)
//   bun scripts/verify-share-player.mjs
import { engine } from "./lib/engine.mjs";

const ORIGIN = process.env.ORIGIN ?? "http://127.0.0.1:8798";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};
const ok = (msg) => console.log(`✓ ${msg}`);

const LEVEL_TAP = `(() => {
  if (!globalThis.BaseAudioContext) return;
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
})();`;

const b64 = (s) => Buffer.from(s, "utf8").toString("base64url");
const CODE = `const vol = fader('vol', { init: 0.9 })\ns("bd*4, hh*8").gain(vol).pianoroll()`;

const browser = await engine.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
await context.addInitScript(LEVEL_TAP);
const page = await context.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

// ---- /play: the full player ----
const res = await page.goto(`${ORIGIN}/play?c=${b64(CODE)}&title=${encodeURIComponent("Share check")}&bpm=120`);
res.status() === 200 ? ok("/play answers 200") : fail(`/play answered ${res.status()}`);
const frameEl = await page.waitForSelector("#stage iframe", { timeout: 15000 });
const allow = await frameEl.getAttribute("allow");
["autoplay", "microphone", "accelerometer", "gyroscope", "midi", "fullscreen"].every((f) => allow.includes(f))
  ? ok(`frame allow: ${allow}`)
  : fail(`frame allow: ${allow}`);
const frame = await frameEl.contentFrame();
await frame.waitForFunction(() => /Ready|Play/.test(document.getElementById("status")?.textContent ?? ""), null, { timeout: 30000 });
const ui = await frame.evaluate(() => ({
  status: document.getElementById("status")?.textContent,
  stage: !!document.getElementById("stage-btn"),
  viz: !!document.getElementById("viz-btn"),
  editor: !!document.querySelector("strudel-editor"),
  download: !document.getElementById("download-btn")?.hidden,
  record: !document.getElementById("record-btn")?.hidden,
  send: !document.getElementById("send-btn")?.hidden,
  code: document.querySelector("strudel-editor")?.editor?.code ?? "",
}));
ui.editor && ui.stage && ui.viz ? ok("the real widget: editor, Stage and Visuals present") : fail(`widget UI: ${JSON.stringify(ui)}`);
ui.code.includes("setcps(0.5)") && ui.code.includes("fader('vol'") ? ok("code arrived with the 120 bpm tempo applied") : fail(`code: ${ui.code}`);
ui.download && ui.record ? ok("Record and download offered (this host implements downloads)") : fail(`download/record hidden: ${JSON.stringify(ui)}`);
!ui.send ? ok("no 'Send to chat' (there is no chat here)") : fail("send-to-chat shown");
await sleep(2500);
const before = await frame.evaluate(() => globalThis.__peak ?? 0);
before < 0.01 ? ok(`silent until Play (peak ${before.toFixed(3)}, status "${ui.status}")`) : fail(`sound before Play: ${before}`);
await frame.click("#play-btn");
await sleep(3000);
const after = await frame.evaluate(() => globalThis.__peak ?? 0);
after > 0.05 ? ok(`Play → audible (peak ${after.toFixed(3)})`) : fail(`no sound after Play (peak ${after})`);
const strip = await frame.evaluate(() => document.querySelectorAll(".ms-controls > *").length);
strip === 1 ? ok("the controls strip renders on the share page") : fail(`controls strip: ${strip}`);

// ---- /s/<id>: a live session's second screen ----
const post = async (path, body) =>
  (await fetch(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "text/plain" }, body: body && JSON.stringify(body) })).json();
const { id } = await post("/session/new");
await post(`/session/${id}/update`, { code: 's("cp*2").gain(0.8)', quantize: 1 });
const sPage = await context.newPage();
const sRes = await sPage.goto(`${ORIGIN}/s/${id}`);
sRes.status() === 200 ? ok(`/s/${id} answers 200`) : fail(`/s answered ${sRes.status()}`);
const sFrame = await (await sPage.waitForSelector("#stage iframe")).contentFrame();
await sFrame.waitForFunction(() => document.getElementById("session-badge")?.textContent === "● live", null, { timeout: 30000 });
ok("the session page's widget joined (badge ● live)");
await sFrame
  .waitForFunction(() => (document.querySelector("strudel-editor")?.editor?.code ?? "").length > 0, null, { timeout: 30000 })
  .catch(() => undefined);
const sCode = await sFrame.evaluate(() => document.querySelector("strudel-editor")?.editor?.code ?? "");
sCode.includes('s("cp*2")') ? ok("it loaded the session's current pattern") : fail(`session code: ${sCode}`);
await sleep(1500);
const state = (await (await fetch(`${ORIGIN}/session/${id}/state?peek=1`)).json()).text;
/player on Music Studio share page/.test(state) ? ok("get-session sees the share page as a player") : fail(`state:\n${state}`);
(await (await fetch(`${ORIGIN}/s/aaaaaaaaaaaaaaaa`)).status) === 404 ? ok("an unknown session 404s") : fail("unknown session did not 404");

const real = errors.filter((e) => !/favicon|AudioContext was not allowed/i.test(e));
real.length ? fail(`console errors: ${real.slice(0, 3).join(" | ")}`) : ok("no console errors");
await browser.close();
