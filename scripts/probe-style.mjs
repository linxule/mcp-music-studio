// Computed style of elements in the standalone Stage page.
//   node scripts/probe-style.mjs "<query>" "<css selector>" [prop,prop]
import { engine } from "./lib/engine.mjs";
const [query = "", sel = ".stage-svg .m-rug .f", props = "fill,stroke"] = process.argv.slice(2);
const browser = await engine.launch({ headless: true });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:5177/stage-room.html?${query}`);
await page.waitForTimeout(1500);
console.log(JSON.stringify(await page.evaluate(([sel, props]) => [...document.querySelectorAll(sel)].slice(0, 4).map((el) => {
  const cs = getComputedStyle(el);
  return Object.fromEntries(props.split(",").map((p) => [p, cs.getPropertyValue(p)]).concat([["class", el.getAttribute("class")], ["parent", el.parentElement.getAttribute("class")]]));
}), [sel, props]), null, 1));
await browser.close();
