// Cut v4 — "Rest", pure image and sound, ~48 s:
//   FLASH (2 s of the climax) → black →
//   VOID  "Rest" on 0.5.8's sound: white glyphs that go dark the moment the sound stops →
//   RING  the same on 0.5.13's: amber, echoing with the measured tail →
//   SOURCE the live pattern builds, one panel per layer, each credited by its code →
//   RUNTIME five shader scenes, one cycle each, cut on the downbeat →
//   OUT   Stop rings out; the rest glyph, amber, fades.
// Panels come from the solo take at the same musical phase (cycle mod 4) as the audio.
import { execFileSync } from "node:child_process";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { FF, HERE } from "./lib.mjs";

const SYNC = 0.12; // the takes were encoded with audio shifted 120 ms earlier (encode.mjs … -120)
const out = path.join(HERE, "cut4");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const CAP = path.join(HERE, "captions");
const take = (d) => path.join(HERE, "takes", d, "take.mp4");
const ff = (args) => execFileSync(FF, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
const ENC = ["-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2"];
const CRUSH = "curves=all='0/0 0.12/0 1/1'";

function load(d) {
  const m = JSON.parse(fs.readFileSync(path.join(HERE, "takes", d, "meta.json"), "utf8"));
  const t0 = m.frames[0].t;
  const marks = Object.fromEntries(m.marks.map((x) => [x.label, x.wall / 1000 - t0]));
  // Downbeats up to Stop (the clock restarts after it), in order.
  const stopWall = m.marks.find((x) => x.label === "stop")?.wall ?? Infinity;
  const cycles = m.marks.filter((x) => /^c\d+$/.test(x.label) && x.wall < stopWall).map((x) => ({ n: Number(x.label.slice(1)), t: x.wall / 1000 - t0 }));
  return { marks, cycles, t0 };
}
/** First audio onset (> −40 dBFS) in a take, on the video timeline. */
function onset(d) {
  const pcm = fs.readFileSync(path.join(HERE, "takes", d, "audio.s16le"));
  const s = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
  for (let i = 0; i < s.length; i += 2) if (Math.abs(s[i]) > 328) return i / 2 / 48000 - SYNC;
  throw new Error("no onset in " + d);
}
const build = load("screen-build"), solo = load("screen-solo");
const cyc = (tk, t) => tk.cycles.reduce((best, c) => (Math.abs(c.t - t) < Math.abs(best.t - t) ? c : best));
const P = cyc(build, build.marks["layer-0"]);
const period = (() => {
  const d = [];
  for (let i = 1; i < build.cycles.length; i++) if (build.cycles[i].n === build.cycles[i - 1].n + 1) d.push(build.cycles[i].t - build.cycles[i - 1].t);
  d.sort((a, b) => a - b);
  return d[d.length >> 1];
})();
const at = (tk, n) => { const c = tk.cycles.find((x) => x.n === n); if (!c) throw new Error("no cycle " + n); return c.t; };
/** Where in the solo take layer `id` shows the same musical phase as build cycle `n`. */
function soloAt(id, n) {
  const s0 = cyc(solo, solo.marks[`solo-${id}`]).n;
  for (let k = s0; k < s0 + 4; k++) if (((k - n) % 4 + 4) % 4 === 0) return at(solo, k);
  throw new Error("phase");
}
console.log("period", period.toFixed(3), "build layer-0 cycle", P.n);

const parts = [];
const part = (name) => { const f = path.join(out, `${String(parts.length).padStart(2, "0")}-${name}.mov`); parts.push(f); return f; };

// FLASH — two seconds of the climax, then nothing.
{
  const t = build.marks["scene-everything"] + period;
  ff(["-ss", String(t), "-t", "2.0", "-i", take("screen-build"), "-vf", CRUSH, "-af", "afade=t=out:st=1.92:d=0.08", ...ENC, part("flash")]);
  ff(["-f", "lavfi", "-t", "0.55", "-i", "color=c=black:s=1080x1920:r=30", "-f", "lavfi", "-t", "0.55", "-i", "anullsrc=r=48000:cl=stereo", ...ENC, part("black")]);
}
// VOID and RING.
for (const [d, len] of [["score-old", 6.3], ["score-new", 7.4]]) {
  const t = onset(d) - 0.3;
  ff(["-ss", String(t), "-t", String(len), "-i", take(d), "-af", "afade=t=in:d=0.02", ...ENC, part(d)]);
}
// SOURCE — one cycle per block, panels added as the layers are.
const LAYERS = ["roll", "beat", "hydra-canvas", "rings"];
const capName = { roll: "roll", beat: "beat", "hydra-canvas": "hydra", rings: "rings" };
for (let blk = 0; blk < 4; blk++) {
  const n = P.n + 2 * blk; // the build evaluates a layer every 2 cycles
  const aT = at(build, n);
  const ids = LAYERS.slice(0, blk + 1);
  const ins = [], f = [];
  ids.forEach((id, k) => { ins.push("-ss", String(soloAt(id, n)), "-t", String(period), "-i", take("screen-solo")); });
  ins.push("-ss", String(Math.max(0, aT)), "-t", String(period), "-i", take("screen-build"));
  const aIdx = ids.length;
  const small = blk === 3;
  ids.forEach((id, k) => ins.push("-i", path.join(CAP, `${capName[id]}${small ? "-sm" : ""}.png`)));
  const cap = (k) => ids.length + 1 + k;
  let layout;
  if (blk === 0) {
    f.push(`[0:v]${CRUSH}[p0]`);
    f.push(`[p0][${cap(0)}:v]overlay=40:H-h-110[v]`);
  } else if (blk === 1 || blk === 2) {
    const h = blk === 1 ? 957 : 636;
    ids.forEach((_, k) => f.push(`[${k}:v]${CRUSH},crop=1080:${h}:0:(ih-${h})/2[c${k}]`));
    ids.forEach((_, k) => f.push(`[c${k}][${cap(k)}:v]overlay=32:H-h-26[p${k}]`));
    const pads = ids.map((_, k) => `[p${k}]`).join("");
    layout = ids.map((_, k) => (k === 0 ? "0_0" : `0_${ids.slice(0, k).map(() => `${h}+6`).join("+")}`)).join("|");
    f.push(`${pads}xstack=inputs=${ids.length}:layout=${layout}:fill=black,pad=1080:1920:0:0:black[v]`);
  } else {
    ids.forEach((_, k) => f.push(`[${k}:v]${CRUSH},scale=537:957[c${k}]`));
    ids.forEach((_, k) => f.push(`[c${k}][${cap(k)}:v]overlay=18:H-h-18[p${k}]`));
    f.push(`[p0][p1][p2][p3]xstack=inputs=4:layout=0_0|543_0|0_963|543_963:fill=black,pad=1080:1920:0:0:black[v]`);
  }
  f.push(`[${aIdx}:a]anull[a]`);
  ff([...ins, "-filter_complex", f.join(";"), "-map", "[v]", "-map", "[a]", "-t", String(period), ...ENC, part(`source-${blk}`)]);
}
// Collapse: everything stacked, the cycle after the last panel.
{
  const n = P.n + 7;
  ff(["-ss", String(at(build, n)), "-t", String(period), "-i", take("screen-build"), "-vf", CRUSH, ...ENC, part("collapse")]);
}
// RUNTIME — one cycle of each scene, credited; the last scene runs on into Stop.
for (const name of ["tunnel", "cells", "mandala", "opart"]) {
  const t = build.marks[`scene-${name}`];
  ff(["-ss", String(t), "-t", String(period), "-i", take("screen-build"), "-i", path.join(CAP, `${name}.png`),
    "-filter_complex", `[0:v]${CRUSH}[b];[b][1:v]overlay=40:H-h-110[v]`, "-map", "[v]", "-map", "0:a", ...ENC, part(name)]);
}
{
  const t0 = build.marks["scene-everything"] + 2 * period;
  const stop = build.marks.stop;
  const len = stop + 2.1 - t0;
  ff(["-ss", String(t0), "-t", String(len), "-i", take("screen-build"), "-i", path.join(CAP, "everything.png"),
    "-filter_complex", `[0:v]${CRUSH}[b];[b][1:v]overlay=40:H-h-110:enable='lt(t,${period.toFixed(2)})',fade=t=out:st=${(stop - t0 + 0.2).toFixed(2)}:d=1.7[v]`,
    "-map", "[v]", "-map", "0:a", ...ENC, part("everything")]);
  // OUT — the rest glyph, amber, over the last of the tail.
  const restFrame = path.join(out, "rest.png");
  const rt = onset("score-new") + 1.05;
  ff(["-ss", String(rt), "-i", take("score-new"), "-frames:v", "1", restFrame]);
  ff(["-loop", "1", "-framerate", "30", "-t", "3.2", "-i", restFrame, "-ss", String(stop + 2.1), "-t", "3.2", "-i", take("screen-build"),
    "-filter_complex", "[0:v]fade=t=in:d=0.8,fade=t=out:st=1.9:d=1.3[v];[1:a]afade=t=out:st=2.4:d=0.8[a]", "-map", "[v]", "-map", "[a]", ...ENC, part("out")]);
}

fs.writeFileSync(path.join(out, "list.txt"), parts.map((f) => `file '${f}'`).join("\n"));
ff(["-f", "concat", "-safe", "0", "-i", path.join(out, "list.txt"), "-c", "copy", path.join(out, "joined.mov")]);
const run = spawnSync(FF, ["-hide_banner", "-i", path.join(out, "joined.mov"), "-af", "loudnorm=I=-15:TP=-1.5:LRA=14:print_format=json", "-f", "null", "-"], { encoding: "utf8" });
const m = JSON.parse(run.stderr.match(/\{[\s\S]*\}/)[0]);
const ln = `loudnorm=I=-15:TP=-1.5:LRA=14:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
const final = path.join(out, "rest-v4.mp4");
ff(["-i", path.join(out, "joined.mov"), "-af", `aformat=channel_layouts=stereo,${ln},aresample=48000,aformat=channel_layouts=stereo`, "-ac", "2",
  "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", final]);
console.log(JSON.stringify({ parts: parts.length, measured: m.input_i }), "→", final);
