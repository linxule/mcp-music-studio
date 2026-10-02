// Acceptance check for live sessions, in a real browser, through the real
// widget and the real Durable Object (wrangler dev):
//
//   - the widget joins the session the tool result names, and reports;
//   - update-session swaps a pattern in ON THE BAR (measured: the audio level,
//     binned by the widget's own cycle(), is silent before the boundary and
//     loud from it), without a new player, and the model gets the answer;
//   - the human's taps, code edits and "Pass" reach get-session.
//
//   bun run build
//   (cd worker && bunx wrangler dev --port 8799)
//   bunx vite --config dev/vite.config.ts --port 5177
//   bun scripts/verify-session.mjs
import { chromium } from "playwright";

const HARNESS = process.env.HARNESS ?? "http://localhost:5177/";
const ORIGIN = process.env.SESSION_ORIGIN ?? "http://127.0.0.1:8799";
const QUANTIZE = Number(process.env.QUANTIZE ?? 2);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};
const ok = (msg) => console.log(`✓ ${msg}`);

// Same level tap as verify-stage.mjs: per-sample peak, binned by cycle().
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
        a.fftSize = 512;
        g.connect(real); g.connect(a);
        Object.defineProperty(g, 'maxChannelCount', { value: real.maxChannelCount || 2 });
        const buf = new Float32Array(a.fftSize);
        setInterval(() => {
          a.getFloatTimeDomainData(buf);
          let peak = 0;
          for (const v of buf) peak = Math.max(peak, Math.abs(v));
          globalThis.__levels.push([peak, typeof globalThis.cycle === 'function' ? globalThis.cycle() : NaN]);
        }, 10);
        t = g;
        taps.set(this, t);
      }
      return t;
    },
  });
})();`;

const post = async (path, body) => {
  const res = await fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return [res.status, await res.json()];
};
const state = async (id) => (await (await fetch(`${ORIGIN}/session/${id}/state`)).json()).text;

const [, { id }] = await post("/session/new");
ok(`session ${id} opened`);

// The first pattern is SILENT (gain 0) so the swap is measurable: the level
// must stay ~0 until the boundary and rise from it.
const SILENT = `setcps(0.5)\nonTap(() => {})\ns("bd*4").gain(0)`;
const LOUD = `setcps(0.5)\nonTap(() => {})\ns("bd*4").gain(0.9)`;

const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
await context.addInitScript(LEVEL_TAP);
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
await page.goto(HARNESS);
await page.waitForFunction(() => document.getElementById("state")?.textContent?.startsWith("connected"), null, { timeout: 30000 });
await page.evaluate(([sid, origin]) => window.__harness.setResultMeta({ session: { id: sid, origin } }), [id, ORIGIN]);
await page.fill("#args", JSON.stringify({ code: SILENT, autoplay: true }));
await page.click("#send");
const frame = () => page.frames().find((f) => f.url().includes("/widgets/"));
for (let i = 0; i < 100 && !frame(); i++) await sleep(100);

// Joined and reporting?
let text = "";
for (let i = 0; i < 60; i++) {
  await sleep(500);
  text = await state(id);
  if (/player on/.test(text) && /playing/.test(text)) break;
}
/player on/.test(text) ? ok("the widget joined the session") : fail(`no join: ${text}`);
/widget report: Strudel widget: playing/.test(text) ? ok("its runtime report reached the session") : fail(`no report: ${text}`);
const badge = await frame().evaluate(() => document.getElementById("session-badge")?.textContent);
badge === "● live" ? ok(`badge reads "${badge}"`) : fail(`badge reads "${badge}"`);

// The model swaps in the loud pattern, quantized.
await sleep(800);
const t0 = Date.now();
const [status, outcome] = await post(`/session/${id}/update`, { code: LOUD, quantize: QUANTIZE });
const waited = Date.now() - t0;
status === 200 && outcome.applied?.ok
  ? ok(`update applied (rev ${outcome.applied.rev}) at cycle ${outcome.applied.cycle}, answered in ${waited} ms`)
  : fail(`update: ${status} ${JSON.stringify(outcome)}`);
const boundary = outcome.applied?.cycle;
Number.isInteger(boundary) && boundary % QUANTIZE === 0
  ? ok(`the boundary is a multiple of ${QUANTIZE} (cycle ${boundary})`)
  : fail(`boundary ${boundary} is not on a multiple of ${QUANTIZE}`);

// Listen through the boundary.
for (let i = 0; i < 60; i++) {
  await sleep(250);
  const c = await frame().evaluate(() => (typeof cycle === "function" ? cycle() : NaN));
  if (c > boundary + 1.2) break;
}
const levels = await frame().evaluate(() => globalThis.__levels);
const before = levels.filter(([, c]) => c > boundary - 1 && c < boundary - 0.05).map(([p]) => p);
const after = levels.filter(([, c]) => c >= boundary && c < boundary + 1).map(([p]) => p);
const firstLoud = levels.find(([p, c]) => p > 0.05 && c > boundary - 1)?.[1];
const peak = (xs) => xs.reduce((m, x) => Math.max(m, x), 0);
console.log("  loud samples near the boundary (cycle):", levels.filter(([p, c]) => p > 0.05 && c > boundary - 1 && c < boundary + 0.3).map(([, c]) => c.toFixed(3)).slice(0, 12).join(" "));
// cycle() is the scheduler's estimate of what is heard; the analyser polls
// every 10 ms over a 512-sample window — allow 0.05 cycle of skew.
peak(before) < 0.01 ? ok(`silent before the boundary (peak ${peak(before).toFixed(3)})`) : fail(`sound before the boundary (peak ${peak(before).toFixed(3)})`);
peak(after) > 0.1 ? ok(`loud from the boundary (peak ${peak(after).toFixed(3)})`) : fail(`no sound after the boundary (peak ${peak(after).toFixed(3)})`);
firstLoud !== undefined && firstLoud >= boundary - 0.05 && firstLoud < boundary + 0.1
  ? ok(`first sound at cycle ${firstLoud.toFixed(3)} — on the bar`)
  : fail(`first sound at cycle ${firstLoud}`);
const players = await page.evaluate(() => document.querySelectorAll("iframe").length);
players === 1 ? ok("still one player") : fail(`${players} players`);

// The human: taps, an edit, a pass.
const box = await frame().evaluate(() => {
  const r = document.querySelector(".repl-section").getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
});
const frameBox = await (await page.$("iframe")).boundingBox();
await frame().evaluate(() => document.getElementById("stage-btn")?.click()); // hide the code: the whole frame is the stage
await sleep(300);
for (const [fx, fy] of [[0.1, 0.8], [0.15, 0.85], [0.2, 0.9]]) {
  await page.mouse.click(frameBox.x + box.x + box.w * fx, frameBox.y + box.y + box.h * fy);
  await sleep(150);
}
await frame().evaluate(() => document.getElementById("stage-btn")?.click());
const EDITED = `setcps(0.5)\nonTap(() => {})\ns("bd*4, hh*8").gain(0.9)`;
await frame().evaluate(async (code) => {
  const editor = document.querySelector("strudel-editor")?.editor;
  editor.setCode(code);
  await editor.evaluate(true);
}, EDITED);
await frame().evaluate(() => document.getElementById("pass-btn")?.click());
await sleep(2500);
text = await state(id);
/the human tapped 3 times/.test(text) ? ok("taps reached the session") : fail(`taps missing:\n${text}`);
text.includes('s("bd*4, hh*8")') && /edited the code and ran it/.test(text) ? ok("the human's edit reached the session, with its code") : fail(`edit missing:\n${text}`);
/passed the turn to you/.test(text) ? ok("Pass reached the session") : fail(`pass missing:\n${text}`);
const message = await page.evaluate(() => window.__harness.entries?.filter?.((e) => /ui\/message/.test(JSON.stringify(e))).length ?? null);
console.log(`  (host received ui/message entries: ${message})`);

// A broken update comes back as a failure, and the previous pattern plays on.
const [, broken] = await post(`/session/${id}/update`, { code: "s(\"bd*4\").gain(0.9).nonsense()", quantize: 1 });
broken.applied && !broken.applied.ok
  ? ok(`a pattern that throws in the player comes back failed: ${broken.applied.error.slice(0, 60)}`)
  : fail(`broken update: ${JSON.stringify(broken)}`);

console.log("\n--- get-session, as the model would read it ---\n" + (await state(id)).slice(0, 1600));
const real = consoleErrors.filter((e) => !/favicon|nonsense/i.test(e));
real.length ? fail(`console errors: ${real.slice(0, 3).join(" | ")}`) : ok("no console errors");
await browser.close();
