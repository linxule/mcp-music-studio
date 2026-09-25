// Perform "Rest" (dev/film-song.ts) once per camera. The arrangement is in the
// code's masks, so each take is the same song to the sample from bar 0 (the
// scheduler restarts at cycle 0); only the shader is swapped, on its cue. The
// edit cuts between takes over ONE continuous audio take.
//   bun song.mjs <code|full|roll|beat|hydra|rings>
// Marks: `bar-<n>` downbeats, one per shader cue, `stop`.
import { launch, openStage, startCapture, stopCapture, sleep, inWidget, waitInWidget, mark, HERE } from "./lib.mjs";
import { SCENE_CUES, STOP_AT, withShader } from "../../../dev/film-song.ts";
import path from "node:path";
import fs from "node:fs";

const cam = process.argv[2] ?? "full";
const SOLO = { roll: "roll", beat: "beat", hydra: "hydra-canvas", rings: "rings" };
const outDir = path.join(HERE, "takes", `song-${cam}`);
fs.rmSync(outDir, { recursive: true, force: true });
const b = await launch({ gpu: true });
const film = await openStage(b, { url: "http://localhost:5210/stage-strudel.html", outDir, captureTop: false });
const frame = () => film.page.frames().find((f) => f.url().includes("/widgets/strudel-app.html"));
const W = "document.querySelector('strudel-editor').editor";
const now = () => inWidget(film, 0, `${W}.repl.scheduler.now()`);

let code = withShader("black");
await film.page.evaluate((c) => window.__screen.send(c), code);
await sleep(2500);
const statusText = () => frame().evaluate(() => document.getElementById("status").textContent);
if (!/playing/i.test(await statusText())) await frame().click("#play-btn");
await waitInWidget(film, 0, `!!${W}?.repl?.scheduler`);
await film.page.evaluate(() => window.__screen.clean());
if (cam === "code") {
  await frame().evaluate(() => {
    const st = document.createElement("style");
    st.textContent = `.cm-editor, .cm-content, .cm-gutters { font-size: 25px !important; line-height: 1.42 !important; }
      .cm-gutters { display: none !important; } .cm-content { padding: 40px 34px !important; }`;
    document.head.appendChild(st);
  });
} else {
  await frame().evaluate(() => document.getElementById("stage-btn").click());
  if (SOLO[cam]) await film.page.evaluate((i) => window.__screen.solo(i), SOLO[cam]);
}
await sleep(600);

/** Replace only the lines that differ, and bring them into view with the caret. */
const edit = (next) => inWidget(film, 0, `(() => {
  const view = ${W}.editor, before = view.state.doc.toString(), after = ${JSON.stringify(next)};
  const a = before.split("\\n"), c = after.split("\\n");
  let i = 0; while (i < a.length && i < c.length && a[i] === c[i]) i++;
  let j = 0; while (j < a.length - i && j < c.length - i && a[a.length - 1 - j] === c[c.length - 1 - j]) j++;
  const from = a.slice(0, i).join("\\n").length + (i ? 1 : 0);
  const to = before.length - (j ? a.slice(a.length - j).join("\\n").length + 1 : 0);
  const insert = c.slice(i, c.length - j).join("\\n");
  view.dispatch({ changes: { from, to: Math.max(from, to), insert }, selection: { anchor: from }, scrollIntoView: true });
})()`);
const evaluate = () => inWidget(film, 0, `${W}.evaluate(true).then(() => 'ok')`);
async function until(c, lead) { for (let k = 0; k < 5000; k++) { if ((await now()) >= c - lead) return; await sleep(5); } }

// Downbeat logger (bar n = cycle n: the song starts at cycle 0).
let logging = true;
(async () => {
  let last = -1;
  while (logging) {
    const t = await now().catch(() => null);
    if (typeof t === "number") {
      const c = Math.floor(t);
      if (c !== last && c > last) {
        film.marks ??= [];
        film.marks.push({ label: `bar-${c}`, wall: Date.now() - (t - c) * (1000 / 0.6) });
      }
      last = c;
    }
    await sleep(15);
  }
})();

// Stop the warm-up, then start the song from cycle 0 with the camera rolling.
await frame().evaluate(() => document.getElementById("play-btn").click());
await sleep(900);
await startCapture(film);
await sleep(700);
mark(film, "go");
console.log("start:", await evaluate(), "now", (await now()).toFixed(3));
for (const cue of SCENE_CUES.slice(1)) {
  const next = withShader(cue.shader);
  await until(cue.at, 0.3);
  await edit(next);
  code = next;
  await until(cue.at, 0.06);
  const r = await evaluate();
  mark(film, `scene-${cue.shader}@${cue.at}`);
  console.log(`bar ${cue.at} ${cue.shader}: ${r}`);
}
await until(STOP_AT, 0);
mark(film, "stop");
await frame().evaluate(() => document.getElementById("play-btn").click());
await sleep(4800);
logging = false;
mark(film, "end");
const meta = await stopCapture(film);
console.log(cam, "frames", meta.frames.length, JSON.stringify(meta.audio));
console.log(film.log.filter((l) => /error/i.test(l)).slice(-6).join("\n"));
await b.close();
