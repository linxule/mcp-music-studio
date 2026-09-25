// Strudel screens for the film:
//   build   — the pattern grows a layer every 2 cycles, holds, then the five shader scenes, Stop, ring-out
//   solo    — the finished pattern with each layer alone for one 4-cycle loop (panels)
// Every downbeat is logged as a mark `c<N>` (wall time of the cycle boundary).
import { launch, openStage, startCapture, stopCapture, sleep, inWidget, waitInWidget, mark, HERE } from "./lib.mjs";
import { FINALE_START, FINALE_LAYERS, SCENES, montage } from "../../../dev/film-score.ts";
import path from "node:path";
import fs from "node:fs";

const which = process.argv[2] ?? "build";
const outDir = path.join(HERE, "takes", `screen-${which}`);
fs.rmSync(outDir, { recursive: true, force: true });
const b = await launch({ gpu: true });
const film = await openStage(b, { url: "http://localhost:5210/stage-strudel.html", outDir, captureTop: false });
const frame = () => film.page.frames().find((f) => f.url().includes("/widgets/strudel-app.html"));
const codeAt = (n) => FINALE_START + FINALE_LAYERS.slice(0, n + 1).join("");
const now = () => inWidget(film, 0, "document.querySelector('strudel-editor').editor.repl.scheduler.now()");
const cps = () => inWidget(film, 0, "document.querySelector('strudel-editor').editor.repl.scheduler.cps");
const setDoc = (code) => inWidget(film, 0, `(() => { const v = document.querySelector('strudel-editor').editor.editor; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: ${JSON.stringify(code)} } }); })()`);
const evaluate = () => inWidget(film, 0, "document.querySelector('strudel-editor').editor.evaluate(true).then(() => 'ok')");
async function beforeDownbeat(c, lead = 0.04) {
  for (let k = 0; k < 4000; k++) { if ((await now()) >= c - lead) return; await sleep(6); }
}
// Downbeat logger.
let logging = true;
(async () => {
  let last = -1;
  while (logging) {
    const t = await now().catch(() => null);
    if (typeof t === "number") {
      const c = Math.floor(t);
      if (c !== last && last !== -1) {
        const perCycle = 1000 / (await cps());
        film.marks ??= [];
        film.marks.push({ label: `c${c}`, wall: Date.now() - (t - c) * perCycle });
      }
      last = c;
    }
    await sleep(20);
  }
})();

await film.page.evaluate((c) => window.__screen.send(c), which === "build" ? codeAt(0) : codeAt(3));
await sleep(2500);
// It may already be playing (the host page's gesture reaches this same-origin
// frame); pressing Play then would STOP it and clear the draw layers.
const statusText = () => frame().evaluate(() => document.getElementById("status").textContent);
if (!/playing/i.test(await statusText())) await frame().click("#play-btn");
await sleep(1200);
console.log("status:", await statusText());
await waitInWidget(film, 0, "!!document.querySelector('strudel-editor')?.editor?.repl?.scheduler");
await frame().click("#stage-btn");
await film.page.evaluate(() => window.__screen.clean());
await sleep(800);
await startCapture(film);
let c = Math.floor(await now()) + 1;
await beforeDownbeat(c, 0.02);
mark(film, "start");

if (which === "build") {
  mark(film, "layer-0");
  for (let n = 1; n < FINALE_LAYERS.length; n++) {
    c += 2;
    await setDoc(codeAt(n));
    await beforeDownbeat(c);
    mark(film, `layer-${n}`);
    console.log("layer", n, await evaluate());
  }
  c += 4; // two cycles of the whole thing before the montage
  for (const name of ["tunnel", "cells", "mandala", "opart", "everything"]) {
    await setDoc(montage(SCENES[name]));
    await beforeDownbeat(c, 0.06);
    mark(film, `scene-${name}`);
    console.log("scene", name, await evaluate());
    c += name === "everything" ? 4 : 2;
  }
  await beforeDownbeat(c, 0.01);
  mark(film, "stop");
  await frame().evaluate(() => document.getElementById("play-btn").click());
  await sleep(4500);
} else {
  for (const id of ["roll", "beat", "hydra-canvas", "rings"]) {
    await film.page.evaluate((i) => window.__screen.solo(i), id);
    mark(film, `solo-${id}`);
    c += 4;
    await beforeDownbeat(c, 0.005);
  }
  await film.page.evaluate(() => window.__screen.solo(null));
}
logging = false;
mark(film, "end");
const meta = await stopCapture(film);
console.log(which, "frames", meta.frames.length, JSON.stringify(meta.audio));
console.log(film.log.filter((l) => /error/i.test(l)).slice(-8).join("\n"));
await b.close();
