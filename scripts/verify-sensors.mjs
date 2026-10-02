// Acceptance check for tilt() and mic() in a real browser, through the real
// widget (dev harness): the mic is not opened before a tap, then its value
// follows Chromium's fake input device; tilt follows dispatched orientation
// events; with the microphone refused, mic() stays a manual fader on the strip
// and the model's report says it was refused.
//
//   bun run build
//   bunx vite --config dev/vite.config.ts --port 5179
//   bun scripts/verify-sensors.mjs
//
// Not covered (no way to drive it from Playwright): iOS's
// DeviceOrientationEvent.requestPermission() prompt, and a host frame whose
// permission policy blocks sensors (claude.ai) — the fake-window unit tests in
// tests/stage-runtime.test.ts cover both paths' logic.
import { chromium } from "playwright";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Chromium's default fake microphone is near-silent; feed it a 440 Hz tone.
function toneWav(seconds = 2, rate = 48000) {
  const n = seconds * rate;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 0.3 * 32767), 44 + i * 2);
  const path = join(mkdtempSync(join(tmpdir(), "ms-sensors-")), "tone.wav");
  writeFileSync(path, buf);
  return path;
}
const TONE = toneWav();

const HARNESS = process.env.HARNESS ?? "http://localhost:5179/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};
const ok = (msg) => console.log(`✓ ${msg}`);

const CODE = `setcps(0.5)
const room = mic('room')
const lean = tilt('lean')
s("hh*8").gain(room.fmap(v => 0.2 + v * 0.6)).pan(lean.x)`;

async function open(browser, permissions) {
  const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
  // Count real microphone requests in every frame (Kimi review: the
  // "not before a tap" claim was only read off the strip).
  await context.addInitScript(() => {
    globalThis.__gum = 0;
    const md = navigator.mediaDevices;
    if (md?.getUserMedia) {
      const real = md.getUserMedia.bind(md);
      md.getUserMedia = (c) => {
        globalThis.__gum++;
        return real(c);
      };
    }
  });
  if (permissions) await context.grantPermissions(permissions, { origin: new URL(HARNESS).origin });
  const page = await context.newPage();
  await page.goto(HARNESS);
  await page.waitForFunction(() => document.getElementById("state")?.textContent?.startsWith("connected"), null, { timeout: 30000 });
  await page.fill("#args", JSON.stringify({ code: CODE, autoplay: true }));
  await page.click("#send");
  let frame;
  for (let i = 0; i < 100 && !frame; i++) {
    await sleep(100);
    frame = page.frames().find((f) => f.url().includes("/widgets/"));
  }
  await frame.waitForSelector(".ms-controls", { timeout: 20000 });
  return { context, page, frame };
}

const tags = (frame) => frame.evaluate(() => [...document.querySelectorAll(".ms-src")].map((e) => e.textContent));
const reports = (page) =>
  page.evaluate(() => window.__harness.entries.filter((e) => /update-model-context/.test(e.text)).map((e) => e.text).join("\n"));

// ── granted: fake microphone + synthetic orientation ──
{
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${TONE}`,
    ],
  });
  // Chromium now has DeviceOrientationEvent.requestPermission(), answered from
  // these permissions.
  const { page, frame } = await open(browser, ["microphone", "accelerometer", "gyroscope", "magnetometer"]);
  await sleep(800);
  const before = await tags(frame);
  before.includes("by hand") ? ok(`before a tap, both are played by hand (${before.join(", ")})`) : fail(`before a tap: ${before}`);
  const asksBefore = await frame.evaluate(() => globalThis.__gum);
  asksBefore === 0 ? ok("no microphone request before a tap") : fail(`getUserMedia called ${asksBefore}× before any tap`);
  // A tap inside the frame asks for the mic.
  const box = await (await page.$("iframe")).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + 120);
  let level = 0;
  for (let i = 0; i < 40 && level <= 0.01; i++) {
    await sleep(100);
    level = await frame.evaluate(() => mic("room").value);
  }
  level > 0.01 ? ok(`mic() follows the fake input after a tap (value ${level.toFixed(3)})`) : fail(`mic() stayed at ${level}`);
  const afterTap = await tags(frame);
  afterTap.includes("● mic") ? ok("the strip shows the mic as live") : fail(`strip after tap: ${afterTap}`);
  // Orientation: Chromium has DeviceOrientationEvent without requestPermission.
  await frame.evaluate(() => {
    const fire = (beta, gamma) => window.dispatchEvent(new DeviceOrientationEvent("deviceorientation", { beta, gamma, alpha: 0 }));
    fire(40, 0);
    for (let i = 0; i < 20; i++) fire(40, 30);
  });
  const lean = await frame.evaluate(() => tilt("lean").value);
  lean[0] > 0.8 && Math.abs(lean[1] - 0.5) < 0.05
    ? ok(`tilt() follows orientation, level = how it was first held (x ${lean[0].toFixed(2)}, y ${lean[1].toFixed(2)})`)
    : fail(`tilt value ${lean}`);
  const liveTags = await tags(frame);
  liveTags.includes("● tilt") ? ok("the strip shows tilt as live") : fail(`strip: ${liveTags}`);
  const text = await reports(page);
  /mic \(microphone loudness\): LIVE/.test(text) && /tilt \(motion sensor\): LIVE/.test(text)
    ? ok("the model is told both sensors are live")
    : fail(`reports:\n${text.slice(-800)}`);
  await browser.close();
}

// ── refused: the microphone is denied ──
{
  const browser = await chromium.launch({
    headless: true,
    args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-device-for-media-stream", "--deny-permission-prompts"],
  });
  const { page, frame } = await open(browser, null);
  await sleep(800);
  const box = await (await page.$("iframe")).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + 120);
  await sleep(1500);
  const t = await tags(frame);
  t[0] === "by hand" ? ok("refused: mic() stays a manual fader on the strip") : fail(`refused strip: ${t}`);
  // The hand still plays it.
  const range = await frame.$(".ms-fader input");
  const disabled = await range.evaluate((el) => el.disabled);
  !disabled ? ok("…and the fader is playable by hand") : fail("fader disabled although the mic is refused");
  const text = await reports(page);
  /mic \(microphone loudness\): refused here \(\w+Error\)/.test(text)
    ? ok(`the model is told the mic was refused (${/mic \(microphone loudness\): refused here \((\w+)\)/.exec(text)?.[1]})`)
    : fail(`reports:\n${text.slice(-800)}`);
  await browser.close();
}
