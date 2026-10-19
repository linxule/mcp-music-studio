// Drawing-order probe for the standalone Stage: one object's parts in paint
// order (index:class[key]), or only the lit ones with "lit".
//   node scripts/probe-stage.mjs "<query>" <objId> [lit]
import { engine } from "./lib/engine.mjs";
const [query = "", id = "", mode = ""] = process.argv.slice(2);
const browser = await engine.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 860, height: 900 } });
await page.goto(`http://127.0.0.1:5177/stage-room.html?${query}`);
await page.waitForTimeout(1500);
const out = await page.evaluate(([id, mode]) => {
  const g = document.querySelector(`.stage-svg g[data-obj="${id}"]`);
  if (!g) return ["no object " + id + "; have: " + [...document.querySelectorAll(".stage-svg g[data-obj]")].map((e) => e.dataset.obj).join(", ")];
  return [...g.children].map((c, i) => ({ i, cls: c.getAttribute("class"), k: c.dataset.k ?? "" }))
    .filter((c) => mode !== "lit" || /\b(on|next|yours)\b/.test(c.cls))
    .map((c) => `${c.i}:${c.cls}${c.k ? "[" + c.k + "]" : ""}`);
}, [id, mode]);
console.log(out.join("\n"));
await browser.close();
