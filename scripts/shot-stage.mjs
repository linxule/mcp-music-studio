// Screenshot the standalone Stage page (dev/stage-room.html) — drawing work.
//   node scripts/shot-stage.mjs <out.png> "<query>" [width] [waitMs]
import { engine } from "./lib/engine.mjs";

const [out = "stage.png", query = "", width = "860", wait = "900"] = process.argv.slice(2);
const browser = await engine.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: Number(width), height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.goto(`http://127.0.0.1:5177/stage-room.html?${query}`);
await page.waitForTimeout(Number(wait));
const el = await page.$("#wrap");
await el.screenshot({ path: out });
const info = await page.evaluate(() => ({
  paths: document.querySelectorAll(".stage-svg path").length,
  keys: document.querySelectorAll(".stage-svg [data-k]").length,
  lit: [...document.querySelectorAll(".stage-svg .on")].map((e) => e.getAttribute("data-k")).slice(0, 30),
  readout: document.querySelector(".stage-cap.br")?.textContent,
  nan: document.querySelector(".stage-svg")?.innerHTML.includes("NaN"),
}));
console.log(JSON.stringify({ ...info, errors }));
await browser.close();
