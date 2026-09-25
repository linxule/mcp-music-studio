// One take of the film. `bun take.mjs old` (the published 0.5.8 widgets) or
// `bun take.mjs new` (dist/). Same conversation, same gestures, same clock —
// so the two takes can be cut against each other beat for beat.
import { launch, openFilm, startCapture, stopCapture, tap, pan, boxIn, sleep, top, inWidget, typeInto, evaluateIn, status, mark, HERE } from "./lib.mjs";
import { FINALE_LAYERS } from "../../../dev/film-score.ts";
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
const statuses = async () => { const out = []; for (let i = 0; i < 5; i++) out.push(await status(film, i)); return out.join(" | "); };
console.log("parked:", await statuses());

await startCapture(film);
mark(film, "start");
await sleep(1500);
const p0 = await boxIn(film, 0, ".abcjs-midi-start");
mark(film, "tap-rest");
await tap(film, p0.cx, p0.cy);
// The last chord (bar 5) starts ~10.3 s after the tap and rings to ~13.3 s.
await sleep(old ? 15300 : 12600);

if (!old) {
  // Thumb flicks down to the last widget while Rest's final chord rings out —
  // no dead air between the two pieces.
  mark(film, "scroll");
  const rect = (i) => top(film, `window.__film.rect(${i})`);
  for (let k = 0; k < 6; k++) {
    const left = (await rect(4)).y - 150;
    if (left < 40) break;
    const dy = -Math.min(left, 1560);
    await pan(film, 520 + (k % 2) * 90, 1760, dy, 330);
    await sleep(140);
  }
  // Tap Play just before a cycle boundary, so the first chord lands on the beat.
  const phase = () => inWidget(film, 4, "(() => { const s = document.querySelector('strudel-editor').editor.repl.scheduler; const n = s.now(); return n - Math.floor(n); })()");
  for (let k = 0; k < 200; k++) { const f = await phase(); if (f > 0.9 && f < 0.96) break; await sleep(15); }
  const p4 = await boxIn(film, 4, "#play-btn");
  mark(film, "tap-play-4");
  await tap(film, p4.cx, p4.cy);
  await sleep(6500);
  const speeds = [30, 45, 60, 110];
  for (const [n, layer] of FINALE_LAYERS.entries()) {
    mark(film, `type-${n}`);
    await typeInto(film, 4, layer, speeds[n]);
    await sleep(350);
    mark(film, `eval-${n}`);
    console.log("layer", n, await evaluateIn(film, 4), "→", await status(film, 4));
    await sleep([6200, 6200, 8200, 9000][n]);
  }
  const fsb = await boxIn(film, 4, "#fullscreen-btn");
  mark(film, "fullscreen");
  await tap(film, fsb.cx, fsb.cy);
  await sleep(1600);
  const st = await boxIn(film, 4, "#stage-btn");
  mark(film, "stage");
  await tap(film, st.cx, st.cy);
  await sleep(14000);
  const pl = await boxIn(film, 4, "#play-btn");
  mark(film, "stop");
  await tap(film, pl.cx, pl.cy);
  await sleep(5000);
}
mark(film, "end");
const meta = await stopCapture(film);
console.log("frames", meta.frames.length, "audio", JSON.stringify(meta.audio));
console.log(film.log.filter((l) => /error|pageerror/i.test(l)).slice(-12).join("\n"));
await b.close();
