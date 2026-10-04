// Acceptance check for the swap-pattern widget tool, in a real browser,
// through the real AppBridge.callTool of dev/app-tools.html:
//   - while playing, swap-pattern puts new code in ON the quantize boundary
//     (measured: the old, silent pattern until the bar; sound from it);
//   - the answer names the boundary cycle, on a multiple of quantize;
//   - a stale revision is rejected; a newer swap supersedes a waiting one
//     (which answers); a human edit during the wait is not swapped in; a long
//     quantize answers "queued" and is readable until it lands; stop during
//     the wait answers; a stopped player changes nothing; undo restores the
//     previous source, stopped.
//
//   bun run build && bunx vite --config dev/vite.config.ts --host 127.0.0.1 --port 5188
//   BASE=http://127.0.0.1:5188 bun scripts/verify-swap.mjs
import { engine } from "./lib/engine.mjs";

const BASE = process.env.BASE ?? "http://127.0.0.1:5188";
const QUANTIZE = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (m) => console.log(`✓ ${m}`);
const fail = (m) => (failed++, console.error(`✗ ${m}`));

// Per-sample peak binned by the widget's own cycle() (as in verify-session.mjs).
const LEVEL_TAP = `(() => {
  if (!globalThis.BaseAudioContext) return;
  const desc = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'destination');
  const taps = new WeakMap();
  globalThis.__levels = [];
  Object.defineProperty(BaseAudioContext.prototype, 'destination', { configurable: true, get() {
    if (typeof this.createAnalyser !== 'function' || this instanceof OfflineAudioContext) return desc.get.call(this);
    let t = taps.get(this);
    if (!t) {
      const real = desc.get.call(this), g = this.createGain(), a = this.createAnalyser();
      a.fftSize = 512; g.connect(real); g.connect(a);
      Object.defineProperty(g, 'maxChannelCount', { value: real.maxChannelCount || 2 });
      const buf = new Float32Array(a.fftSize);
      setInterval(() => { a.getFloatTimeDomainData(buf); let p = 0; for (const v of buf) p = Math.max(p, Math.abs(v));
        globalThis.__levels.push([p, typeof globalThis.cycle === 'function' ? globalThis.cycle() : NaN]); }, 10);
      t = g; taps.set(this, t);
    }
    return t;
  } });
})();`;

const SILENT = `setcps(0.5)\ns("bd*4").gain(0)`;
const LOUD = `setcps(0.5)\ns("bd*4").gain(0.9)`;

const browser = await engine.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
await ctx.addInitScript(LEVEL_TAP);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`${BASE}/app-tools.html`);
await page.waitForFunction(() => window.__appTools?.panes?.[0]?.ready && window.__appTools.panes[0].snapshot, null, { timeout: 60000 });
// The page seeds both widgets on load; wait until that run has finished.
await page.waitForFunction(() => /completed|failed/.test(document.getElementById("summary")?.textContent ?? "")
  && !/…$/.test(document.getElementById("summary").textContent), null, { timeout: 60000 });

/** Call a widget tool on pane A through the host's real AppBridge. */
const call = (name, args, timeout = 60000) =>
  page.evaluate(async ([n, a, t]) => {
    const r = await window.__appTools.call(window.__appTools.panes[0], n, a, { timeout: t });
    return { isError: !!r.isError, text: r.content?.map((c) => c.text).join("\n") ?? "", state: r.structuredContent ?? null };
  }, [name, args, timeout]);
const read = async () => (await call("get-studio-state", { mode: "live" })).state;
const widget = async () => (await page.$("#widget-A")).contentFrame();

const tools = await page.evaluate(async () => (await window.__appTools.panes[0].bridge.listTools({})).tools.map((t) => t.name));
tools.includes("swap-pattern") ? ok("widget lists swap-pattern") : fail(`tools: ${tools}`);

// Stopped: swap changes nothing.
let s = await read();
let r = await call("swap-pattern", { instanceId: s.instanceId, expectedRevision: s.revision, code: LOUD, quantize: QUANTIZE });
const s2 = await read();
r.isError && /stopped/.test(r.text) && s2.revision === s.revision && s2.args.code === s.args.code
  ? ok("on a stopped player it changes nothing and says to use set-pattern + play")
  : fail(`stopped swap: ${JSON.stringify(r).slice(0, 200)}`);

// Stage the silent pattern, click inside the frame AFTER Strudel loaded, play.
r = await call("set-pattern", { mode: "live", instanceId: s.instanceId, expectedRevision: s.revision, code: SILENT, title: "Swap check" });
r.isError ? fail(`set-pattern: ${r.text.slice(0, 200)}`) : ok("staged a silent pattern (set-pattern)");
const w = await widget();
await w.waitForSelector(".cm-content", { timeout: 30000 });
await w.waitForFunction(() => typeof globalThis.getAudioContext === "function", null, { timeout: 30000 });
await sleep(1000);
await w.click(".cm-content");
// R4: a stray, trusted Ctrl+Enter OUTSIDE the editor must not arm a press that a
// later programmatic evaluation (this tool play, the swaps below) could claim.
await w.click("#status");
await page.keyboard.press("Control+Enter");
s = await read();
r = await call("play-current-music", { mode: "live", instanceId: s.instanceId, expectedRevision: s.revision });
for (let i = 0; i < 40 && (await read()).playback !== "playing"; i++) await sleep(250);
(await read()).playback === "playing" ? ok("playing the silent pattern") : fail(`playback: ${(await read()).playback}`);
await sleep(1500);

(await read()).playPressed === false
  ? ok("a tool's play after a stray Ctrl+Enter outside the editor: playPressed stays false")
  : fail(`playPressed after a tool play: ${(await read()).playPressed}`);

// Stale revision: rejected, nothing swapped.
s = await read();
r = await call("swap-pattern", { instanceId: s.instanceId, expectedRevision: s.revision + 5, code: LOUD, quantize: QUANTIZE });
r.isError && /Revision conflict/.test(r.text) && (await read()).args.code === SILENT
  ? ok("a stale revision is rejected and nothing changes")
  : fail(`stale swap: ${r.text.slice(0, 200)}`);

// The swap, measured.
s = await read();
await w.evaluate(() => { globalThis.__levels = []; });
const t0 = Date.now();
r = await call("swap-pattern", { instanceId: s.instanceId, expectedRevision: s.revision, code: LOUD, quantize: QUANTIZE });
const waited = Date.now() - t0;
const swap = r.state?.swap;
!r.isError && swap?.ok ? ok(`swap answered after ${waited} ms: took over at cycle ${swap.cycle}`) : fail(`swap: ${r.text.slice(0, 300)}`);
const boundary = swap?.cycle;
Number.isInteger(boundary) && boundary % QUANTIZE === 0 ? ok(`the boundary is a multiple of ${QUANTIZE}`) : fail(`boundary ${boundary}`);
r.state?.revision > s.revision && r.state?.canUndo ? ok(`revision ${s.revision} → ${r.state.revision}, undoable`) : fail(`revision/undo: ${r.state?.revision} ${r.state?.canUndo}`);
for (let i = 0; i < 100; i++) {
  const c = await w.evaluate(() => (typeof cycle === "function" ? cycle() : NaN));
  if (c > boundary + 1.2) break;
  await sleep(100);
}
const levels = await w.evaluate(() => globalThis.__levels);
const peak = (xs) => xs.reduce((m, p) => Math.max(m, p), 0);
const before = levels.filter(([, c]) => c > boundary - 1 && c < boundary - 0.05).map(([p]) => p);
const after = levels.filter(([, c]) => c >= boundary && c < boundary + 1).map(([p]) => p);
const firstLoud = levels.find(([p, c]) => p > 0.05 && c > boundary - 1)?.[1];
peak(before) < 0.01 ? ok(`old pattern until the bar (peak ${peak(before).toFixed(3)} before)`) : fail(`sound before the bar: ${peak(before).toFixed(3)}`);
peak(after) > 0.1 ? ok(`new pattern from the bar (peak ${peak(after).toFixed(3)})`) : fail(`no sound after the bar: ${peak(after).toFixed(3)}`);
firstLoud !== undefined && firstLoud >= boundary - 0.05 && firstLoud < boundary + 0.1
  ? ok(`first sound at cycle ${firstLoud.toFixed(3)} — on the bar`)
  : fail(`first sound at cycle ${firstLoud}`);

// A newer swap supersedes a waiting one; both answer.
s = await read();
const first = call("swap-pattern", { instanceId: s.instanceId, expectedRevision: s.revision, code: SILENT, quantize: 8 });
await sleep(600);
const mid = await read();
const second = call("swap-pattern", { instanceId: mid.instanceId, expectedRevision: mid.revision, code: LOUD.replace("0.9", "0.8"), quantize: QUANTIZE });
const [a, b] = await Promise.all([first, second]);
a.isError && /superseded|replaced/.test(a.state?.swap?.error ?? a.text) ? ok(`the waiting swap answered: ${a.state?.swap?.error}`) : fail(`first: ${a.text.slice(0, 200)}`);
!b.isError && b.state?.swap?.ok ? ok(`the newer swap took over at cycle ${b.state.swap.cycle}`) : fail(`second: ${b.text.slice(0, 200)}`);

// F3: a person edits the code while the swap waits — it must not be evaluated under the swap's name.
s = await read();
const edited = call("swap-pattern", { instanceId: s.instanceId, expectedRevision: s.revision, code: SILENT, quantize: 4 });
await sleep(500);
await w.click(".cm-content");
await page.keyboard.press("End");
await page.keyboard.type(" // edited");
let e = await edited;
// Answered "queued" if the bar was past the answer window: the outcome is then lastSwap.
let editOutcome = e.state?.swap?.queued ? null : e.state?.swap;
for (let i = 0; i < 40 && !editOutcome; i++) {
  const st = await read();
  if (!st.pendingSwap && st.lastSwap) editOutcome = st.lastSwap;
  else await sleep(500);
}
editOutcome && !editOutcome.ok && /edited before the bar/.test(editOutcome.error ?? "")
  ? ok(`an edit during the wait is not swapped in: ${editOutcome.error}`)
  : fail(`edit during wait: ${JSON.stringify(editOutcome ?? e).slice(0, 240)}`);
const afterEdit = await w.evaluate(() => document.querySelector("strudel-editor")?.editor?.code ?? "");
afterEdit.includes("// edited") ? ok("the person's edit stays in the editor") : fail(`editor after: ${afterEdit}`);

// F4: a long quantize answers "queued" inside the answer window and stays readable until it lands.
s = await read();
const t1 = Date.now();
const q = await call("swap-pattern", { instanceId: s.instanceId, expectedRevision: s.revision, code: LOUD.replace("0.9", "0.8"), quantize: 32 });
const answeredIn = Date.now() - t1;
const queued = q.state?.swap;
if (queued?.queued) {
  answeredIn < 15000 && Number.isFinite(queued.boundary) && queued.boundary % 32 === 0
    ? ok(`q=32 answered "queued" in ${answeredIn} ms (boundary ${queued.boundary}, eta ${queued.etaSeconds?.toFixed(1)} s)`)
    : fail(`queued answer: ${JSON.stringify(queued)} in ${answeredIn} ms`);
  const pendingNow = (await read()).pendingSwap;
  pendingNow && pendingNow.boundary === queued.boundary ? ok("get-studio-state shows the pending swap") : fail(`pendingSwap: ${JSON.stringify(pendingNow)}`);
  let last = null;
  for (let i = 0; i < 160 && !last; i++) {
    const st = await read();
    if (!st.pendingSwap && st.lastSwap) last = st.lastSwap;
    else await sleep(500);
  }
  last?.ok && last.cycle === queued.boundary ? ok(`…and then lastSwap: took over at cycle ${last.cycle}`) : fail(`lastSwap: ${JSON.stringify(last)}`);
} else {
  // Landed inside the window (the boundary happened to be near): still a valid answer.
  q.state?.swap?.ok && answeredIn < 15000 ? ok(`q=32 landed inside the answer window (cycle ${q.state.swap.cycle})`) : fail(`q=32: ${JSON.stringify(q).slice(0, 240)}`);
}

// Stop during the wait answers (no hang), and the source stays in the editor.
s = await read();
const waiting = call("swap-pattern", { instanceId: s.instanceId, expectedRevision: s.revision, code: SILENT, quantize: 16 });
await sleep(800);
await call("stop-music", { instanceId: s.instanceId });
const stoppedAnswer = await Promise.race([waiting, sleep(5000).then(() => null)]);
stoppedAnswer && stoppedAnswer.state?.swap && stoppedAnswer.state.swap.cycle === null
  ? ok(`stop during the wait answered at once: ${stoppedAnswer.state.swap.report ?? stoppedAnswer.state.swap.error}`)
  : fail(`stop during wait: ${JSON.stringify(stoppedAnswer)?.slice(0, 200)}`);

// Undo restores the source before the last swap, stopped.
s = await read();
r = await call("undo-studio-edit", { instanceId: s.instanceId, expectedRevision: s.revision });
const u = await read();
!r.isError && u.args.code.includes("gain(0.8)") && u.playback === "stopped"
  ? ok("undo restored the previous source, stopped")
  : fail(`undo: ${r.text.slice(0, 200)} code=${u.args.code} playback=${u.playback}`);

(await read()).playPressed === false
  ? ok("after every swap and tool evaluation: playPressed still false")
  : fail(`playPressed after swaps: ${(await read()).playPressed}`);
// A real press of Play inside the player sets it.
await w.click("#play-btn");
let pressed = false;
for (let i = 0; i < 40 && !pressed; i++) {
  pressed = (await read()).playPressed === true;
  if (!pressed) await sleep(250);
}
pressed ? ok("a press of the Play button sets playPressed") : fail("Play click did not set playPressed");
await call("stop-music", { instanceId: (await read()).instanceId });

errors.length ? fail(`page errors: ${errors.join(" | ").slice(0, 300)}`) : ok("no page errors");
await browser.close();
console.log(failed ? `${failed} failed` : "all passed");
process.exitCode = failed ? 1 : 0;
