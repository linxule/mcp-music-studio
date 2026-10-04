// Acceptance check of the local studio on the real built widgets:
//   1. app-tools.html — the widget's own MCP Apps tools through a real host:
//      discover/read/write/human edit/stale/undo/wrong instance/remount, and
//      play through the app tool (audio measured with an AnalyserNode tap);
//   2. studio.html — the same tools offered to a browser agent over WebMCP
//      (native document.modelContext where the flag exists, then a
//      registerTool shim to drive them): set, stale set, play, swap, undo.
//
//   bun run build && bunx vite --config dev/vite.config.ts --host 127.0.0.1 --port 5188
//   BASE=http://127.0.0.1:5188 node scripts/verify-studio.mjs
import { BROWSER, engine } from "./lib/engine.mjs";

const BASE = process.env.BASE ?? "http://127.0.0.1:5188";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (msg) => console.log(`✓ ${msg}`);
const fail = (msg) => {
  failed++;
  console.error(`✗ ${msg}`);
};
const check = (cond, msg, detail = "") => (cond ? ok(msg) : fail(detail ? `${msg} — ${detail}` : msg));

const LEVEL_TAP = `(() => {
  const desc = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'destination');
  const taps = new WeakMap(); globalThis.__peak = 0;
  Object.defineProperty(BaseAudioContext.prototype, 'destination', { configurable: true, get() {
    if (this instanceof OfflineAudioContext) return desc.get.call(this);
    let t = taps.get(this);
    if (!t) { const real = desc.get.call(this), g = this.createGain(), a = this.createAnalyser();
      a.fftSize = 512; g.connect(real); g.connect(a);
      Object.defineProperty(g, 'maxChannelCount', { value: real.maxChannelCount || 2 });
      const buf = new Float32Array(512);
      setInterval(() => { a.getFloatTimeDomainData(buf); let p = 0; for (const v of buf) p = Math.max(p, Math.abs(v)); globalThis.__peak = Math.max(globalThis.__peak, p); }, 10);
      t = g; taps.set(this, t); }
    return t; } });
})();`;

// ---- 1. app-tools.html -------------------------------------------------------
const browser = await engine.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
await ctx.addInitScript(LEVEL_TAP);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`${BASE}/app-tools.html`);
const logText = () => page.$eval("#log", (e) => e.innerText);
const summary = () => page.$eval("#summary", (e) => e.textContent);
async function waitIdle() {
  for (let i = 0; i < 300; i++) {
    const s = await summary();
    if (/completed|failed/.test(s) && !/…$/.test(s)) return s;
    await sleep(200);
  }
  return "timeout";
}
let s = await waitIdle();
if (/Mounting|timeout/.test(s)) {
  await page.click("#mount-both");
  s = await waitIdle();
}
check(/completed/.test(s), "app-tools: both widgets mounted", s);

// Each harness button runs one tool sequence; "completed" means its own
// expectations held (the harness logs FAILURE lines for rejections it EXPECTS,
// and CHECK lines for what it verified).
const step = async (sel, label) => {
  await page.click(sel);
  const r = await waitIdle();
  check(/completed/.test(r), `app-tools: ${label}`, r);
};
const A = '#panes section:nth-child(1) button[data-action="%"]';
await step(A.replace("%", "read"), "read");
await page.fill("#source-A", `// agent write\nnote("c3 e3 g3 b3").s("triangle").fast(2)`);
await step(A.replace("%", "write"), "write");
await step(A.replace("%", "capture"), "capture");
const wa = await (await page.$("#widget-A")).contentFrame();
await wa.waitForSelector(".cm-content", { timeout: 30000 });
await wa.click(".cm-content");
await page.keyboard.press("End");
await page.keyboard.type(" // human");
await sleep(500);
await step(A.replace("%", "read"), "read after a human edit");
check((await page.$eval("#snapshot-A", (e) => e.textContent)).includes("// human"), "app-tools: the snapshot carries the human's edit");
await step(A.replace("%", "stale"), "a stale write is rejected");
await step(A.replace("%", "undo"), "undo");
await step("#wrong-instance", "a write to the wrong instance is rejected");
await step("#remount-a", "remount");
await step("#old-instance", "a write to the old instance is rejected");

const wa2 = await (await page.$("#widget-A")).contentFrame();
await wa2.waitForSelector(".cm-content", { timeout: 30000 });
await sleep(1500);
await wa2.click(".cm-content"); // a real gesture INSIDE the frame, after Strudel loaded
await wa2.evaluate(() => { globalThis.__peak = 0; });
await step(A.replace("%", "play"), "play through the app tool");
await sleep(3000);
const peak = await wa2.evaluate(() => globalThis.__peak);
check(peak > 0.05, `app-tools: it sounds (peak ${peak.toFixed(3)})`);
await step(A.replace("%", "stop"), "stop");
await sleep(1500); // release tails
await wa2.evaluate(() => { globalThis.__peak = 0; });
await sleep(1000);
const quiet = await wa2.evaluate(() => globalThis.__peak);
check(quiet < 0.01, `app-tools: silent after stop (peak ${quiet.toFixed(3)})`);
const checks = (await logText()).split("\n").filter((l) => /SUCCESS .*CHECK/.test(l));
check(checks.length >= 4, `app-tools: the harness verified ${checks.length} CHECK conditions`);
check(errors.length === 0, "app-tools: no page errors", errors.join(" | "));
await browser.close();

// ---- 2. studio.html over WebMCP --------------------------------------------
if (BROWSER === "chromium") {
  // The real flag: document.modelContext appears (tools can't be driven from
  // here, hence the shim below).
  const b = await engine.launch({ headless: true, args: ["--enable-experimental-web-platform-features"] });
  const pg = await b.newPage();
  await pg.goto(`${BASE}/studio.html`);
  check(await pg.evaluate(() => !!document.modelContext), "studio: native document.modelContext with the Chromium flag");
  await b.close();
}

const b3 = await engine.launch({ headless: true });
const c3 = await b3.newContext({ viewport: { width: 1400, height: 1000 } });
await c3.addInitScript(LEVEL_TAP);
await c3.addInitScript(() => {
  if (!location.pathname.endsWith("/studio.html")) return;
  window.__tools = {};
  Object.defineProperty(document, "modelContext", { value: { registerTool(t) { window.__tools[t.name] = t; } }, configurable: true });
});
const sp = await c3.newPage();
const se = [];
sp.on("pageerror", (e) => se.push(e.message));
await sp.goto(`${BASE}/studio.html`);
const EXPECTED = ["get-studio-state", "open-studio-mode", "explain-selection", "suggest-edit", "set-pattern", "swap-pattern", "set-score", "play-current-music", "stop-music", "undo-studio-edit"];
await sp.waitForFunction((n) => Object.keys(window.__tools || {}).length >= n, EXPECTED.length, { timeout: 30000 }).catch(() => {});
const names = await sp.evaluate(() => Object.keys(window.__tools));
const missing = EXPECTED.filter((n) => !names.includes(n));
check(missing.length === 0, `studio: all ${EXPECTED.length} WebMCP tools registered`, `missing ${missing.join(", ")}`);

const call = (name, args) => sp.evaluate(async ([n, a]) => window.__tools[n].execute(a), [name, args]);
const read = async () => JSON.parse((await call("get-studio-state", {})).content[0].text);
let st = await read();
let r = await call("set-pattern", { code: 's("bd*4, hh*8")', instanceId: st.instanceId, expectedRevision: st.revision });
check(!r.isError, "studio: set-pattern", r.content?.[0]?.text);
st = await read();
r = await call("set-pattern", { code: 's("cp")', instanceId: st.instanceId, expectedRevision: st.revision - 1 });
check(!!r.isError && /Revision conflict/.test(r.content[0].text), "studio: a stale set-pattern is rejected");

const wf = sp.frames().find((f) => f.url().includes("strudel-app"));
await wf.waitForSelector(".cm-content", { timeout: 30000 });
await sleep(1500);
await wf.click(".cm-content");
await wf.evaluate(() => { globalThis.__peak = 0; });
r = await call("play-current-music", { mode: "live", instanceId: st.instanceId, expectedRevision: st.revision });
await sleep(2500);
const played = JSON.parse(r.content[0].text).playback;
const wpeak = await wf.evaluate(() => globalThis.__peak);
check(played === "playing" && wpeak > 0.05, `studio: play-current-music plays (peak ${wpeak.toFixed(3)})`, `playback ${played}`);

// swap-pattern: the new code takes over while it plays, on the boundary.
st = await read();
r = await call("swap-pattern", { code: 's("cp*4").gain(0.8)', quantize: 0, instanceId: st.instanceId, expectedRevision: st.revision });
const swapped = r.isError ? null : JSON.parse(r.content[0].text);
check(!r.isError && (swapped?.swap?.cycle !== undefined || swapped?.lastSwap), "studio: swap-pattern swapped while playing", r.content?.[0]?.text?.slice(0, 200));
st = await read();
check(st.args.code.includes('s("cp*4")') && st.playback === "playing", "studio: the swapped code is in the editor and still playing", `${st.playback} ${st.args.code.slice(0, 60)}`);

await call("stop-music", {});
st = await read();
r = await call("undo-studio-edit", { mode: "live", instanceId: st.instanceId, expectedRevision: st.revision });
const undone = r.isError ? null : JSON.parse(r.content[0].text);
check(!r.isError && undone.args.code.includes('s("bd*4, hh*8")') && undone.playback === "stopped", "studio: undo restores the code before the swap, stopped", r.content?.[0]?.text?.slice(0, 200));
check(se.length === 0, "studio: no page errors", se.join(" | "));
await b3.close();

console.log(failed ? `${failed} failed` : "all passed");
process.exitCode = failed ? 1 : 0;
