// Shader lab: the finale widget in fullscreen stage, cycling through SCENES
// (or the ones named on the command line), 3 frames of each in a contact sheet.
import { launch, openFilm, startCapture, stopCapture, tap, boxIn, sleep, top, inWidget, evaluateIn, status, mark, HERE, SRC } from "./lib.mjs";
import { montage, SCENES } from "../../../dev/film-score.ts";
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENES);
const outDir = path.join(HERE, "takes", "lab");
fs.rmSync(outDir, { recursive: true, force: true });
const b = await launch({ gpu: true });
const film = await openFilm(b, { outDir });
await top(film, "window.__film.sendAll()");
await sleep(3000);
const r4 = await top(film, "window.__film.rect(4)");
await top(film, `window.__film.phone.scrollBy(0, ${(r4.y - 150) / (1080 / 390)})`);
await sleep(500);
const setDoc = (code) => inWidget(film, 4, `(() => { const v = document.querySelector('strudel-editor').editor.editor; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: ${JSON.stringify(code)} } }); })()`);
await setDoc(montage(SCENES[names[0]]));
const p = await boxIn(film, 4, "#play-btn");
await tap(film, p.cx, p.cy);
await sleep(1500);
await evaluateIn(film, 4);
const fsb = await boxIn(film, 4, "#fullscreen-btn"); await tap(film, fsb.cx, fsb.cy); await sleep(900);
const st = await boxIn(film, 4, "#stage-btn"); await tap(film, st.cx, st.cy); await sleep(800);
await startCapture(film);
for (const n of names) {
  await setDoc(montage(SCENES[n]));
  console.log(n, await evaluateIn(film, 4), await status(film, 4));
  mark(film, n);
  await sleep(5000);
}
await stopCapture(film);
console.log(film.log.filter((l) => /error|Error/.test(l)).slice(-8).join("\n"));
await b.close();
execFileSync("bun", [path.join(SRC, "encode.mjs"), outDir, "30", "0"], { stdio: "inherit" });
execFileSync("bun", [path.join(SRC, "sheet.mjs"), outDir, ...names.flatMap((n) => [`${n}+1.2`, `${n}+3.2`, `${n}+4.7`])], { stdio: "inherit" });
