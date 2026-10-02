// Phone-sized check of the full-player share page in WebKit (iPhone emulation):
// no horizontal page scroll, the frame fills the width, Play and the control
// strip are reachable, and a screenshot for eyes. Not a substitute for a real
// iPhone (permission prompts, the silent switch, Safari fullscreen).
//   ORIGIN=https://music-studio.linxule.com bun scripts/check-share-phone.mjs [outdir]
import { webkit, devices } from "playwright";

const ORIGIN = process.env.ORIGIN ?? "https://music-studio.linxule.com";
const OUT = process.argv[2] ?? ".";
const b64 = (s) => Buffer.from(s, "utf8").toString("base64url");
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
await browser.close();
process.exitCode = failed ? 1 : 0;
