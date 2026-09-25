// The score stage: "Rest" on black, 0.5.8's sound then 0.5.13's.
//   bun stage.mjs [old|new]  (default both)
import { launch, openStage, startCapture, stopCapture, sleep, top, mark, HERE } from "./lib.mjs";
import path from "node:path";
import fs from "node:fs";
const modes = process.argv[2] ? [process.argv[2]] : ["old", "new"];
const b = await launch({ gpu: true });
for (const mode of modes) {
  const outDir = path.join(HERE, "takes", `score-${mode}`);
  fs.rmSync(outDir, { recursive: true, force: true });
  const film = await openStage(b, { url: `http://localhost:5210/stage-score.html?mode=${mode}`, outDir });
  await startCapture(film);
  await sleep(800);
  mark(film, "play");
  // The stage has nothing to prove about activation: start it with a real gesture.
  await film.page.evaluate(() => window.__stage.play());
  mark(film, "done");
  await sleep(300);
  const meta = await stopCapture(film);
  console.log(mode, "frames", meta.frames.length, JSON.stringify(meta.audio));
  console.log(film.log.join("\n"));
  await film.context.close();
}
await b.close();
