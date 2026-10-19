// The sheet widget's Stage, in a real browser through the real widget (dev
// harness, no Worker): the band appears with one instrument per sound, the
// transport lights what plays, a press on an instrument sounds it, pressing an
// instrument looks closer.
//
//   bun run build
//   bunx vite --config dev/vite.config.ts --port 5177
//   node scripts/verify-score-stage.mjs [shot.png]     # BROWSER=webkit for Safari's engine
import { engine } from "./lib/engine.mjs";

const HARNESS = process.env.HARNESS ?? "http://localhost:5177/";
const SHOT = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };
const ok = (msg) => console.log(`✓ ${msg}`);
const check = (cond, msg, detail = "") => (cond ? ok(msg) : fail(`${msg}${detail ? ` — ${detail}` : ""}`));

const STARTS = `(() => {
  globalThis.__starts = [];
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...args) {
    if (!(this.context instanceof OfflineAudioContext)) globalThis.__starts.push(performance.now());
    return start.apply(this, args);
  };
})();`;

const browser = await engine.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 1100, height: 1100 }, deviceScaleFactor: 2 });
await context.addInitScript(STARTS);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(HARNESS);
await page.waitForFunction(() => document.getElementById("state")?.textContent?.startsWith("connected"), null, { timeout: 30000 });
await page.evaluate(() => window.__harness.usePreset("abc-quintet"));
await page.evaluate(() => window.__harness.send());
const frame = () => page.frames().find((f) => f.url().includes("/widgets/mcp-app"));
for (let i = 0; i < 100 && !frame(); i++) await sleep(100);
const f = frame();
if (!f) throw new Error("the sheet widget never loaded");
f.on?.("pageerror", (e) => errors.push(String(e)));
await f.waitForSelector("#sheet-music .abcjs-note", { timeout: 30000 });

// The Stage is off until asked for.
check(await f.evaluate(() => document.querySelector(".stage")?.hidden === true), "the Stage starts hidden");
await f.click(".stage-toggle");
await f.waitForSelector(".stage-svg g[data-obj]", { timeout: 10000 });
const band = await f.evaluate(() => [...document.querySelectorAll(".stage-svg g[data-obj]")].map((g) => g.dataset.obj));
check(band.length === 5, "five instruments for five voices", band.join(", "));
for (const id of ["flute", "clarinet", "violin", "cello", "acoustic_grand_piano"]) check(band.includes(id), `${id} is on stage`);

// Play: something lights within a few seconds. The tool call autoplays, so ▶
// is pressed only if it is not already playing (a press would pause it).
const lit = () => f.evaluate(() => [...document.querySelectorAll(".stage-svg .on[data-k]")].map((e) => `${e.closest("[data-obj]").dataset.obj}:${e.dataset.k}`));
const playing = () => f.evaluate(() => document.querySelector(".abcjs-midi-start")?.classList.contains("abcjs-pushed") ?? false);
await sleep(1500);
if (!(await playing())) await f.click(".abcjs-midi-start");
check(await playing(), "the score is playing");
let seen = new Set();
for (let i = 0; i < 40; i++) {
  for (const k of await lit()) seen.add(k.split(":")[0]);
  await sleep(150);
}
check(seen.size >= 4, "playing lights at least four instruments", [...seen].join(", "));
if (SHOT) await f.locator(".stage").screenshot({ path: SHOT });
if (await playing()) await f.click(".abcjs-midi-start"); // pause
await sleep(600);

// Press a piano key: it goes down and sounds.
const before = await f.evaluate(() => globalThis.__starts.length);
const key = f.locator('.stage-svg g[data-obj="acoustic_grand_piano"] [data-k="k60"]').first();
await key.dispatchEvent("pointerdown", { button: 0, pointerId: 1, isPrimary: true, pointerType: "mouse" });
await sleep(60);
check(await key.evaluate((e) => e.classList.contains("down")), "a mouse press goes down at once");
await key.dispatchEvent("pointerup", { button: 0, pointerId: 1, isPrimary: true, pointerType: "mouse" });
await sleep(2500);
const after = await f.evaluate(() => globalThis.__starts.length);
check(after > before, "a pressed key sounds", `${before} → ${after} source starts`);

// Touch: a tap plays on lift; a finger that moves (a scroll) plays nothing.
const key2 = f.locator('.stage-svg g[data-obj="acoustic_grand_piano"] [data-k="k62"]').first();
const touch = { button: 0, pointerId: 7, isPrimary: true, pointerType: "touch", clientX: 100, clientY: 100 };
await key2.dispatchEvent("pointerdown", touch);
await sleep(40);
check(!(await key2.evaluate((e) => e.classList.contains("down"))), "a touch does not press until it lifts");
// Lift and read in one in-page step: the press shows for 110 ms, and a WebKit
// protocol round trip can take longer than that.
check(await key2.evaluate((e, init) => {
  e.dispatchEvent(new PointerEvent("pointerup", { ...init, bubbles: true }));
  return e.classList.contains("down");
}, touch), "a tap presses on lift");
await sleep(2500);
const n0 = await f.evaluate(() => globalThis.__starts.length);
await key2.dispatchEvent("pointerdown", { ...touch, pointerId: 8 });
await key2.dispatchEvent("pointermove", { ...touch, pointerId: 8, clientY: 160 });
await key2.dispatchEvent("pointerup", { ...touch, pointerId: 8, clientY: 160 });
await sleep(1500);
check((await f.evaluate(() => globalThis.__starts.length)) === n0, "a scroll that starts on a key plays nothing");

// Press the cello's body (not a string): the close-up opens; ✕ steps back.
await f.locator('.stage-svg g[data-obj="cello"] .p:not([data-k])').first().click({ force: true });
await sleep(600);
check(await f.evaluate(() => document.querySelector(".stage")?.classList.contains("close")), "pressing an instrument looks closer");
const vb = () => f.evaluate(() => document.querySelector(".stage-svg").getAttribute("viewBox").split(" ").map(Number));
const hands = await vb();
await f.click('.stage-btn[data-act="mode"]');
await sleep(700);
const whole = await vb();
check(whole[3] > hands[3] * 1.3, "whole frames the entire instrument", `${hands[3].toFixed(0)} → ${whole[3].toFixed(0)} tall`);
await f.click('.stage-btn[data-act="in"]');
await sleep(100);
const zin = await vb();
check(zin[2] < whole[2] * 0.7, "+ zooms in", `${whole[2].toFixed(0)} → ${zin[2].toFixed(0)} wide`);
// A real mouse drag on the paper pans and stays in the close-up.
const box = await f.locator(".stage-svg").boundingBox();
await page.mouse.move(box.x + 12, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + 80, box.y + box.height / 2 + 30, { steps: 5 });
await page.mouse.up();
await sleep(100);
const panned = await vb();
check(panned[0] < zin[0] && Math.abs(panned[2] - zin[2]) < 0.01, "a drag pans", `x ${zin[0].toFixed(1)} → ${panned[0].toFixed(1)}`);
check(await f.evaluate(() => document.querySelector(".stage")?.classList.contains("close")), "a drag does not leave the close-up");
// Join the cello: its voice goes quiet in the playback and shows as your part;
// the computer keyboard plays it, held notes and chords sounding together.
const celloOn = () => f.evaluate(() => [...document.querySelectorAll(".practice-voice-btn")].find((b) => /cello/i.test(b.textContent))?.getAttribute("aria-pressed"));
check((await celloOn()) === "true", "the cello voice plays before joining");
await f.click('.stage-btn[data-act="join"]');
await sleep(400);
check(await f.evaluate(() => document.querySelector(".stage")?.classList.contains("joined")), "join takes the part");
check((await celloOn()) === "false", "joining mutes that voice in the playback");
let yours = false;
for (let i = 0; i < 40 && !yours; i++) {
  await sleep(150);
  yours = await f.evaluate(() => document.querySelectorAll('.stage-svg g[data-obj="cello"] .yours').length > 0);
}
check(yours, "the joined part shows as yours while the band plays");
await sleep(1500); // the part's samples were fetched on join
const s0 = await f.evaluate(() => globalThis.__starts.length);
await f.evaluate(() => { for (const key of ["z", "c", "b"]) document.querySelector(".stage").dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });
await sleep(600);
const s1 = await f.evaluate(() => globalThis.__starts.length);
check(s1 - s0 >= 3, "a three-key chord sounds three notes at once", `${s1 - s0} source starts`);
check(await f.evaluate(() => document.querySelectorAll('.stage-svg g[data-obj="cello"] .down').length > 0), "the held notes show on the instrument");
await f.evaluate(() => { for (const key of ["z", "c", "b"]) document.querySelector(".stage").dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true })); });
await sleep(200);
check(await f.evaluate(() => document.querySelectorAll('.stage-svg g[data-obj="cello"] .down').length === 0), "letting go releases them");
await f.click('.stage-btn[data-act="join"]');
await sleep(400);
check((await celloOn()) === "true", "leaving gives the voice back");
await f.click('.stage-btn[data-act="back"]');
await sleep(500);
check(await f.evaluate(() => !document.querySelector(".stage")?.classList.contains("close")), "✕ steps back to the band");

// No broken SVG: an empty path (d="Z") logs a parse error in every engine.
check(await f.evaluate(() => !document.querySelector('.stage-svg path[d="Z"]')), "no empty paths");

check(errors.length === 0, "no page errors", errors.join(" | "));
await browser.close();
