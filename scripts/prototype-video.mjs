// PROTOTYPE GATE, not a feature: can the Strudel widget's visuals be recorded
// to video in the browser? Runs the real widget in the dev harness with a
// Hydra (WebGL) layer under a 2D piano roll, and inside the widget frame:
//
//   1. composites #hydra-canvas then #test-canvas onto a 2D canvas every rAF;
//   2. captureStream(30) + an audio track tapped off the master limiter;
//   3. MediaRecorder, mime negotiated vp9,opus → vp8,opus → mp4 → UA default;
//   4. records 3 s, then decodes the blob in a <video> and samples frames.
//
// Measured, not eyeballed: the non-black fraction of the Hydra layer alone and
// of the composite at several frames, the same read OUTSIDE the frame (the
// hazard: a WebGL canvas without preserveDrawingBuffer reads back black once
// the frame is presented), blob size + mime, decoded-frame non-black fractions,
// audio peak on the tap.
//
// Two approaches, each in a fresh context:
//   a    read in a rAF registered after the widget's Hydra tick (same frame);
//   pdb  an init script forces preserveDrawingBuffer:true on #hydra-canvas's
//        WebGL context. initHydra() options cannot do it: Strudel's
//        getDrawContext() calls getContext("webgl", {willReadFrequently:true})
//        BEFORE hydra-synth/regl asks, so regl gets the existing context and
//        its (default) attributes, and getDrawContext forwards only
//        contextType/pixelRatio/pixelated.
//
//   bun run build
//   node scripts/prototype-video.mjs                  # chromium, both approaches
//   BROWSER=webkit node scripts/prototype-video.mjs   # WebKit
//   APPROACH=a node scripts/prototype-video.mjs       # one approach
//   MIME=video/mp4 node scripts/prototype-video.mjs   # skip negotiation, force one type
//
// Starts its own harness on HARNESS_PORT (default 5187) unless HARNESS is set.
// Writes the recorded blobs to OUT_DIR (default $TMPDIR/prototype-video).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BROWSER, engine } from "./lib/engine.mjs";

const PORT = process.env.HARNESS_PORT ?? "5187";
const OUT_DIR = process.env.OUT_DIR ?? path.join(os.tmpdir(), "prototype-video");
const APPROACHES = process.env.APPROACH ? [process.env.APPROACH] : ["a", "pdb"];
const RECORD_MS = 3000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hydra kaleidoscope (the hydra-kaleid preset's shader, but a constant
// colour floor so "black" can't be the shader's own darkness) under a piano
// roll, over an audible bass + kick.
const CODE = `await initHydra()
osc(8, 0.05, 0.9).rotate(0.3).kaleid(5).color(0.5, 0.35, 1).add(solid(0.15, 0.1, 0.25)).out(o0)
setcps(0.5)
stack(
  s("bd*4").bank('RolandTR909'),
  note("c2 eb2 g2 bb2").s('sawtooth').lpf(800)
).pianoroll()`;

const initScript = (forcePdb) => `(() => {
  globalThis.__glAttrs = [];
  globalThis.__compressors = [];
  const gc = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (typeof type === 'string' && type.includes('webgl') && this.id === 'hydra-canvas') {
      const requested = ${forcePdb} ? { ...(attrs || {}), preserveDrawingBuffer: true } : attrs;
      const ctx = gc.call(this, type, requested);
      const a = ctx?.getContextAttributes?.();
      globalThis.__glAttrs.push({ type, requested: requested ?? null, preserveDrawingBuffer: a?.preserveDrawingBuffer ?? null });
      return ctx;
    }
    return gc.call(this, type, attrs);
  };
  if (globalThis.BaseAudioContext) {
    const cdc = BaseAudioContext.prototype.createDynamicsCompressor;
    BaseAudioContext.prototype.createDynamicsCompressor = function () {
      const n = cdc.call(this);
      globalThis.__compressors.push(n);
      return n;
    };
  }
})();`;

// Runs inside the widget frame. Self-contained: no closures over Node values.
async function measureInFrame({ recordMs, forceMime }) {
  const out = { errors: [] };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const hydra = document.getElementById("hydra-canvas");
  const viz = document.getElementById("test-canvas");
  out.hydraCanvas = hydra ? `${hydra.width}x${hydra.height}` : null;
  out.vizCanvas = viz ? `${viz.width}x${viz.height}` : null;
  out.glAttrs = globalThis.__glAttrs;
  if (!hydra || !viz) {
    out.errors.push("missing canvas");
    return out;
  }

  const probe = document.createElement("canvas");
  probe.width = 160;
  probe.height = 90;
  const pctx = probe.getContext("2d", { willReadFrequently: true });
  // Fraction of probe pixels brighter than near-black (r+g+b > 30), after
  // painting `src` over opaque black.
  const nonBlack = (src) => {
    pctx.globalCompositeOperation = "copy";
    pctx.fillStyle = "#000";
    pctx.fillRect(0, 0, 160, 90);
    pctx.globalCompositeOperation = "source-over";
    pctx.drawImage(src, 0, 0, 160, 90);
    const d = pctx.getImageData(0, 0, 160, 90).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 30) n++;
    return n / (d.length / 4);
  };
  // Snapshot of the probe (after nonBlack) and mean abs difference of two.
  const snap = () => pctx.getImageData(0, 0, 160, 90).data.slice();
  const diff = (a, b) => {
    if (!a || !b) return null;
    let s = 0;
    for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    return s / (a.length / 4) / 3;
  };
  // Fraction of pixels where two snapshots differ visibly (any channel > 40).
  const changed = (a, b) => {
    let n = 0;
    for (let i = 0; i < a.length; i += 4) if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > 40) n++;
    return n / (a.length / 4);
  };

  // The hazard, measured: the same read from a task outside any frame.
  out.hydraOutsideFrame = [];
  for (let i = 0; i < 3; i++) {
    await sleep(170);
    out.hydraOutsideFrame.push(nonBlack(hydra));
  }

  // 1. Compositing canvas, drawn in a rAF registered now — after the widget's
  // own Hydra tick rAF, which re-registers itself first every frame.
  const comp = document.createElement("canvas");
  comp.width = hydra.width;
  comp.height = hydra.height;
  const cctx = comp.getContext("2d");
  out.compCanvas = `${comp.width}x${comp.height}`;
  out.hydraInFrame = [];
  out.composite = [];
  out.vizAlone = [];
  out.vizInComposite = []; // composite pixels that differ from Hydra alone in the same frame
  out.hydraMotion = []; // mean abs change of the Hydra layer between samples
  let lastHydra = null;
  let frames = 0;
  let running = true;
  const paint = () => {
    if (!running) return;
    cctx.fillStyle = "#000";
    cctx.fillRect(0, 0, comp.width, comp.height);
    cctx.drawImage(hydra, 0, 0, comp.width, comp.height);
    cctx.drawImage(viz, 0, 0, comp.width, comp.height);
    if (frames % 20 === 10 && out.composite.length < 8) {
      out.hydraInFrame.push(nonBlack(hydra));
      const h = snap();
      if (lastHydra) out.hydraMotion.push(diff(lastHydra, h));
      lastHydra = h;
      out.composite.push(nonBlack(comp));
      out.vizInComposite.push(changed(h, snap()));
      out.vizAlone.push(nonBlack(viz));
    }
    frames++;
    requestAnimationFrame(paint);
  };
  requestAnimationFrame(paint);
  await sleep(200);

  // 2. Stream: canvas video + limiter audio.
  let stream;
  try {
    stream = comp.captureStream(30);
  } catch (e) {
    out.errors.push(`captureStream: ${e}`);
    running = false;
    return out;
  }
  out.videoTracks = stream.getVideoTracks().length;
  const ctx = globalThis.getAudioContext?.();
  out.audioState = ctx?.state ?? null;
  let analyser = null;
  if (ctx) {
    const limiter = (globalThis.__compressors ?? []).find(
      (c) => c.context === ctx && c.threshold.value === -2 && c.ratio.value === 20,
    );
    const tap = limiter ?? globalThis.getSuperdoughAudioController?.()?.output?.destinationGain;
    out.audioTap = limiter ? "master limiter (via createDynamicsCompressor hook)" : tap ? "destinationGain (pre-limiter)" : null;
    if (tap) {
      const dest = ctx.createMediaStreamDestination();
      tap.connect(dest);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      tap.connect(analyser);
      for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
    }
  }
  out.audioTracks = stream.getAudioTracks().length;

  // 3. MediaRecorder with mime negotiation.
  out.MediaRecorder = typeof MediaRecorder;
  if (typeof MediaRecorder === "undefined") {
    out.errors.push("MediaRecorder undefined");
    running = false;
    return out;
  }
  const candidates = forceMime ? [forceMime] : ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/mp4", ""];
  out.supported = Object.fromEntries(
    candidates.filter(Boolean).map((m) => [m, MediaRecorder.isTypeSupported?.(m) ?? null]),
  );
  const mime = candidates.find((m) => m === "" || MediaRecorder.isTypeSupported?.(m));
  out.mimeRequested = mime;
  let recorder;
  try {
    recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  } catch (e) {
    out.errors.push(`new MediaRecorder: ${e?.name}: ${e?.message}`);
    running = false;
    return out;
  }
  const chunks = [];
  recorder.ondataavailable = (e) => e.data?.size && chunks.push(e.data);
  recorder.onerror = (e) => out.errors.push(`recorder error: ${e?.error?.name}: ${e?.error?.message}`);
  const stopped = new Promise((r) => (recorder.onstop = r));
  let peak = 0;
  const buf = new Float32Array(1024);
  const meter = setInterval(() => {
    if (!analyser) return;
    analyser.getFloatTimeDomainData(buf);
    for (const v of buf) peak = Math.max(peak, Math.abs(v));
  }, 20);
  const framesAtStart = frames;
  try {
    recorder.start(250);
  } catch (e) {
    out.errors.push(`recorder.start: ${e?.name}: ${e?.message}`);
    running = false;
    clearInterval(meter);
    return out;
  }
  await sleep(recordMs);
  recorder.stop();
  await Promise.race([stopped, sleep(5000)]);
  clearInterval(meter);
  running = false;
  out.compositeFps = (frames - framesAtStart) / (recordMs / 1000);
  out.audioPeak = analyser ? peak : null;
  out.mimeActual = recorder.mimeType;
  const blob = new Blob(chunks, { type: recorder.mimeType || mime || "" });
  out.blobBytes = blob.size;
  out.chunks = chunks.length;
  if (!blob.size) return out;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  out.blobBase64 = btoa(bin);

  // 4. Decode in-page and sample frames.
  out.decoded = [];
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.src = URL.createObjectURL(blob);
  try {
    await Promise.race([
      new Promise((res, rej) => {
        video.onloadeddata = res;
        video.onerror = () => rej(new Error(`video error ${video.error?.code}: ${video.error?.message}`));
      }),
      sleep(5000).then(() => {
        throw new Error("loadeddata timeout");
      }),
    ]);
    out.videoSize = `${video.videoWidth}x${video.videoHeight}`;
    out.videoDuration = video.duration;
    await video.play();
    let last = null;
    for (let i = 0; i < 5 && !video.ended; i++) {
      await sleep(450);
      const nb = nonBlack(video);
      const s = snap();
      out.decoded.push({ t: +video.currentTime.toFixed(2), nonBlack: nb, motion: diff(last, s) });
      last = s;
    }
    out.decodedAudioBytes = video.webkitAudioDecodedByteCount ?? null;
    out.decodedAudioTracks = video.audioTracks ? video.audioTracks.length : null;
  } catch (e) {
    out.errors.push(`decode: ${e?.message ?? e}`);
  }
  return out;
}

// ---------------------------------------------------------------------------

let harness = process.env.HARNESS;
let vite = null;
if (!harness) {
  vite = spawn("bunx", ["vite", "--config", "dev/vite.config.ts", "--host", "127.0.0.1", "--port", PORT, "--strictPort"], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
    stdio: "ignore",
    detached: true,
  });
  harness = `http://127.0.0.1:${PORT}/`;
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(500);
    up = await fetch(harness).then((r) => r.ok, () => false);
  }
  if (!up) {
    process.kill(-vite.pid);
    throw new Error(`harness did not come up on ${harness}`);
  }
}
const stopVite = () => {
  if (vite) try { process.kill(-vite.pid); } catch {}
};
process.on("exit", stopVite);

fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await engine.launch({
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
console.log(`engine: ${BROWSER} ${browser.version()}`);

const results = {};
for (const approach of APPROACHES) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  await context.addInitScript(initScript(approach === "pdb"));
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  await page.goto(harness);
  await page.waitForFunction(() => document.getElementById("state")?.textContent?.startsWith("connected"), null, { timeout: 30000 });
  await page.fill("#args", JSON.stringify({ code: CODE, autoplay: true, title: "video prototype" }));
  await page.click("#send");
  const frame = () => page.frames().find((f) => f.url().includes("/widgets/"));
  for (let i = 0; i < 100 && !frame(); i++) await sleep(100);
  if (!frame()) throw new Error("the widget never loaded");
  // Wait for Strudel + Hydra, then a real click inside the frame (worklets,
  // audio unlock), then let Hydra render for a beat.
  let status = "";
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    status = await frame().evaluate(() => document.getElementById("status")?.textContent ?? "").catch(() => "");
    const hydraUp = await frame().evaluate(() => !!document.getElementById("hydra-canvas")).catch(() => false);
    if (/^Playing/.test(status) && hydraUp) break;
  }
  const box = await (await page.$("iframe")).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.8);
  await sleep(2000);
  status = await frame().evaluate(() => document.getElementById("status")?.textContent ?? "");
  const r = await frame().evaluate(measureInFrame, { recordMs: RECORD_MS, forceMime: process.env.MIME ?? null }).catch((e) => ({ errors: [String(e)] }));
  r.status = status;
  r.consoleErrors = consoleErrors.filter((e) => !/favicon|DevTools/.test(e)).slice(0, 5);
  if (r.blobBase64) {
    const ext = /mp4/.test(r.mimeActual) ? "mp4" : "webm";
    r.file = path.join(OUT_DIR, `${BROWSER}-${approach}${process.env.MIME ? "-forced" : ""}.${ext}`);
    fs.writeFileSync(r.file, Buffer.from(r.blobBase64, "base64"));
    delete r.blobBase64;
  }
  results[approach] = r;
  await context.close();
}
await browser.close();
stopVite();

const pct = (xs) => (Array.isArray(xs) && xs.length ? xs.map((x) => `${(x * 100).toFixed(0)}%`).join(" ") : "—");
for (const [approach, r] of Object.entries(results)) {
  console.log(`\n── ${BROWSER} / approach ${approach}`);
  console.log(`  widget status            ${r.status}`);
  console.log(`  canvases                 hydra ${r.hydraCanvas}, viz ${r.vizCanvas}, composite ${r.compCanvas}`);
  console.log(`  hydra GL context         ${JSON.stringify(r.glAttrs)}`);
  console.log(`  hydra read OUTSIDE frame ${pct(r.hydraOutsideFrame)}`);
  console.log(`  hydra read in rAF        ${pct(r.hydraInFrame)}`);
  console.log(`  viz (2D) alone           ${pct(r.vizAlone)}`);
  console.log(`  hydra motion (0-255)     ${(r.hydraMotion ?? []).map((x) => x.toFixed(1)).join(" ") || "—"}`);
  console.log(`  viz visible in composite ${pct(r.vizInComposite)}`);
  console.log(`  composite                ${pct(r.composite)}  (${r.compositeFps?.toFixed(1)} composite fps while recording)`);
  console.log(`  tracks                   video ${r.videoTracks}, audio ${r.audioTracks} (tap: ${r.audioTap}, ctx ${r.audioState}, peak ${r.audioPeak?.toFixed?.(3)})`);
  console.log(`  isTypeSupported          ${JSON.stringify(r.supported)}`);
  console.log(`  mime                     requested "${r.mimeRequested}", recorder "${r.mimeActual}"`);
  console.log(`  blob                     ${r.blobBytes} bytes in ${r.chunks} chunks for ${RECORD_MS / 1000} s${r.file ? ` → ${r.file}` : ""}`);
  console.log(`  decoded                  ${r.videoSize ?? "—"} dur ${r.videoDuration}; frames ${(r.decoded ?? []).map((d) => `t=${d.t}:${(d.nonBlack * 100).toFixed(0)}%${d.motion == null ? "" : `/Δ${d.motion.toFixed(1)}`}`).join(" ") || "—"}`);
  console.log(`  decoded audio            bytes ${r.decodedAudioBytes ?? "n/a"}, audioTracks ${r.decodedAudioTracks ?? "n/a"}`);
  if (r.errors?.length) console.log(`  ERRORS                   ${r.errors.join(" | ")}`);
  if (r.consoleErrors?.length) console.log(`  console errors           ${r.consoleErrors.join(" | ")}`);
}
