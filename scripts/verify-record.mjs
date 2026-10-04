// Acceptance check for "Record a set as a video" and the watch page, in a real
// browser, through the real widget (dev harness) and the real Worker:
//
//   1. a Hydra pattern recorded for 3 s with "Rec video" downloads a video
//      that DECODES to non-black frames, carries audio with level, and reports
//      a duration within 0.5 s of the wall time (Chromium's WebM gets its
//      duration written in; WebKit's MP4 has one);
//   2. a recording keeps running across a live-session swap, and the session's
//      setlist arrives as a second download naming the swap;
//   3. /p/<id>?watch and /s/<id>?watch show the stage only — code hidden, no
//      edit buttons, nothing playing until the one tap, Rec video available.
//
//   bun run build
//   (cd worker && bunx wrangler dev --local --port 8799)
//   bunx vite --config dev/vite.config.ts --port 5177
//   node scripts/verify-record.mjs                 # BROWSER=webkit for Safari's engine
//   LONG_S=60 node scripts/verify-record.mjs       # also measure a 60 s recording's export
//   DPR=2 …                                        # a 2× screen (bigger frame, more bytes)
//
// Recorded files go to OUT_DIR (default $TMPDIR/verify-record).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BROWSER, engine } from "./lib/engine.mjs";

const HARNESS = process.env.HARNESS ?? "http://localhost:5177/";
const ORIGIN = process.env.SESSION_ORIGIN ?? process.env.ORIGIN ?? "http://127.0.0.1:8799";
const OUT_DIR = process.env.OUT_DIR ?? path.join(os.tmpdir(), "verify-record");
const LONG_S = Number(process.env.LONG_S ?? 0);
const RECORD_MS = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};
const ok = (msg) => console.log(`✓ ${msg}`);
const post = async (p, body) => {
  const res = await fetch(`${ORIGIN}${p}`, {
    method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return [res.status, await res.json()];
};

// A Hydra kaleidoscope with a constant colour floor (so "black" can't be the
// shader's own darkness) under a piano roll, over an audible bass + kick.
const HYDRA = `// opener — kaleidoscope
await initHydra()
osc(8, 0.05, 0.9).rotate(0.3).kaleid(5).color(0.5, 0.35, 1).add(solid(0.15, 0.1, 0.25)).out(o0)
setcps(0.5)
stack(
  s("bd*4").bank('RolandTR909'),
  note("c2 eb2 g2 bb2").s('sawtooth').lpf(800)
).pianoroll()`;
// What the session swaps in: no Hydra — the 2D roll over the stage colour.
const ROLL = `// second half — roll only
setcps(0.5)
note("c3 e3 g3 b3 c4 b3 g3 e3").s('triangle').gain(0.8).pianoroll({ fold: 1 })`;

const browser = await engine.launch({
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
console.log(`engine: ${BROWSER} ${browser.version()}`);
fs.mkdirSync(OUT_DIR, { recursive: true });
const errors = [];

/** Load a pattern into the harness widget, wait for it to play, click inside the frame. */
async function openWidget(code, meta) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: Number(process.env.DPR ?? 1) });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(HARNESS);
  await page.waitForFunction(() => document.getElementById("state")?.textContent?.startsWith("connected"), null, { timeout: 30000 });
  if (meta) await page.evaluate((m) => window.__harness.setResultMeta(m), meta);
  await page.fill("#args", JSON.stringify({ code, autoplay: true, title: "verify record" }));
  await page.click("#send");
  const frame = () => page.frames().find((f) => f.url().includes("/widgets/"));
  for (let i = 0; i < 100 && !frame(); i++) await sleep(100);
  if (!frame()) throw new Error("the widget never loaded");
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    const status = await frame().evaluate(() => document.getElementById("status")?.textContent ?? "").catch(() => "");
    const hydraUp = await frame().evaluate(() => !!document.getElementById("hydra-canvas")).catch(() => false);
    if (/^Playing/.test(status) && hydraUp) break;
  }
  // A real click inside the frame AFTER Strudel loaded (worklets, audio unlock).
  const box = await (await page.$("iframe")).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.8);
  await sleep(1500);
  return { context, page, frame };
}

/** The recorded file + its decode, measured in the harness page (top level). */
async function decodeInPage(page, base64, mimeType, background) {
  return page.evaluate(async ({ base64, mimeType, background }) => {
    const out = { frames: [], errors: [] };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const video = document.createElement("video");
    video.playsInline = true;
    video.src = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    const probe = document.createElement("canvas");
    probe.width = 160;
    probe.height = 90;
    const pctx = probe.getContext("2d", { willReadFrequently: true });
    // The stage colour fills the frame behind the layers, so "non-black" alone
    // would pass on an empty stage: also count pixels that differ from it
    // (content) and the change since the previous sample (motion).
    const bg = (/(\d+)\D+(\d+)\D+(\d+)/.exec(background ?? "") ?? [0, 0, 0, 0]).slice(1).map(Number);
    let last = null;
    const sample = () => {
      pctx.fillStyle = "#000";
      pctx.fillRect(0, 0, 160, 90);
      pctx.drawImage(video, 0, 0, 160, 90);
      const d = pctx.getImageData(0, 0, 160, 90).data;
      let n = 0;
      let content = 0;
      let sum = 0;
      let motion = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] + d[i + 1] + d[i + 2] > 30) n++;
        if (Math.max(Math.abs(d[i] - bg[0]), Math.abs(d[i + 1] - bg[1]), Math.abs(d[i + 2] - bg[2])) > 40) content++;
        sum += d[i] + d[i + 1] + d[i + 2];
        if (last) motion += Math.abs(d[i] - last[i]) + Math.abs(d[i + 1] - last[i + 1]) + Math.abs(d[i + 2] - last[i + 2]);
      }
      const px = d.length / 4;
      const out = { nonBlack: n / px, content: content / px, mean: sum / px / 3, motion: last ? motion / px / 3 : null };
      last = d.slice();
      return out;
    };
    try {
      await Promise.race([
        new Promise((res, rej) => {
          video.onloadeddata = res;
          video.onerror = () => rej(new Error(`video error ${video.error?.code}: ${video.error?.message}`));
        }),
        sleep(8000).then(() => { throw new Error("loadeddata timeout"); }),
      ]);
      out.size = `${video.videoWidth}x${video.videoHeight}`;
      out.duration = video.duration;
      // Level: the element's own audio through an analyser.
      const ctx = new AudioContext();
      const src = ctx.createMediaElementSource(video);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      analyser.connect(ctx.destination);
      await ctx.resume().catch(() => {});
      let peak = 0;
      const buf = new Float32Array(1024);
      const meter = setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        for (const v of buf) peak = Math.max(peak, Math.abs(v));
      }, 20);
      await video.play();
      while (!video.ended && video.currentTime < 30) {
        await sleep(400);
        out.frames.push({ t: +video.currentTime.toFixed(2), ...sample() });
      }
      clearInterval(meter);
      out.audioPeak = peak;
      // WebKit's element → analyser path reads silence headless even for a
      // file with level (checked with ffmpeg volumedetect), so measure the
      // track itself: decode it whole and take the sample peak.
      try {
        const decoded = await new OfflineAudioContext(2, 48000, 48000).decodeAudioData(bytes.buffer.slice(0));
        let decodedPeak = 0;
        for (let c = 0; c < decoded.numberOfChannels; c++) for (const v of decoded.getChannelData(c)) decodedPeak = Math.max(decodedPeak, Math.abs(v));
        out.decodedPeak = decodedPeak;
        out.decodedSeconds = decoded.duration;
      } catch (e) {
        out.decodeAudioError = String(e?.message ?? e);
      }
      out.audioTracks = video.audioTracks ? video.audioTracks.length : null;
      out.decodedAudioBytes = video.webkitAudioDecodedByteCount ?? null;
      // A live WebM without a duration reports Infinity until played through.
      out.durationAfterPlay = video.duration;
      await ctx.close();
    } catch (e) {
      out.errors.push(String(e?.message ?? e));
    }
    return out;
  }, { base64, mimeType, background });
}

/** The newest downloads (the harness keeps every ui/download-file). */
async function waitForDownloads(page, count, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const n = await page.evaluate(() => window.__harness.downloads.length);
    if (n >= count) break;
    await sleep(250);
  }
  return page.evaluate(() => window.__harness.downloads.map((c) => c.map((x) => x.resource ?? x)));
}

function checkVideo(label, r, wallMs, expectSize) {
  const pct = (x) => `${(x * 100).toFixed(0)}%`;
  const lit = r.frames.filter((f) => f.nonBlack > 0.2 && f.content > 0.05);
  lit.length >= 2
    ? ok(`${label}: ${lit.length}/${r.frames.length} sampled frames are non-black and show more than the stage colour (non-black ${r.frames.map((f) => pct(f.nonBlack)).join(" ")}; content ${r.frames.map((f) => pct(f.content)).join(" ")})`)
    : fail(`${label}: only ${lit.length} frames with content: ${JSON.stringify(r.frames)} ${r.errors.join(" ")}`);
  const moving = r.frames.filter((f) => f.motion !== null && f.motion > 1);
  moving.length >= 2
    ? ok(`${label}: the picture moves (${r.frames.slice(1).map((f) => f.motion.toFixed(1)).join(" ")} mean change per sample, 0–255)`)
    : fail(`${label}: a still picture: ${r.frames.map((f) => f.motion).join(" ")}`);
  const dur = Number.isFinite(r.duration) ? r.duration : null;
  dur !== null && Math.abs(dur * 1000 - wallMs) <= 500
    ? ok(`${label}: duration ${dur.toFixed(2)} s vs ${(wallMs / 1000).toFixed(2)} s wall (reported at load)`)
    : fail(`${label}: duration at load ${r.duration} (after play ${r.durationAfterPlay}) vs ${(wallMs / 1000).toFixed(2)} s wall`);
  const level = Math.max(r.audioPeak ?? 0, r.decodedPeak ?? 0);
  level > 0.02
    ? ok(`${label}: the audio track has level (decoded peak ${r.decodedPeak?.toFixed(3) ?? `n/a: ${r.decodeAudioError}`} over ${r.decodedSeconds?.toFixed(2) ?? "?"} s; played-through peak ${r.audioPeak.toFixed(3)})`)
    : fail(`${label}: no audio level (decoded peak ${r.decodedPeak} ${r.decodeAudioError ?? ""}; played-through peak ${r.audioPeak}; tracks ${r.audioTracks}, decoded bytes ${r.decodedAudioBytes})`);
  if (expectSize) r.size === expectSize ? ok(`${label}: ${r.size}`) : fail(`${label}: frame ${r.size}, expected ${expectSize}`);
  if (r.errors.length) fail(`${label}: ${r.errors.join(" | ")}`);
}

// Can this engine record a canvas at all? The Linux WebKit port that Playwright
// ships on CI has no canvas.captureStream()/MediaRecorder video, so the widget
// hides "Rec video" there by the same feature test (canRecordVideo). macOS
// WebKit records. The skip is keyed on the PLATFORM capability, not on the
// button, so a button hidden on a capable engine still fails.
const VIDEO_SUPPORTED = await (async () => {
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  const caps = await pg.evaluate(() => ({
    capture: typeof HTMLCanvasElement.prototype.captureStream === "function",
    recorder: typeof MediaRecorder !== "undefined",
  }));
  await ctx.close();
  if (caps.capture && caps.recorder) return true;
  if (BROWSER !== "webkit") throw new Error(`no canvas video recording in ${BROWSER}: ${JSON.stringify(caps)}`);
  console.log(`skip: this WebKit build has no canvas video recording (${JSON.stringify(caps)}) — sections 1–2 skipped, the widget hides Rec video here by design`);
  return false;
})();

// ---------------------------------------------------------------------------
// 1. Three seconds of Hydra, in video
// ---------------------------------------------------------------------------
if (VIDEO_SUPPORTED) {
  const { context, page, frame } = await openWidget(HYDRA);
  const ui = await frame().evaluate(() => {
    const b = document.getElementById("video-btn");
    const section = document.querySelector(".repl-section");
    return { hidden: b?.hidden, disabled: b?.disabled, text: b?.textContent, stage: section.getBoundingClientRect().toJSON(), dpr: devicePixelRatio, bg: section.style.getPropertyValue("--viz-stage") };
  });
  !ui.hidden && !ui.disabled ? ok(`"${ui.text}" is offered`) : fail(`Rec video button: ${JSON.stringify(ui)}`);
  const expectW = Math.min(1280, Math.round(ui.stage.width * ui.dpr));
  await frame().click("#video-btn");
  const t0 = Date.now();
  await sleep(RECORD_MS);
  await frame().click("#video-btn");
  const wall = Date.now() - t0;
  const status = await frame().evaluate(() => document.getElementById("status")?.textContent);
  console.log(`  status after stop: ${status}`);
  await frame().click("#download-btn");
  const downloads = await waitForDownloads(page, 1);
  const file = downloads[0]?.[0];
  if (!file?.blob) {
    fail(`no download: ${JSON.stringify(downloads).slice(0, 200)}`);
  } else {
    const bytes = Buffer.from(file.blob, "base64");
    const out = path.join(OUT_DIR, `${BROWSER}-hydra.${file.uri.split(".").pop()}`);
    fs.writeFileSync(out, bytes);
    ok(`downloaded ${file.uri} (${file.mimeType}), ${bytes.length} bytes, base64 ${file.blob.length} chars → ${out}`);
    (BROWSER === "chromium" ? /^video\/webm$/ : /^video\/(mp4|webm)$/).test(file.mimeType)
      ? ok(`container ${file.mimeType}`)
      : fail(`unexpected container ${file.mimeType}`);
    const r = await decodeInPage(page, file.blob, file.mimeType, ui.bg);
    console.log(`  stage colour ${ui.bg}`);
    checkVideo("hydra take", r, wall);
    const [w] = (r.size ?? "0x0").split("x").map(Number);
    Math.abs(w - expectW) <= 2 ? ok(`frame width ${w} = stage ${Math.round(ui.stage.width)} CSS px × DPR ${ui.dpr} (cap 1280)`) : fail(`frame ${r.size}, expected width ${expectW}`);
    downloads.length === 1 ? ok("no setlist outside a live session") : fail(`${downloads.length} downloads outside a session`);
  }

  if (LONG_S > 0) {
    await page.evaluate(() => window.__harness.downloads.splice(0));
    await frame().click("#video-btn");
    const l0 = Date.now();
    await sleep(LONG_S * 1000);
    await frame().click("#video-btn");
    const lwall = Date.now() - l0;
    const d0 = Date.now();
    await frame().click("#download-btn");
    const long = (await waitForDownloads(page, 1, 120000))[0]?.[0];
    const took = Date.now() - d0;
    if (long?.blob) {
      const bytes = Buffer.from(long.blob, "base64").length;
      ok(`${LONG_S} s take: ${(bytes / 1e6).toFixed(1)} MB, base64 ${(long.blob.length / 1e6).toFixed(1)} M chars (${((bytes * 8) / (lwall / 1000) / 1e6).toFixed(2)} Mbit/s), the harness's downloadFile took it in ${took} ms`);
      fs.writeFileSync(path.join(OUT_DIR, `${BROWSER}-long.${long.uri.split(".").pop()}`), Buffer.from(long.blob, "base64"));
    } else {
      fail(`${LONG_S} s take: no download within 120 s`);
    }
  }
  await context.close();
}

// ---------------------------------------------------------------------------
// 2. Across a live-session swap, with a setlist
// ---------------------------------------------------------------------------
if (VIDEO_SUPPORTED) {
  const [, { id }] = await post("/session/new");
  const { context, page, frame } = await openWidget(HYDRA, { session: { id, origin: ORIGIN } });
  for (let i = 0; i < 40; i++) {
    const badge = await frame().evaluate(() => document.getElementById("session-badge")?.textContent ?? "");
    if (badge === "● live") break;
    await sleep(250);
  }
  await frame().click("#video-btn");
  const t0 = Date.now();
  await sleep(1500);
  const [status, outcome] = await post(`/session/${id}/update`, { code: ROLL, quantize: 1 });
  status === 200 && outcome.applied?.ok
    ? ok(`session swap applied at cycle ${outcome.applied.cycle} while recording`)
    : fail(`update: ${status} ${JSON.stringify(outcome)}`);
  await sleep(500);
  const during = await frame().evaluate(() => ({
    text: document.getElementById("video-btn")?.textContent,
    hydra: !!document.getElementById("hydra-canvas"),
  }));
  during.text === "Stop Rec" ? ok(`still recording after the swap (button "${during.text}"; Hydra ${during.hydra ? "still up" : "gone"})`) : fail(`recording ended at the swap: ${JSON.stringify(during)}`);
  await sleep(2000);
  await frame().click("#video-btn");
  const wall = Date.now() - t0;
  await frame().click("#download-btn");
  const downloads = await waitForDownloads(page, 2);
  const file = downloads[0]?.[0];
  const list = downloads[1]?.[0];
  if (!file?.blob) {
    fail("no video download after the session take");
  } else {
    fs.writeFileSync(path.join(OUT_DIR, `${BROWSER}-session.${file.uri.split(".").pop()}`), Buffer.from(file.blob, "base64"));
    const bg = await frame().evaluate(() => document.querySelector(".repl-section").style.getPropertyValue("--viz-stage"));
    const r = await decodeInPage(page, file.blob, file.mimeType, bg);
    checkVideo("session take", r, wall);
    const first = r.frames[0];
    const last = r.frames.at(-1);
    first && last && Math.abs(first.mean - last.mean) > 3
      ? ok(`the picture changes across the swap (mean level ${first.mean.toFixed(1)} → ${last.mean.toFixed(1)})`)
      : fail(`the picture did not change across the swap: ${JSON.stringify([first, last])}`);
  }
  if (list?.text) {
    fs.writeFileSync(path.join(OUT_DIR, `${BROWSER}-setlist.txt`), list.text);
    /start\s+opener — kaleidoscope/.test(list.text) && /Claude \(rev \d+\)\s+second half — roll only/.test(list.text)
      ? ok(`setlist ${list.uri}:\n${list.text.trimEnd().split("\n").map((l) => `    ${l}`).join("\n")}`)
      : fail(`setlist text:\n${list.text}`);
  } else {
    fail(`no setlist download (${downloads.length} downloads)`);
  }
  await context.close();

  // -------------------------------------------------------------------------
  // 3. Watch pages: /p/<id>?watch and /s/<id>?watch
  // -------------------------------------------------------------------------
  const [, stored] = await post("/share", { kind: "play", args: { code: HYDRA, title: "Watch check" } });
  const pUrl = new URL(stored.url);
  for (const url of [`${ORIGIN}${pUrl.pathname}?watch`, `${ORIGIN}/s/${id}?watch`]) {
    const label = url.includes("/s/") ? "/s/<id>?watch" : "/p/<id>?watch";
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    const wp = await ctx.newPage();
    wp.on("pageerror", (e) => errors.push(String(e)));
    const res = await wp.goto(url);
    res.status() === 200 ? ok(`${label} answers 200`) : fail(`${label} answered ${res.status()}`);
    const wf = await (await wp.waitForSelector("#stage iframe")).contentFrame();
    await wf.waitForSelector(".watch-start", { timeout: 30000 }).catch(() => {});
    await wf.waitForFunction(() => !!document.querySelector("strudel-editor")?.editor, null, { timeout: 30000 }).catch(() => {});
    await sleep(1500);
    const shown = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return getComputedStyle(el).display !== "none" && !el.hidden && r.width > 0 && r.height > 0;
    };
    const before = await wf.evaluate((shownSrc) => {
      const shown = eval(shownSrc);
      return {
        src: location.search,
        watch: document.documentElement.dataset.watch,
        stage: document.querySelector(".repl-section")?.classList.contains("stage-on"),
        code: shown(".strudel-container"),
        start: shown(".watch-start"),
        play: shown("#play-btn"),
        video: shown("#video-btn"),
        full: shown("#fullscreen-btn"),
        hidden: ["#viz-btn", "#stage-btn", "#send-btn", "#pass-btn", "#end-btn"].filter((s) => shown(s)),
        controls: document.querySelectorAll(".ms-controls").length,
        started: !!document.querySelector("strudel-editor")?.editor?.repl?.scheduler?.started,
      };
    }, `(${shown})`);
    before.watch === "true" && before.stage && !before.code
      ? ok(`${label}: stage only (code hidden)`)
      : fail(`${label}: ${JSON.stringify(before)}`);
    before.start && before.play && before.video === VIDEO_SUPPORTED && before.full && before.hidden.length === 0
      ? ok(`${label}: tap-to-start, Play, ${VIDEO_SUPPORTED ? "Rec video" : "no Rec video (unsupported here)"} and ⛶ shown; no editing buttons`)
      : fail(`${label}: buttons ${JSON.stringify(before)}`);
    before.controls === 0 ? ok(`${label}: no controls strip for a piece without controls`) : fail(`${label}: controls strip present`);
    !before.started ? ok(`${label}: nothing plays before the tap`) : fail(`${label}: playing before any tap`);
    await wf.click(".watch-start");
    let after = null;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      after = await wf.evaluate(() => ({
        started: !!document.querySelector("strudel-editor")?.editor?.repl?.scheduler?.started,
        overlay: !!document.querySelector(".watch-start"),
        status: document.getElementById("status")?.textContent,
        hydra: !!document.getElementById("hydra-canvas"),
      }));
      if (after.started) break;
    }
    after?.started && !after.overlay
      ? ok(`${label}: one tap starts it (status "${after.status}", Hydra ${after.hydra ? "up" : "not up"})`)
      : fail(`${label}: after the tap ${JSON.stringify(after)}`);
    await wp.screenshot({ path: path.join(OUT_DIR, `${BROWSER}-watch-${label.startsWith("/s") ? "s" : "p"}.png`) });
    await ctx.close();
  }
}

const real = errors.filter((e) => !/favicon|AudioContext was not allowed/i.test(e));
real.length ? fail(`page errors: ${real.slice(0, 3).join(" | ")}`) : ok("no page errors");
await browser.close();
