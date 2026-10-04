// Acceptance check for the sheet widget's practice affordances, in a real
// browser, through the real widget (dev harness, no Worker needed):
//
//   - clicking a note selects its ABC in the editor and sounds it; a drag
//     that ends on a note is not a click;
//   - Loop selection plays the selected bars round and round (inside the tune,
//     and through the tune's end);
//   - muting voice 2 of a two-voice tune lowers the measured level, and the
//     loop keeps its place through the re-prime;
//   - a seek made with abcjs's progress bar keeps highlight and audio
//     together: paused (abcjs restarts the timer from a stale percent) and
//     playing, then paused and resumed (abcjs resumes the audio from a stale
//     start time).
//
//   bun run build
//   bunx vite --config dev/vite.config.ts --port 5177
//   node scripts/verify-score-click.mjs          # BROWSER=webkit for Safari's engine
import { engine } from "./lib/engine.mjs";

const HARNESS = process.env.HARNESS ?? "http://localhost:5177/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};
const ok = (msg) => console.log(`✓ ${msg}`);
const check = (cond, msg, detail = "") => (cond ? ok(msg) : fail(`${msg}${detail ? ` — ${detail}` : ""}`));

// Output meter (peak + mean square over a resettable window) and a log of
// every live AudioBufferSourceNode.start(): abcjs starts one source per track
// at `offset` seconds into the rendered tune, so the log says where the AUDIO
// is, independently of the highlight.
const PROBES = `(() => {
  const desc = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'destination');
  const taps = new WeakMap();
  globalThis.__peak = 0; globalThis.__sum = 0; globalThis.__n = 0;
  Object.defineProperty(BaseAudioContext.prototype, 'destination', { configurable: true, get() {
    if (this instanceof OfflineAudioContext) return desc.get.call(this);
    let t = taps.get(this);
    if (!t) {
      const real = desc.get.call(this), g = this.createGain(), a = this.createAnalyser();
      a.fftSize = 2048; g.connect(real); g.connect(a);
      Object.defineProperty(g, 'maxChannelCount', { value: real.maxChannelCount || 2 });
      const buf = new Float32Array(2048);
      setInterval(() => {
        a.getFloatTimeDomainData(buf);
        let p = 0, s = 0;
        for (const v of buf) { p = Math.max(p, Math.abs(v)); s += v * v; }
        globalThis.__peak = Math.max(globalThis.__peak, p);
        globalThis.__sum += s / buf.length; globalThis.__n++;
      }, 20);
      t = g; taps.set(this, t);
    }
    return t;
  } });
  globalThis.__starts = [];
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (when, offset, ...rest) {
    if (!(this.context instanceof OfflineAudioContext)) {
      globalThis.__starts.push({ at: performance.now(), offset: offset ?? 0, length: this.buffer?.duration ?? 0 });
    }
    return start.call(this, when, offset, ...rest);
  };
})();`;

// Two voices in the same rhythm, so muting one is measurable; fast, so a loop
// comes round quickly. No chord symbols and no style: nothing else sounds.
const BAR_S = 1.5; // 4/4 at ♩=160
const ABC = `X:1
T:Practice Check
M:4/4
L:1/8
Q:1/4=160
K:C
V:1
V:2 clef=bass
[V:1] c2 d2 e2 f2 | g2 a2 b2 c'2 | c'2 b2 a2 g2 | f2 e2 d2 c2 |]
[V:2] C,2 E,2 G,2 C2 | G,,2 B,,2 D,2 G,2 | A,,2 C,2 E,2 A,2 | F,,2 A,,2 C,2 F,2 |]`;

const browser = await engine.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 1000, height: 1000 } });
await context.addInitScript(PROBES);
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(HARNESS);
await page.waitForFunction(() => document.getElementById("state")?.textContent?.startsWith("connected"), null, { timeout: 30000 });
await page.evaluate(() => window.__harness.usePreset("abc-basic"));
await page.evaluate((abcNotation) => window.__harness.setArgs({ title: "Practice Check", abcNotation }), ABC);
await page.evaluate(() => window.__harness.send());
const frame = () => page.frames().find((f) => f.url().includes("/widgets/"));
for (let i = 0; i < 100 && !frame()?.url().includes("mcp-app"); i++) await sleep(100);
const f = frame();
if (!f) throw new Error("the sheet widget never loaded");
await f.waitForSelector("#sheet-music .abcjs-note", { timeout: 30000 });
await f.waitForSelector(".abcjs-midi-start", { timeout: 30000 });

const isPlaying = () => f.evaluate(() => document.querySelector(".abcjs-midi-start")?.classList.contains("abcjs-pushed") ?? false);
async function waitPlaying(want, ms = 15000) {
  for (let t = 0; t < ms; t += 100) {
    if ((await isPlaying()) === want) return true;
    await sleep(100);
  }
  return false;
}
async function pressPlay() {
  await f.click(".abcjs-midi-start");
}
const resetMeter = () => f.evaluate(() => { globalThis.__peak = 0; globalThis.__sum = 0; globalThis.__n = 0; });
const meter = () => f.evaluate(() => ({ peak: globalThis.__peak, rms: Math.sqrt(globalThis.__sum / Math.max(1, globalThis.__n)) }));
const starts = () => f.evaluate(() => globalThis.__starts.slice());
/** Measure (0-based) of the lit notes, or null. */
const litMeasure = () => f.evaluate(() => {
  const el = document.querySelector("#sheet-music .note-playing");
  const m = el?.getAttribute("class")?.match(/abcjs-m(\d+)/);
  return m ? Number(m[1]) : null;
});
const editor = () => f.evaluate(() => {
  const ta = document.getElementById("abc-editor");
  return { from: ta.selectionStart, to: ta.selectionEnd, text: ta.value.slice(ta.selectionStart, ta.selectionEnd) };
});
const note = (voice, n) => f.locator(`#sheet-music .abcjs-note.abcjs-v${voice}`).nth(n);
/** Click a notehead where a person would. A staff line may be on top there:
 *  abcjs then finds the nearest note by coordinates, as it does for a person. */
const clickNote = (voice, n, modifiers = []) =>
  note(voice, n).locator(".abcjs-notehead").first().click({ force: true, modifiers });

// The tool call autoplays; let it start, then stop it so clicks are measured alone.
check(await waitPlaying(true), "the tool call autoplays");
await pressPlay();
check(await waitPlaying(false), "▶ pauses it");
await sleep(1200);

// ── 1. Click a note: selection + sound ──────────────────────────────────────
await resetMeter();
await clickNote(0, 2);
await sleep(1500);
let sel = await editor();
let level = await meter();
check(sel.text === "e2", "a click selects the note's ABC in the (closed) editor", JSON.stringify(sel));
const audition = (await starts()).at(-1);
check(level.peak > 0.02, `the clicked note sounds (peak ${level.peak.toFixed(3)}; buffer ${audition?.length.toFixed(3)} s)`);
// A quarter at ♩=160 is 0.375 s; the widget's 500 ms release rings on after it
// (abcjs's playEvent would use its 200 ms default: 0.575 s).
check(audition && audition.length > 0.375 + 0.45, "…with the widget's release, not playEvent's 200 ms clip", String(audition?.length));
check(!(await isPlaying()), "the click does not start the tune");
const status = await f.evaluate(() => document.getElementById("status")?.textContent ?? "");
check(/Selected e2/.test(status), "the status line names the selection", status);
// The review tools read the widget's selection (studio session read()). The
// harness host gets the full passage panel: "Use selection" there must pick
// up the clicked note, with the editor still closed.
await f.evaluate(() => { document.getElementById("studio-review-panel").open = true; });
await f.click("#review-capture");
await f.waitForFunction(() => document.getElementById("review-selection")?.hidden === false, null, { timeout: 5000 }).catch(() => {});
const passage = await f.evaluate(() => document.getElementById("review-selected")?.textContent ?? null);
check(passage?.includes("e2") && !passage.includes("d2"), "the review panel's Use selection picks up the clicked note", JSON.stringify(passage));
await f.click("#review-clear").catch(() => {});
await f.evaluate(() => { document.getElementById("studio-review-panel").open = false; });

await f.click("button[aria-controls='editor-pane']");
await clickNote(1, 5);
sel = await editor();
const focused = await f.evaluate(() => document.activeElement?.id);
check(sel.text === "B,,2", "with the editor open, a click selects the bass note's ABC", JSON.stringify(sel));
check(focused === "abc-editor", "…and a mouse click focuses the editor on it", String(focused));

// Shift extends.
await clickNote(0, 4);
await clickNote(0, 7, ["Shift"]);
sel = await editor();
check(sel.text === "g2 a2 b2 c'2", "Shift-click extends the selection to the second note", JSON.stringify(sel));
const marked = await f.evaluate(() => document.querySelectorAll("#sheet-music .abcjs-note_selected").length);
check(marked >= 4, `the selection is marked on the score (${marked} elements)`);

// A press on a note that then moves is a scroll, not a click. abcjs reports
// it as a click on the pressed note at release, wherever the pointer is.
const before = await editor();
const head = note(0, 9).locator(".abcjs-notehead").first();
await head.scrollIntoViewIfNeeded();
const box = await head.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
// Along the staff, so the pointer stays on the score, not on the editor above it.
await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2, { steps: 5 });
await page.mouse.up();
await sleep(200);
const afterDrag = await editor();
check(afterDrag.from === before.from && afterDrag.to === before.to, "a press on a note that moves 30 px does not select it", JSON.stringify(afterDrag));
// Control: the same press moving 5 px (within the tap slop) is a click, so it
// is the slop that rejected the 30 px one, not abcjs.
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2 + 5, box.y + box.height / 2, { steps: 2 });
await page.mouse.up();
await sleep(200);
const small = await editor();
check(small.text === "b2", "control: the same press moving 5 px selects the note", JSON.stringify(small));

// ── 2. Loop bars 2–3 (inside the tune) ──────────────────────────────────────
await clickNote(0, 4);
await clickNote(0, 11, ["Shift"]);
sel = await editor();
check(sel.text === "g2 a2 b2 c'2 | c'2 b2 a2 g2", "selected bars 2–3", JSON.stringify(sel));
const startsBefore = (await starts()).length;
await f.click(".practice-loop-btn");
check(await waitPlaying(true), "Loop selection starts playback");
const seen = [];
for (let t = 0; t < 3.4 * 2 * BAR_S * 1000; t += 50) {
  const m = await litMeasure();
  if (m !== null && seen[seen.length - 1] !== m) seen.push(m);
  await sleep(50);
}
const wraps = seen.filter((m, i) => i > 0 && m === 1 && seen[i - 1] === 2).length;
const outside = seen.filter((m) => m !== 1 && m !== 2);
check(wraps >= 2, `the loop comes round (${wraps} wraps; measures lit: ${seen.join(" ")})`);
check(outside.length === 0, "nothing outside the selection lights up", seen.join(" "));
const loopStarts = (await starts()).slice(startsBefore);
const atLoopStart = loopStarts.filter((s) => Math.abs(s.offset - BAR_S) < 0.08);
check(atLoopStart.length >= 2 * 2, `the audio restarts at the loop's start (${atLoopStart.length} sources at ${BAR_S}s; offsets ${[...new Set(loopStarts.map((s) => s.offset.toFixed(2)))].join(", ")})`);
await resetMeter();
await sleep(1000);
level = await meter();
check(level.peak > 0.02 && (await isPlaying()), `still playing after ${wraps} wraps (peak ${level.peak.toFixed(3)})`);

// ── 3. Mute voice 2 inside the loop ─────────────────────────────────────────
const voiceButtons = await f.locator(".practice-voice-btn").count();
check(voiceButtons === 2, `two voice toggles (${voiceButtons})`);
const cycle = 2 * BAR_S * 1000;
await resetMeter();
await sleep(cycle);
const unmuted = await meter();
await f.locator(".practice-voice-btn").nth(1).click();
await sleep(1200); // re-prime
await resetMeter();
await sleep(cycle);
const muted = await meter();
check(muted.rms < unmuted.rms * 0.8, `muting voice 2 lowers the level (rms ${unmuted.rms.toFixed(4)} → ${muted.rms.toFixed(4)})`);
const afterMute = [];
for (let t = 0; t < 2000; t += 100) {
  const m = await litMeasure();
  if (m !== null) afterMute.push(m);
  await sleep(100);
}
check(afterMute.length > 0 && afterMute.every((m) => m === 1 || m === 2), "the loop keeps its place through the mute", afterMute.join(" "));
await f.locator(".practice-voice-btn").nth(1).click(); // unmute
await sleep(1200);

// ── 4. Loop through the tune's end (bars 3–4) ───────────────────────────────
await f.click(".practice-loop-btn"); // off
await clickNote(0, 8);
await clickNote(0, 15, ["Shift"]);
await f.click(".practice-loop-btn");
const seenEnd = [];
for (let t = 0; t < 2.6 * 2 * BAR_S * 1000; t += 50) {
  const m = await litMeasure();
  if (m !== null && seenEnd[seenEnd.length - 1] !== m) seenEnd.push(m);
  await sleep(50);
}
const endWraps = seenEnd.filter((m, i) => i > 0 && m === 2 && seenEnd[i - 1] === 3).length;
check(endWraps >= 2 && seenEnd.every((m) => m === 2 || m === 3), `a loop through the tune's end comes round (${endWraps} wraps; ${seenEnd.join(" ")})`);
check(await isPlaying(), "…and is still playing");
await f.click(".practice-loop-btn"); // off

// ── 5. Progress-bar seeks keep highlight and audio together ─────────────────
const progress = f.locator(".abcjs-midi-progress-background");
const clickAt = async (fraction) => {
  const b = await progress.boundingBox();
  await page.mouse.click(b.x + b.width * fraction, b.y + b.height / 2);
};
if (await isPlaying()) await pressPlay();
await waitPlaying(false);
await sleep(300);
// Paused seek to 3/4 of the way, then ▶.
let mark = (await starts()).length;
await clickAt(0.78);
await sleep(200);
await pressPlay();
await waitPlaying(true);
await sleep(250);
const pausedSeekLit = await litMeasure();
const pausedSeekAudio = (await starts()).slice(mark).map((s) => s.offset);
check(pausedSeekLit === 3, `after a paused seek into bar 4, bar 4 lights up (lit: m${pausedSeekLit})`);
check(pausedSeekAudio.length > 0 && pausedSeekAudio.every((o) => o > 3 * BAR_S - 0.2), `…and the audio starts there too (offsets ${pausedSeekAudio.map((o) => o.toFixed(2)).join(", ")})`);
await pressPlay();
await waitPlaying(false);

// Playing: seek to the middle, then pause and resume.
await clickAt(0.02);
await pressPlay();
await waitPlaying(true);
await sleep(400);
await clickAt(0.5);
await sleep(600);
await pressPlay(); // pause
await waitPlaying(false);
mark = (await starts()).length;
await sleep(300);
await pressPlay(); // resume
await waitPlaying(true);
await sleep(250);
const resumedLit = await litMeasure();
const resumedAudio = (await starts()).slice(mark).map((s) => s.offset);
// Paused about 0.6 s after jumping to the middle (3.0 s): ~3.6 s, in bar 3.
check(resumedLit === 2, `after a running seek, pause and ▶, the highlight resumes in bar 3 (lit: m${resumedLit})`);
check(resumedAudio.length > 0 && resumedAudio.every((o) => o > 3.2 && o < 4.3), `…and so does the audio (offsets ${resumedAudio.map((o) => o.toFixed(2)).join(", ")})`);

// ── 6. A mute made while paused keeps the place too ─────────────────────────
await pressPlay(); // pause
await waitPlaying(false);
await f.locator(".practice-voice-btn").nth(1).click(); // re-primes, paused
await sleep(1500);
mark = (await starts()).length;
await pressPlay();
await waitPlaying(true);
await sleep(250);
const mutedLit = await litMeasure();
const mutedAudio = (await starts()).slice(mark).map((s) => s.offset);
check(
  mutedAudio.length > 0 && mutedAudio.every((o) => o > 2 * BAR_S) && mutedLit === Math.floor(mutedAudio[0] / BAR_S),
  `a mute while paused resumes where it paused, highlight and audio together (lit m${mutedLit}, offsets ${mutedAudio.map((o) => o.toFixed(2)).join(", ")})`,
);

const errors = pageErrors.filter((e) => !/ResizeObserver loop/.test(e));
check(errors.length === 0, "no page errors", errors.join("\n"));
await browser.close();
