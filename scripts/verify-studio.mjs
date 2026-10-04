// Smoke check of the local studio on the real built widgets (log-style, read the output):
// app-tools host (discover/read/write/human edit/stale/undo/wrong instance/remount,
// play through the app tool with an AnalyserNode tap) and studio.html's WebMCP tools
// (native document.modelContext in Chromium with --enable-experimental-web-platform-features,
// then a registerTool shim to drive them).
//
//   bun run build && bunx vite --config dev/vite.config.ts --host 127.0.0.1 --port 5188
//   BASE=http://127.0.0.1:5188 bun scripts/verify-studio.mjs
import { engine } from "./lib/engine.mjs";
const BASE = process.env.BASE ?? "http://127.0.0.1:5188";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const browser = await engine.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
await ctx.addInitScript(LEVEL_TAP);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("page: " + e.message));
await page.goto(`${BASE}/app-tools.html`);
const logText = () => page.$eval("#log", (e) => e.innerText);
const summary = () => page.$eval("#summary", (e) => e.textContent);
async function waitIdle(label) {
  for (let i = 0; i < 300; i++) {
    const s = await summary();
    if (/completed|failed/.test(s) && !/…$/.test(s)) return s;
    await sleep(200);
  }
  return "timeout " + label;
}
// mount happens automatically?
let s = await waitIdle("mount");
if (/Mounting/.test(s) || /timeout/.test(s)) { await page.click("#mount-both"); s = await waitIdle("mount2"); }
console.log("MOUNT:", s);
const click = async (sel, label) => { await page.click(sel); const r = await waitIdle(label); console.log(label.padEnd(18), "→", r); };
await click('#panes section:nth-child(1) button[data-action="read"]', "read A");
// write A
await page.fill("#source-A", `// agent write\nnote("c3 e3 g3 b3").s("triangle").fast(2)`);
await click('#panes section:nth-child(1) button[data-action="write"]', "write A");
await click('#panes section:nth-child(1) button[data-action="capture"]', "capture A");
// human edit inside widget A to bump revision
const fA = page.frames().find((f) => f.name() === "" && f.url().includes("strudel-app")) ;
const frames = page.frames().filter((f) => f.url().includes("/widgets/strudel-app"));
console.log("widget frames:", frames.length);
const wa = await (await page.$("#widget-A")).contentFrame();
await wa.waitForSelector(".cm-content", { timeout: 30000 });
await wa.click(".cm-content");
await page.keyboard.press("End");
await page.keyboard.type(" // human");
await sleep(500);
await click('#panes section:nth-child(1) button[data-action="read"]', "read A (human)");
const snapA = await page.$eval("#snapshot-A", (e) => e.textContent);
console.log("snapshot has human edit:", snapA.includes("// human"));
await click('#panes section:nth-child(1) button[data-action="stale"]', "stale A");
await click('#panes section:nth-child(1) button[data-action="undo"]', "undo A");
await click("#wrong-instance", "wrong-instance");
await click("#remount-a", "remount-a");
await click("#old-instance", "old-instance");
// play: click inside the frame AFTER Strudel loaded, then play via app tool
const frames2 = page.frames().filter((f) => f.url().includes("/widgets/strudel-app"));
const wa2 = await (await page.$("#widget-A")).contentFrame();
await wa2.waitForSelector(".cm-content", { timeout: 30000 });
await sleep(1500);
await wa2.click(".cm-content");
await wa2.evaluate(() => { globalThis.__peak = 0; });
await click('#panes section:nth-child(1) button[data-action="play"]', "play A (tool)");
await sleep(3000);
const peak = await wa2.evaluate(() => globalThis.__peak);
const status = await wa2.evaluate(() => document.getElementById("status")?.textContent);
console.log((await logText()).split("\n").filter(l=>/play-current-music|playback/.test(l)).slice(-3).map(l=>l.slice(0,600)).join("\n"));
console.log("DBG", JSON.stringify(await wa2.evaluate(() => ({ ctx: globalThis.getAudioContext?.().state, taps: typeof globalThis.__peak, started: document.querySelector("strudel-editor")?.editor?.repl?.state?.started }))));
console.log("DBG2", JSON.stringify(await wa2.evaluate(async () => { const c = getAudioContext(); const ctl = globalThis.getSuperdoughAudioController?.(); const g = ctl?.output?.destinationGain?.gain?.value; globalThis.__peak=0; const o=c.createOscillator(); o.connect(c.destination); o.start(); await new Promise(r=>setTimeout(r,300)); o.stop(); return { g, oscPeak: globalThis.__peak, sr: c.sampleRate, ct: c.currentTime }; })));
console.log("PLAY peak", peak.toFixed(3), "status", status);
await click('#panes section:nth-child(1) button[data-action="stop"]', "stop A");
await wa2.evaluate(() => { globalThis.__peak = 0; });
await sleep(1500);
console.log("after stop peak", (await wa2.evaluate(() => globalThis.__peak)).toFixed(3));
const L = await logText();
console.log("CHECK lines:\n" + L.split("\n").filter((l) => /CHECK|FAILURE/.test(l)).map(l=>l.slice(0,220)).join("\n"));
console.log("errors:", errors);
// studio.html
const p2 = await ctx.newPage();
const e2 = [];
p2.on("pageerror", (e) => e2.push(e.message));
await p2.goto(`${BASE}/studio.html`);
await sleep(8000);
const tools = await p2.evaluate(() => {
  const mc = document.modelContext || navigator.modelContext;
  return { hasModelContext: !!mc, body: document.body.innerText.slice(0, 300) };
});
console.log("studio:", JSON.stringify(tools), "errors:", e2);
await browser.close();

// ---- WebMCP: real flag probe, then a document.modelContext shim ----
for (const args of [["--enable-experimental-web-platform-features"], ["--enable-features=WebMCP,WebMCPTesting"]]) {
  const b = await engine.launch({ headless: true, args });
  const pg = await b.newPage();
  await pg.goto(`${BASE}/studio.html`);
  console.log("native modelContext with", args.join(" "), "→", await pg.evaluate(() => ({ doc: !!document.modelContext, nav: !!navigator.modelContext })));
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
await sp.waitForFunction(() => Object.keys(window.__tools || {}).length >= 9, null, { timeout: 30000 }).catch(() => {});
const call = (name, args) => sp.evaluate(async ([n, a]) => { const r = await window.__tools[n].execute(a); return r; }, [name, args]);
console.log("WebMCP tools:", await sp.evaluate(() => Object.keys(window.__tools)));
let st = JSON.parse((await call("get-studio-state", {})).content[0].text);
console.log("state:", st.mode, st.revision, st.playback, JSON.stringify(st.args).slice(0, 80));
let r = await call("set-pattern", { code: 's("bd*4, hh*8")', instanceId: st.instanceId, expectedRevision: st.revision });
console.log("set-pattern:", r.isError ? "ERR " + r.content[0].text : "ok");
st = JSON.parse((await call("get-studio-state", {})).content[0].text);
r = await call("set-pattern", { code: 's("cp")', instanceId: st.instanceId, expectedRevision: st.revision - 1 });
console.log("stale set-pattern rejected:", !!r.isError, r.content[0].text.slice(0, 80));
const wf = sp.frames().find((f) => f.url().includes("strudel-app"));
await wf.waitForSelector(".cm-content", { timeout: 30000 });
await sleep(1500);
await wf.click(".cm-content");
await wf.evaluate(() => { globalThis.__peak = 0; });
r = await call("play-current-music", { mode: "live", instanceId: st.instanceId, expectedRevision: st.revision });
await sleep(2500);
console.log("WebMCP play:", JSON.parse(r.content[0].text).playback, "peak", (await wf.evaluate(() => globalThis.__peak)).toFixed(3));
await call("stop-music", {});
st = JSON.parse((await call("get-studio-state", {})).content[0].text);
r = await call("undo-studio-edit", { mode: "live", instanceId: st.instanceId, expectedRevision: st.revision });
console.log("undo:", r.isError ? "ERR " + r.content[0].text : JSON.parse(r.content[0].text).args.code.slice(0, 60));
console.log("studio errors:", se);
await b3.close();
