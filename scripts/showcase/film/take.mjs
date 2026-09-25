// One take of the film (v3). `bun take.mjs old` (the published 0.5.8 widgets)
// or `bun take.mjs new` (dist/). Same conversation, same gestures, same clock —
// so the two takes can be cut against each other beat for beat.
//
//   Rest, bars 1–2 → pause (0.5.8 stops dead; 0.5.13 rings out)
//   flick down → tap Play on the downbeat → type four layers, ~4 s apart
//   ⛶ + Stage → five shader scenes, swapped on the downbeat → Stop, ring-out
import { launch, openFilm, startCapture, stopCapture, tap, pan, boxIn, sleep, top, inWidget, typeInto, evaluateIn, status, mark, HERE } from "./lib.mjs";
import { FINALE_LAYERS, SCENES, montage } from "../../../dev/film-score.ts";
import path from "node:path";
import fs from "node:fs";

const old = process.argv[2] === "old";
const label = old ? "0.5.8" : (process.argv[3] ?? "0.5.13");
const outDir = path.join(HERE, "takes", old ? "old" : "new");
fs.rmSync(outDir, { recursive: true, force: true });
const b = await launch({ gpu: true });
const film = await openFilm(b, { old, outDir, query: `&label=${label}` });
await top(film, "window.__film.sendAll()");
await sleep(6000);

await startCapture(film);
mark(film, "start");
await sleep(1500);
const p0 = await boxIn(film, 0, ".abcjs-midi-start");
mark(film, "tap-rest");
await tap(film, p0.cx, p0.cy);
// Sound starts ~0.26 s after the tap; bar 3's chord lands 5.0 s after that.
await sleep(5150);
mark(film, "pause-rest");
await tap(film, p0.cx, p0.cy);

if (old) {
  await sleep(2500);
} else {
  await sleep(650);
  mark(film, "scroll");
  const rect = (i) => top(film, `window.__film.rect(${i})`);
  for (let k = 0; k < 6; k++) {
    const left = (await rect(4)).y - 150;
    if (left < 40) break;
    await pan(film, 520 + (k % 2) * 90, 1760, -Math.min(left, 1560), 300);
    await sleep(120);
  }
  // The scheduler's clock, in cycles (1 cycle = 2 s here).
  const now = () => inWidget(film, 4, "document.querySelector('strudel-editor').editor.repl.scheduler.now()");
  /** Resolve just before the downbeat of cycle `c` (default: the next one). */
  const beforeDownbeat = async (c, lead = 0.05) => {
    const target = c ?? Math.floor(await now()) + 1;
    for (let k = 0; k < 2000; k++) { if ((await now()) >= target - lead) return target; await sleep(8); }
    return target;
  };
  await beforeDownbeat(undefined, 0.07);
  const p4 = await boxIn(film, 4, "#play-btn");
  mark(film, "tap-play-4");
  await tap(film, p4.cx, p4.cy);
  await sleep(1800);

  const speeds = [70, 80, 110, 240];
  for (const [n, layer] of FINALE_LAYERS.entries()) {
    mark(film, `type-${n}`);
    await typeInto(film, 4, layer, speeds[n]);
    // Land each layer on a downbeat.
    await beforeDownbeat(undefined, 0.04);
    mark(film, `eval-${n}`);
    console.log("layer", n, await evaluateIn(film, 4), "→", await status(film, 4));
    await sleep(n === FINALE_LAYERS.length - 1 ? 3600 : 2600);
  }
  const fsb = await boxIn(film, 4, "#fullscreen-btn");
  mark(film, "fullscreen");
  await tap(film, fsb.cx, fsb.cy);
  await sleep(700);
  const st = await boxIn(film, 4, "#stage-btn");
  mark(film, "stage");
  await tap(film, st.cx, st.cy);

  // The montage: the whole buffer swapped for each scene, evaluated just before a downbeat, 2 cycles each.
  const setDoc = (code) => inWidget(film, 4, `(() => { const v = document.querySelector('strudel-editor').editor.editor; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: ${JSON.stringify(code)} } }); })()`);
  let at = Math.floor(await now()) + 1;
  for (const name of ["tunnel", "cells", "mandala", "opart", "everything"]) {
    await setDoc(montage(SCENES[name]));
    await beforeDownbeat(at, 0.06);
    mark(film, `scene-${name}`);
    console.log("scene", name, await evaluateIn(film, 4));
    at += name === "everything" ? 4 : 2;
  }
  await beforeDownbeat(at, 0.02);
  const pl = await boxIn(film, 4, "#play-btn");
  mark(film, "stop");
  await tap(film, pl.cx, pl.cy);
  await sleep(4500);
}
mark(film, "end");
const meta = await stopCapture(film);
console.log("frames", meta.frames.length, "audio", JSON.stringify(meta.audio));
console.log(film.log.filter((l) => /error|pageerror/i.test(l)).slice(-12).join("\n"));
await b.close();
