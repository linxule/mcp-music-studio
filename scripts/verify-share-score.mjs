// Acceptance check for the full player on SCORE share links, in a real browser,
// against the real Worker (wrangler dev):
//   - /score?a=… hosts the REAL sheet widget (from /widget/sheet), notation drawn;
//   - nothing plays until ▶ is pressed, and then it is audible (measured);
//   - the press reaches the widget's state (playPressed), which is what opens
//     play-current-music to a browser agent on this page;
//   - the MIDI and WAV exports save real files through this page's host;
//   - ?classic=1 keeps the standalone page, and a stored /p/<id> score gets the full player.
//
//   bun run build
//   (cd worker && bunx wrangler dev --port 8798)
//   bun scripts/verify-share-score.mjs
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
const ABC = `X:1\nT:Share score check\nM:4/4\nL:1/8\nQ:1/4=120\nK:G\n"G"G2B2 d2B2|"C"c2e2 "D"d2A2|"G"B2G2 "D"A2F2|"G"G8|]`;

const browser = await engine.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 1000, height: 800 }, acceptDownloads: true });
await context.addInitScript(LEVEL_TAP);
const page = await context.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

/** The widget's own state, read through the page's AppBridge (what the relay reads). */
const studioState = () =>
  page.evaluate(async () => {
    const result = await globalThis.__share.bridge.callTool({ name: "get-studio-state", arguments: {} });
    return result.structuredContent;
  });

// ---- /score: the full player ----
const res = await page.goto(`${ORIGIN}/score?a=${b64(ABC)}&style=folk&title=${encodeURIComponent("Score check")}`);
res.status() === 200 ? ok("/score answers 200") : fail(`/score answered ${res.status()}`);
const frameEl = await page.waitForSelector("#stage iframe", { timeout: 15000 });
const src = await frameEl.getAttribute("src");
src === "/widget/sheet" ? ok("the page frames /widget/sheet") : fail(`frame src: ${src}`);
const frame = await frameEl.contentFrame();
await frame.waitForSelector("#sheet-music svg, .abcjs-container", { timeout: 30000 }).catch(() => undefined);
await frame.waitForFunction(() => /▶ to play/.test(document.getElementById("status")?.textContent ?? ""), null, { timeout: 30000 }).catch(() => undefined);
const ui = await frame.evaluate(() => ({
  status: document.getElementById("status")?.textContent ?? "",
  svg: document.querySelectorAll("#sheet-music svg").length,
  notes: document.querySelectorAll("#sheet-music .abcjs-note").length,
  play: !!document.querySelector(".abcjs-midi-start"),
  title: document.getElementById("piece-title")?.textContent ?? "",
  midi: [...document.querySelectorAll("button")].some((b) => b.textContent === "MIDI" && !b.hidden && !b.disabled),
  wav: [...document.querySelectorAll("button")].some((b) => b.textContent === "↓" && !b.hidden),
  send: [...document.querySelectorAll("button")].some((b) => /send/i.test(b.title || b.textContent || "") && !b.hidden),
}));
ui.svg > 0 && ui.notes >= 10 ? ok(`notation rendered (${ui.notes} notes)`) : fail(`notation: ${JSON.stringify(ui)}`);
ui.play ? ok("abcjs audio controls present") : fail("no ▶ in the widget");
ui.title === "Score check" ? ok("the share's title reached the widget") : fail(`title: "${ui.title}"`);
ui.midi && ui.wav ? ok("WAV and MIDI offered (this host implements downloads)") : fail(`downloads hidden: ${JSON.stringify(ui)}`);
!ui.send ? ok("no 'Send to chat' (there is no chat here)") : fail("send-to-chat shown");

await sleep(2500);
const before = await frame.evaluate(() => globalThis.__peak ?? 0);
before < 0.01 ? ok(`silent until ▶ (peak ${before.toFixed(3)}, status "${ui.status}")`) : fail(`sound before ▶: ${before}`);
const unpressed = await studioState();
unpressed?.playPressed === false && unpressed?.args?.abcNotation?.includes("Share score check")
  ? ok("widget state: score loaded, playPressed false")
  : fail(`state before ▶: ${JSON.stringify(unpressed).slice(0, 300)}`);

// Click INSIDE the frame, after load: the gesture that lets the frame's audio start.
await frame.click(".abcjs-midi-start");
let after = 0;
for (let i = 0; i < 30 && after <= 0.05; i++) {
  await sleep(500);
  after = await frame.evaluate(() => globalThis.__peak ?? 0);
}
after > 0.05 ? ok(`▶ → audible (peak ${after.toFixed(3)})`) : fail(`no sound after ▶ (peak ${after})`);
let pressed = false;
for (let i = 0; i < 20 && !pressed; i++) {
  pressed = (await studioState())?.playPressed === true;
  if (!pressed) await sleep(250);
}
pressed ? ok("the press reached the widget's state (playPressed) — play-current-music opens to an agent") : fail("playPressed stayed false after ▶");

// ---- MIDI download through this page's host ----
const midiButton = frame.locator("button", { hasText: /^MIDI$/ });
const [download] = await Promise.all([
  page.waitForEvent("download", { timeout: 15000 }).catch(() => null),
  midiButton.click(),
]);
if (!download) {
  fail("the MIDI button saved nothing");
} else {
  const name = download.suggestedFilename();
  const path = await download.path();
  const { readFileSync } = await import("node:fs");
  const bytes = path ? readFileSync(path) : Buffer.alloc(0);
  name.endsWith(".mid") && bytes.subarray(0, 4).toString("latin1") === "MThd"
    ? ok(`MIDI saved: ${name} (${bytes.length} bytes, MThd header)`)
    : fail(`download: ${name}, ${bytes.length} bytes, header ${bytes.subarray(0, 4).toString("hex")}`);
}

// ---- WAV (after a play: abcjs fills the buffer when it primes) ----
const [wav] = await Promise.all([
  page.waitForEvent("download", { timeout: 30000 }).catch(() => null),
  frame.locator("button", { hasText: /^↓$/ }).click(),
]);
if (!wav) {
  fail("the WAV button saved nothing");
} else {
  const path = await wav.path();
  const { readFileSync } = await import("node:fs");
  const bytes = path ? readFileSync(path) : Buffer.alloc(0);
  wav.suggestedFilename().endsWith(".wav") && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.length > 44
    ? ok(`WAV saved: ${wav.suggestedFilename()} (${bytes.length} bytes, RIFF header)`)
    : fail(`WAV: ${wav.suggestedFilename()}, ${bytes.length} bytes`);
}

// ---- ?classic=1 and a stored score ----
const classic = await (await fetch(`${ORIGIN}/score?a=${b64(ABC)}&classic=1`)).text();
/var INIT = /.test(classic) && !/__SHARE_INIT__|id="stage"/.test(classic)
  ? ok("?classic=1 keeps the standalone page")
  : fail("?classic=1 did not serve the standalone page");
const stored = await (
  await fetch(`${ORIGIN}/share`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "score", args: { abcNotation: ABC, style: "waltz" } }),
  })
).json();
if (!stored?.url) {
  fail(`POST /share: ${JSON.stringify(stored)}`);
} else {
  const pPage = await context.newPage();
  await pPage.goto(`${ORIGIN}${new URL(stored.url).pathname}`);
  const pFrame = await (await pPage.waitForSelector("#stage iframe", { timeout: 15000 })).contentFrame();
  const drawn = await pFrame.waitForSelector("#sheet-music svg", { timeout: 30000 }).then(() => true, () => false);
  drawn ? ok("a stored /p/<id> score opens in the full player") : fail("/p/<id> score: no notation");
  await pPage.close();
}

const real = errors.filter((e) => !/favicon|AudioContext was not allowed/i.test(e));
real.length ? fail(`console errors: ${real.slice(0, 3).join(" | ")}`) : ok("no console errors");
await browser.close();
