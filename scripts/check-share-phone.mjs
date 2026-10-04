// Phone-sized check of the full-player share pages in WebKit (iPhone emulation):
// no horizontal page scroll, the frame fills the width, Play and the control
// strip are reachable (/play); the score is drawn, fits its frame and ▶ and
// the toolbar are reachable (/score); the watch page shows the stage, its
// tap-to-start and buttons inside the frame (/play?watch); and screenshots for eyes. Not a substitute
// for a real iPhone (permission prompts, the silent switch, Safari fullscreen).
//   ORIGIN=https://music-studio.linxule.com bun scripts/check-share-phone.mjs [outdir]
import { webkit, devices } from "playwright";

const ORIGIN = process.env.ORIGIN ?? "https://music-studio.linxule.com";
const OUT = process.argv[2] ?? ".";
const b64 = (s) => Buffer.from(s, "utf8").toString("base64url");
const ABC = `X:1\nT:Phone score\nM:4/4\nL:1/8\nK:D\n"D"d2f2 a2f2|"G"g2b2 "A"a2e2|"Bm"f2d2 "A"e2c2|"D"d8|"D"d2f2 a2f2|"G"g2b2 "A"a4|"D"d8|]`;
const CODE = `const rain = fader('rain', { init: 0.3 })\nconst drop = pad('drop')\nconst space = xy('space')\nsetcps(0.5)\nstack(s("bd*4").gain(0.8), s("hh*8").gain(rain), note("c3 eb3 g3 bb3").s("sawtooth").lpf(space.x.range(300, 3000)).gain(drop.range(0.2, 0.6))).pianoroll()`;
let failed = 0;
const ok = (m) => console.log(`✓ ${m}`);
const fail = (m) => (failed++, console.error(`✗ ${m}`));

const browser = await webkit.launch();
for (const name of ["iPhone 15", "iPhone SE"]) {
  const ctx = await browser.newContext({ ...devices[name] });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${ORIGIN}/play?c=${b64(CODE)}&title=${encodeURIComponent("Phone check")}`, { waitUntil: "load" });
  const frameEl = await page.waitForSelector("#stage iframe", { timeout: 20000 });
  const frame = await frameEl.contentFrame();
  await frame.waitForSelector("strudel-editor, #strudel-container", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(6000);
  const vw = page.viewportSize().width;
  const page_ = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  page_.sw <= page_.cw ? ok(`${name}: no horizontal page scroll (${page_.sw} ≤ ${page_.cw})`) : fail(`${name}: page scrolls sideways (${page_.sw} > ${page_.cw})`);
  const box = await frameEl.boundingBox();
  box && box.width >= vw - 40 ? ok(`${name}: frame ${Math.round(box.width)}×${Math.round(box.height)} in a ${vw}px viewport`) : fail(`${name}: frame box ${JSON.stringify(box)}`);
  // Nothing evaluates before Play on a share page; controls appear with the evaluation.
  await frame.tap("#play-btn").catch((e) => fail(`${name}: tap Play: ${e.message}`));
  await frame.waitForSelector(".ms-controls input, .ms-controls button", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const inner = await frame.evaluate(() => {
    const vis = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), hidden: el.hidden || r.width === 0 };
    };
    return {
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
      play: vis("#play-btn") ?? vis("button[aria-label*='Play' i]"),
      controls: vis(".ms-controls"),
      inputs: document.querySelectorAll(".ms-controls input, .ms-controls button, .ms-controls .ms-xy").length,
      status: document.querySelector("#status")?.textContent ?? "",
    };
  });
  inner.sw <= inner.cw + 1 ? ok(`${name}: widget fits its frame (${inner.sw} ≤ ${inner.cw})`) : fail(`${name}: widget scrolls sideways inside the frame (${inner.sw} > ${inner.cw})`);
  inner.play && !inner.play.hidden ? ok(`${name}: Play visible (${inner.play.w}×${inner.play.h})`) : fail(`${name}: Play not visible ${JSON.stringify(inner.play)}`);
  inner.inputs >= 3 && inner.controls && inner.controls.right <= inner.cw + 1
    ? ok(`${name}: control strip has ${inner.inputs} controls, inside the frame`)
    : fail(`${name}: control strip ${JSON.stringify(inner.controls)} inputs=${inner.inputs}`);
  console.log(`  status after Play: ${inner.status}`);
  errors.length ? fail(`${name}: page errors: ${errors.join(" | ").slice(0, 300)}`) : ok(`${name}: no page errors`);
  await page.screenshot({ path: `${OUT}/share-${name.replace(/\s+/g, "-")}.png`, fullPage: true });
  await ctx.close();
}

// ---- /score: the sheet widget in the same frame ----
for (const name of ["iPhone 15", "iPhone SE"]) {
  const ctx = await browser.newContext({ ...devices[name] });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${ORIGIN}/score?a=${b64(ABC)}&style=folk`, { waitUntil: "load" });
  const frameEl = await page.waitForSelector("#stage iframe", { timeout: 20000 });
  const frame = await frameEl.contentFrame();
  await frame.waitForSelector("#sheet-music svg", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const vw = page.viewportSize().width;
  const vh = page.viewportSize().height;
  const outer = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  outer.sw <= outer.cw ? ok(`${name} score: no horizontal page scroll (${outer.sw} ≤ ${outer.cw})`) : fail(`${name} score: page scrolls sideways (${outer.sw} > ${outer.cw})`);
  const box = await frameEl.boundingBox();
  // Full height: the frame takes everything below the header.
  box && box.width >= vw - 40 && box.height >= vh * 0.8
    ? ok(`${name} score: frame ${Math.round(box.width)}×${Math.round(box.height)} in a ${vw}×${vh} viewport`)
    : fail(`${name} score: frame box ${JSON.stringify(box)} in ${vw}×${vh}`);
  const inner = await frame.evaluate(() => {
    const vis = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom), hidden: el.hidden || r.width === 0 };
    };
    return {
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
      svg: vis("#sheet-music svg"),
      play: vis(".abcjs-midi-start"),
      toolbar: vis("#toolbar"),
      status: document.querySelector("#status")?.textContent ?? "",
    };
  });
  inner.sw <= inner.cw + 1 ? ok(`${name} score: widget fits its frame (${inner.sw} ≤ ${inner.cw})`) : fail(`${name} score: widget scrolls sideways inside the frame (${inner.sw} > ${inner.cw})`);
  inner.svg && inner.svg.right <= inner.cw + 1 ? ok(`${name} score: notation ${inner.svg.w}×${inner.svg.h}, inside the frame`) : fail(`${name} score: notation ${JSON.stringify(inner.svg)}`);
  inner.play && !inner.play.hidden ? ok(`${name} score: ▶ visible (${inner.play.w}×${inner.play.h})`) : fail(`${name} score: ▶ not visible ${JSON.stringify(inner.play)}`);
  inner.toolbar && inner.toolbar.right <= inner.cw + 1 ? ok(`${name} score: toolbar inside the frame`) : fail(`${name} score: toolbar ${JSON.stringify(inner.toolbar)}`);
  console.log(`  status: ${inner.status}`);
  errors.length ? fail(`${name} score: page errors: ${errors.join(" | ").slice(0, 300)}`) : ok(`${name} score: no page errors`);
  await page.screenshot({ path: `${OUT}/share-score-${name.replace(/\s+/g, "-")}.png`, fullPage: true });
  await ctx.close();
}
// ---- /play?watch: the stage alone, one tap to start ----
for (const name of ["iPhone 15", "iPhone SE"]) {
  const ctx = await browser.newContext({ ...devices[name] });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${ORIGIN}/play?c=${b64(CODE)}&title=${encodeURIComponent("Watch check")}&watch`, { waitUntil: "load" });
  const frameEl = await page.waitForSelector("#stage iframe", { timeout: 20000 });
  const frame = await frameEl.contentFrame();
  await frame.waitForSelector(".watch-start", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const vw = page.viewportSize().width;
  const outer = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  outer.sw <= outer.cw ? ok(`${name} watch: no horizontal page scroll (${outer.sw} ≤ ${outer.cw})`) : fail(`${name} watch: page scrolls sideways (${outer.sw} > ${outer.cw})`);
  const box = await frameEl.boundingBox();
  box && box.width >= vw - 40 ? ok(`${name} watch: frame ${Math.round(box.width)}×${Math.round(box.height)}`) : fail(`${name} watch: frame box ${JSON.stringify(box)}`);
  const look = () => frame.evaluate(() => {
    const vis = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom), hidden: el.hidden || getComputedStyle(el).display === "none" || r.width === 0 };
    };
    return {
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
      ch: document.documentElement.clientHeight,
      start: vis(".watch-start"),
      code: vis(".strudel-container"),
      play: vis("#play-btn"),
      video: vis("#video-btn"),
      full: vis("#fullscreen-btn"),
      controls: vis(".ms-controls"),
      inputs: document.querySelectorAll(".ms-controls input, .ms-controls button, .ms-controls .ms-xy").length,
      status: document.querySelector("#status")?.textContent ?? "",
    };
  });
  const before = await look();
  before.sw <= before.cw + 1 ? ok(`${name} watch: widget fits its frame (${before.sw} ≤ ${before.cw})`) : fail(`${name} watch: widget scrolls sideways (${before.sw} > ${before.cw})`);
  before.code?.hidden !== false ? ok(`${name} watch: code hidden`) : fail(`${name} watch: code shows ${JSON.stringify(before.code)}`);
  before.start && !before.start.hidden && before.start.right <= before.cw && before.start.bottom <= before.ch
    ? ok(`${name} watch: tap-to-start ${before.start.w}×${before.start.h}, inside the frame`)
    : fail(`${name} watch: tap-to-start ${JSON.stringify(before.start)}`);
  for (const key of ["play", "video", "full"]) {
    const b = before[key];
    b && !b.hidden && b.right <= before.cw + 1 ? ok(`${name} watch: ${key} button inside the frame`) : fail(`${name} watch: ${key} button ${JSON.stringify(b)}`);
  }
  await frame.tap(".watch-start").catch((e) => fail(`${name} watch: tap: ${e.message}`));
  await frame.waitForSelector(".ms-controls input, .ms-controls button", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const after = await look();
  !after.start ? ok(`${name} watch: the tap removed the overlay (status "${after.status}")`) : fail(`${name} watch: overlay still up after the tap`);
  after.inputs >= 3 && after.controls && after.controls.right <= after.cw + 1
    ? ok(`${name} watch: the piece's controls show (${after.inputs}), inside the frame`)
    : fail(`${name} watch: controls ${JSON.stringify(after.controls)} inputs=${after.inputs}`);
  errors.length ? fail(`${name} watch: page errors: ${errors.join(" | ").slice(0, 300)}`) : ok(`${name} watch: no page errors`);
  await page.screenshot({ path: `${OUT}/share-watch-${name.replace(/\s+/g, "-")}.png`, fullPage: true });
  await ctx.close();
}

await browser.close();
process.exitCode = failed ? 1 : 0;
