// Film recorder library: a phone-shaped Chromium, CDP screencast frames with
// timestamps, per-frame PCM audio capture with wall-clock stamps, CDP touches.
// See README.md here. Needs the dev server: bunx vite --config dev/vite.config.ts --port 5210
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");

export const SRC = path.dirname(new URL(import.meta.url).pathname);
/** Takes, caches and cuts live OUTSIDE the repo (iCloud): $FILM_WORK, default <tmp>/ms-film. */
export const HERE = process.env.FILM_WORK ?? path.join(os.tmpdir(), "ms-film");
fs.mkdirSync(HERE, { recursive: true });
/** The "before" widgets: published 0.5.8, fetched once from the npm registry. */
export const OLD_VERSION = process.env.FILM_OLD ?? "0.5.8";
export function ensureOldWidgets() {
  const dir = path.join(HERE, "old", OLD_VERSION);
  if (fs.existsSync(path.join(dir, "package/dist/strudel-app.html"))) return path.join(dir, "package/dist");
  fs.mkdirSync(dir, { recursive: true });
  const tgz = path.join(dir, "t.tgz");
  execFileSync("curl", ["-sSfL", "-o", tgz, `https://registry.npmjs.org/mcp-music-studio/-/mcp-music-studio-${OLD_VERSION}.tgz`]);
  execFileSync("tar", ["xzf", tgz, "-C", dir, "package/dist/mcp-app.html", "package/dist/strudel-app.html"]);
  return path.join(dir, "package/dist");
}
export const BASE = "http://localhost:5210/film.html";
export const W_OUT = 1080;
export const H_OUT = 1920;
export const PHONE_W = 390;
export const SCALE = W_OUT / PHONE_W; // the phone is 390 × 693.3 CSS px, drawn at 1080 × 1920
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SFCACHE = path.join(HERE, "sfcache");
fs.mkdirSync(SFCACHE, { recursive: true });

/** Runs in every widget frame: tap each AudioContext's output into int16 PCM chunks stamped with wall time. */
export const AUDIO_CAPTURE = `(() => {
  // Widget frames on the film page; the page itself on a stage page (dev/stage-*.html).
  if ((window === window.top && !location.pathname.includes('/stage-')) || !globalThis.BaseAudioContext) return;
  // Render at 48 kHz whatever the output device runs at (Bluetooth headsets in
  // call mode run at 24 or 16 kHz, and the context defaults to the device rate).
  const NativeAC = globalThis.AudioContext;
  globalThis.AudioContext = class AudioContext extends NativeAC {
    constructor(options = {}) { super({ sampleRate: 48000, ...options }); }
  };
  if (globalThis.webkitAudioContext) globalThis.webkitAudioContext = globalThis.AudioContext;
  const desc = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'destination');
  const taps = new WeakMap();
  const cap = globalThis.__cap = { chunks: [], rate: 0, n: 0 };
  Object.defineProperty(BaseAudioContext.prototype, 'destination', {
    configurable: true,
    get() {
      if (typeof AudioContext === 'undefined' || !(this instanceof AudioContext)) return desc.get.call(this);
      let g = taps.get(this);
      if (g) return g;
      const ctx = this;
      const real = desc.get.call(ctx);
      g = ctx.createGain();
      g.connect(real);
      Object.defineProperty(g, 'maxChannelCount', { value: real.maxChannelCount || 2 });
      const sp = ctx.createScriptProcessor(2048, 2, 2);
      g.connect(sp);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      sp.connect(mute);
      mute.connect(real);
      cap.rate = ctx.sampleRate;
      sp.onaudioprocess = (e) => {
        const ib = e.inputBuffer;
        const L = ib.getChannelData(0), R = ib.numberOfChannels > 1 ? ib.getChannelData(1) : L;
        let live = false;
        for (let i = 0; i < L.length; i++) if (L[i] !== 0 || R[i] !== 0) { live = true; break; }
        if (!live) return;
        const ts = ctx.getOutputTimestamp();
        const perf = ts.performanceTime > 0
          ? ts.performanceTime + (e.playbackTime - ts.contextTime) * 1000
          : performance.now() + (e.playbackTime - ctx.currentTime) * 1000;
        const pcm = new Int16Array(L.length * 2);
        for (let i = 0; i < L.length; i++) {
          pcm[2 * i] = Math.max(-1, Math.min(1, L[i])) * 32767;
          pcm[2 * i + 1] = Math.max(-1, Math.min(1, R[i])) * 32767;
        }
        cap.chunks.push({ wall: performance.timeOrigin + perf, pcm });
        cap.n++;
      };
      taps.set(ctx, g);
      return g;
    },
  });
  globalThis.__capDrain = () => {
    const chunks = cap.chunks.splice(0);
    const out = [];
    for (const c of chunks) {
      const u8 = new Uint8Array(c.pcm.buffer);
      let s = '';
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      out.push({ wall: c.wall, b64: btoa(s) });
    }
    return { rate: cap.rate, chunks: out };
  };
})();`;

export async function launch({ headless = true, gpu = false } = {}) {
  const args = gpu
    ? ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=metal", "--enable-features=Vulkan"]
    : ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
  return chromium.launch({ headless, args });
}

export async function openFilm(browser, { old = false, outDir, mode = "zoom", query = "", isMobile = true }) {
  fs.mkdirSync(path.join(outDir, "frames"), { recursive: true });
  const context = await browser.newContext({
    viewport: { width: W_OUT, height: H_OUT },
    deviceScaleFactor: 1,
    isMobile,
    hasTouch: true,
    colorScheme: "dark",
  });
  await context.route(/\/widgets\/old\/(mcp-app|strudel-app)\.html/, (route) => {
    const name = route.request().url().match(/(mcp-app|strudel-app)\.html/)[0];
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: fs.readFileSync(path.join(ensureOldWidgets(), name)) });
  });
  // Soundfonts from a disk cache: takes shouldn't depend on GitHub Pages' mood.
  await context.route(/paulrosen\.github\.io|midi-js-soundfonts|felixroos\.github\.io|strudel\.b-cdn\.net|raw\.githubusercontent\.com\/(tidalcycles|felixroos)/, async (route) => {
    const url = route.request().url();
    const file = path.join(SFCACHE, crypto.createHash("sha1").update(url).digest("hex"));
    let body, type;
    if (fs.existsSync(file)) {
      body = fs.readFileSync(file);
      type = fs.existsSync(file + ".type") ? fs.readFileSync(file + ".type", "utf8") : "application/octet-stream";
    } else {
      const res = await route.fetch();
      if (res.status() !== 200) return route.fulfill({ response: res });
      body = await res.body();
      type = res.headers()["content-type"] || "application/octet-stream";
      fs.writeFileSync(file, body);
      fs.writeFileSync(file + ".type", type);
    }
    return route.fulfill({ status: 200, body, headers: { "content-type": type, "access-control-allow-origin": "*" } });
  });
  await context.addInitScript({ content: AUDIO_CAPTURE });
  const page = await context.newPage();
  const log = [];
  const t0 = Date.now();
  page.on("console", (m) => {
    const t = m.text();
    if (/^\[film|\[W\]/.test(t) || m.type() === "error") log.push(`${String(Date.now() - t0).padStart(6)} ${t.slice(0, 220)}`);
  });
  page.on("pageerror", (e) => log.push(`${String(Date.now() - t0).padStart(6)} [pageerror] ${e.message.slice(0, 200)}`));
  const cdp = await context.newCDPSession(page);
  const contexts = new Map(); // frameId → default execution context id
  cdp.on("Runtime.executionContextCreated", ({ context: c }) => {
    if (c.auxData?.isDefault) contexts.set(c.auxData.frameId, c.id);
  });
  cdp.on("Runtime.executionContextDestroyed", (e) => {
    for (const [k, v] of contexts) if (v === e.executionContextId) contexts.delete(k);
  });
  await cdp.send("Runtime.enable");
  await cdp.send("DOM.enable");
  await page.goto(`${BASE}?scale=${SCALE}&mode=${mode}${old ? "&v=old" : ""}${query}`);
  await page.addStyleTag({ content: `:root { --ph: ${H_OUT / SCALE}px; }` });
  const film = { context, page, cdp, log, outDir, old, mode, sessions: new Map(), contexts };
  for (let i = 0; i < 300 && !(await top(film, "!!window.__film?.ready")); i++) await sleep(100);
  return film;
}

/**
 * Evaluate in the host page WITHOUT a user gesture. Playwright's evaluate()
 * is a gesture, and a gesture on the host page would be exactly the kind of
 * activation this film is about.
 */
export async function top(film, expression) {
  const r = await film.cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: false });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

/** The frame id of widget i's iframe: resolved once (DOM node ids go stale; frame ids don't). */
async function frameIdOf(film, i) {
  if (film.frameIds?.[i]) return film.frameIds[i];
  film.frameIdsP ??= (async () => {
    const { root } = await film.cdp.send("DOM.getDocument", { depth: 0 });
    const out = {};
    for (let k = 0; k < 16; k++) {
      const { nodeId } = await film.cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#w${k}` });
      if (!nodeId) break;
      const { node } = await film.cdp.send("DOM.describeNode", { nodeId });
      out[k] = node.frameId;
    }
    return out;
  })();
  film.frameIds = await film.frameIdsP;
  return film.frameIds[i];
}

/** A CDP session of widget i's own, if Chrome has put the frame out of process. */
async function ownSession(film, i) {
  const f = (await widgetFrames(film.page))[i];
  if (!f) return null;
  if (film.sessions.has(f)) return film.sessions.get(f);
  try {
    const s = await film.context.newCDPSession(f);
    film.sessions.set(f, s);
    return s;
  } catch {
    return null; // still in the page's process
  }
}

/** Evaluate inside widget i, no gesture (its own CDP session: the frame is out-of-process). */
/** Serialised: a rescan (Runtime.disable/enable, DOM.getDocument) invalidates concurrent callers' ids. */
export function inWidget(film, i, expression) {
  const run = (film.lock ?? Promise.resolve()).then(() => inWidgetNow(film, i, expression));
  film.lock = run.catch(() => {});
  return run;
}

async function inWidgetNow(film, i, expression) {
  let frameId = await frameIdOf(film, i);
  let r;
  for (let attempt = 0; ; attempt++) {
    let contextId = frameId && film.contexts.get(frameId);
    if (!contextId || attempt > 0) {
      // The frame id itself can change under us: resolve it again from the DOM.
      film.frameIds = null;
      film.frameIdsP = null;
      frameId = await frameIdOf(film, i);
      // Re-announce every live context: disable + enable replays executionContextCreated.
      film.contexts.clear();
      await film.cdp.send("Runtime.disable");
      await film.cdp.send("Runtime.enable");
      await sleep(50);
      contextId = film.contexts.get(frameId);
      if (!contextId) {
        // The frame may have moved out of process: it then has a session of its own.
        const own = await ownSession(film, i);
        if (own) {
          const rr = await own.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: false });
          if (rr.exceptionDetails) throw new Error(rr.exceptionDetails.exception?.description ?? rr.exceptionDetails.text);
          return rr.result.value;
        }
        if (attempt >= 6) throw new Error(`no context for widget ${i} (frame ${frameId})`);
        await sleep(200);
        continue;
      }
    }
    try {
      r = await film.cdp.send("Runtime.evaluate", { expression, contextId, awaitPromise: true, returnByValue: true, userGesture: false });
      break;
    } catch (err) {
      if (attempt >= 6 || !/Cannot find context/.test(String(err))) throw err;
      console.log(`  (widget ${i}: context ${contextId} gone; rescanning)`);
    }
  }
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

/** Frames of the widgets, by index. */
export async function widgetFrames(page) {
  const out = [];
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    const el = await f.frameElement().catch(() => null);
    const id = el ? await el.getAttribute("id") : null;
    if (id && /^w\d+$/.test(id)) out[Number(id.slice(1))] = f;
  }
  return out;
}

/** Screencast: every compositor frame to disk with its timestamp. */
export async function startCapture(film) {
  const { cdp, outDir } = film;
  const frames = [];
  let n = 0;
  cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
    const file = path.join(outDir, "frames", `f${String(n++).padStart(6, "0")}.jpg`);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    frames.push({ file, t: metadata.timestamp });
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 1080, maxHeight: 1924, everyNthFrame: 1 });
  film.frames = frames;
  film.audio = {};
  film.drainTimer = setInterval(() => void drainAudio(film), 5000);
  return frames;
}

export async function drainAudio(film) {
  if (film.captureTop) {
    const got = await top(film, "globalThis.__capDrain?.() ?? null").catch(() => null);
    if (got?.chunks.length) {
      const a = (film.audio.top ??= { rate: got.rate, chunks: [] });
      for (const c of got.chunks) a.chunks.push({ wall: c.wall, pcm: Buffer.from(c.b64, "base64") });
    }
    return;
  }
  const frames = await widgetFrames(film.page);
  for (let i = 0; i < frames.length; i++) {
    if (!frames[i]) continue;
    try {
      const got = await inWidget(film, i, "globalThis.__capDrain?.() ?? null");
      if (!got || !got.chunks.length) continue;
      const a = (film.audio[i] ??= { rate: got.rate, chunks: [] });
      a.rate = got.rate || a.rate;
      for (const c of got.chunks) a.chunks.push({ wall: c.wall, pcm: Buffer.from(c.b64, "base64") });
    } catch { /* frame navigating */ }
  }
}

export async function stopCapture(film) {
  clearInterval(film.drainTimer);
  await film.cdp.send("Page.stopScreencast").catch(() => {});
  await drainAudio(film);
  const last = film.frames.at(-1);
  if (last) film.frames.push({ file: last.file, t: Date.now() / 1000 });
  const meta = {
    frames: film.frames.map((f) => ({ file: path.basename(f.file), t: f.t })),
    audio: Object.fromEntries(Object.entries(film.audio).map(([i, a]) => [i, { rate: a.rate, count: a.chunks.length }])),
    marks: film.marks ?? [],
  };
  // Mix every widget's chunks onto one wall-clock timeline (float32, then int16).
  const start = film.frames[0]?.t * 1000;
  const end = film.frames.at(-1)?.t * 1000;
  const rate = 48000;
  const len = Math.ceil(((end - start) / 1000 + 2) * rate);
  const mix = new Float32Array(len * 2);
  for (const a of Object.values(film.audio)) {
    if (a.rate !== rate) console.warn("rate", a.rate, "≠ 48000 — resample not implemented");
    for (const c of a.chunks) {
      const at = Math.round(((c.wall - start) / 1000) * rate);
      const s = new Int16Array(c.pcm.buffer, c.pcm.byteOffset, c.pcm.byteLength / 2);
      for (let i = 0; i < s.length / 2; i++) {
        const k = at + i;
        if (k < 0 || k >= len) continue;
        mix[2 * k] += s[2 * i] / 32768;
        mix[2 * k + 1] += s[2 * i + 1] / 32768;
      }
    }
  }
  const pcm = Buffer.alloc(len * 4);
  for (let i = 0; i < len * 2; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(mix[i] * 32767))), i * 2);
  fs.writeFileSync(path.join(film.outDir, "audio.s16le"), pcm);
  meta.audioStart = start;
  fs.writeFileSync(path.join(film.outDir, "meta.json"), JSON.stringify(meta, null, 1));
  fs.writeFileSync(path.join(film.outDir, "log.txt"), film.log.join("\n"));
  return meta;
}

export function mark(film, label) {
  (film.marks ??= []).push({ label, wall: Date.now() });
}

// ---- touch ------------------------------------------------------------------

async function finger(film, x, y, state) {
  await film.cdp.send("Runtime.evaluate", { expression: `window.__film.touch(${x}, ${y}, ${JSON.stringify(state)})`, userGesture: false });
}

export async function tap(film, x, y) {
  await finger(film, x, y, "tap");
  await film.cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await sleep(70);
  await film.cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(250);
  await finger(film, x, y, "up");
}

/** A thumb pan from (x, y) by dy, eased, over ms; lifting while still moving flings. */
export async function pan(film, x, y, dy, ms = 420) {
  const steps = Math.max(6, Math.round(ms / 16));
  await finger(film, x, y, "down");
  await film.cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= steps; i++) {
    const p = i / steps;
    const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    const yy = y + dy * e;
    await film.cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: yy }] });
    void finger(film, x, yy, "move");
    await sleep(ms / steps);
  }
  await film.cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await finger(film, x, y + dy, "up");
}

/**
 * Viewport-pixel box of a selector inside widget i. Playwright reports boxes
 * in the zoomed phone's own CSS px, so scale them to what CDP touches use.
 */
export async function boxIn(film, i, selector) {
  const frames = await widgetFrames(film.page);
  const b = await frames[i].locator(selector).first().boundingBox();
  if (!b) return null;
  const k = film.mode === "transform" ? 1 : SCALE;
  return { x: b.x * k, y: b.y * k, width: b.width * k, height: b.height * k, cx: (b.x + b.width / 2) * k, cy: (b.y + b.height / 2) * k };
}

// ---- encode -----------------------------------------------------------------

/** ffmpeg with libx264 + drawtext; $FFMPEG, else the one on PATH. */
export const FF = process.env.FFMPEG ?? "ffmpeg";

// ---- the editor -------------------------------------------------------------

/** Type text at the end of widget i's Strudel editor, `cps` characters a second. */
export async function typeInto(film, i, text, cps = 45) {
  await inWidget(film, i, `(() => {
    const view = document.querySelector('strudel-editor').editor.editor;
    view.focus();
    view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
  })()`);
  const per = Math.max(1, Math.round(cps / 30));
  for (let k = 0; k < text.length; k += per) {
    const chunk = text.slice(k, k + per);
    await inWidget(film, i, `(() => {
      const view = document.querySelector('strudel-editor').editor.editor;
      const end = view.state.doc.length;
      view.dispatch({ changes: { from: end, insert: ${JSON.stringify(chunk)} }, selection: { anchor: end + ${chunk.length} }, scrollIntoView: true });
    })()`);
    await sleep((1000 * chunk.length) / cps);
  }
}

/** What Ctrl+Enter does: StrudelMirror.evaluate(true) on the live buffer. */
export async function evaluateIn(film, i) {
  return inWidget(film, i, `document.querySelector('strudel-editor').editor.evaluate(true).then(() => 'ok')`);
}

export async function status(film, i) {
  return inWidget(film, i, `document.getElementById('status')?.textContent`);
}


/** A bare page (a dev/stage-*.html) at 1080×1920, its own audio captured. */
export async function openStage(browser, { url, outDir, captureTop = true }) {
  fs.mkdirSync(path.join(outDir, "frames"), { recursive: true });
  const context = await browser.newContext({ viewport: { width: W_OUT, height: H_OUT }, deviceScaleFactor: 1, colorScheme: "dark" });
  await context.route(/paulrosen\.github\.io|midi-js-soundfonts|felixroos\.github\.io|strudel\.b-cdn\.net/, async (route) => {
    const u = route.request().url();
    const file = path.join(SFCACHE, crypto.createHash("sha1").update(u).digest("hex"));
    if (fs.existsSync(file)) return route.fulfill({ status: 200, body: fs.readFileSync(file), headers: { "content-type": fs.existsSync(file + ".type") ? fs.readFileSync(file + ".type", "utf8") : "application/octet-stream", "access-control-allow-origin": "*" } });
    const res = await route.fetch();
    if (res.status() !== 200) return route.fulfill({ response: res });
    const body = await res.body();
    fs.writeFileSync(file, body);
    fs.writeFileSync(file + ".type", res.headers()["content-type"] || "application/octet-stream");
    return route.fulfill({ status: 200, body, headers: { "content-type": res.headers()["content-type"] || "application/octet-stream", "access-control-allow-origin": "*" } });
  });
  await context.addInitScript({ content: AUDIO_CAPTURE });
  const page = await context.newPage();
  const log = [];
  const t0 = Date.now();
  page.on("console", (m) => { const t = m.text(); if (/^\[stage|\[film/.test(t) || m.type() === "error") log.push(`${String(Date.now() - t0).padStart(6)} ${t.slice(0, 200)}`); });
  page.on("pageerror", (e) => log.push(`${String(Date.now() - t0).padStart(6)} [pageerror] ${e.message.slice(0, 200)}`));
  const cdp = await context.newCDPSession(page);
  const contexts = new Map();
  cdp.on("Runtime.executionContextCreated", ({ context: c }) => { if (c.auxData?.isDefault) contexts.set(c.auxData.frameId, c.id); });
  cdp.on("Runtime.executionContextDestroyed", (e) => { for (const [k, v] of contexts) if (v === e.executionContextId) contexts.delete(k); });
  await cdp.send("Runtime.enable");
  await cdp.send("DOM.enable");
  await page.goto(url);
  const film = { context, page, cdp, log, outDir, captureTop, sessions: new Map(), contexts };
  for (let i = 0; i < 200 && !(await top(film, "!!window.__stage")); i++) await sleep(100);
  return film;
}

/** Forget cached frame ids and contexts, and have Chrome re-announce the live ones. */
export async function rescan(film) {
  film.frameIds = null;
  film.frameIdsP = null;
  film.contexts.clear();
  await film.cdp.send("Runtime.disable");
  await film.cdp.send("Runtime.enable");
  await sleep(60);
}

/** Wait until `expression` is truthy inside widget i, rescanning contexts when it isn't (a stale about:blank context). */
export async function waitInWidget(film, i, expression, tries = 60) {
  for (let k = 0; k < tries; k++) {
    const v = await inWidget(film, i, expression).catch(() => false);
    if (v) return v;
    await rescan(film);
    await sleep(200);
  }
  throw new Error(`timed out waiting in widget ${i}: ${expression}`);
}
