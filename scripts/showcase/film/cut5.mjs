// Cut v5 — "Rest", the piece. Pure image and sound (+ code credits), 60 fps.
//
//   FLASH  one bar of the climax, then black
//   VOID   Rest bars 1–2 on 0.5.8's sound (stage-score, white)
//   RING   the same on 0.5.13's (amber); its last note rings into bar 0 of…
//   SONG   one continuous performance (song-full's audio), picture cut across
//          six cameras shot on the same clock: code, full, roll, beat, hydra,
//          rings — panels, the code itself, and a REST glyph on the silent beat
//   OUT    the tail rings out over the rest glyph
//
// At 144 bpm one bar is exactly 100 frames at 60 fps: every cut is on a frame.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { FF, HERE } from "./lib.mjs";

const FPS = 60, BAR = 1 / 0.6, SYNC = 0.12;
const out = path.join(HERE, "cut5");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "clips"), { recursive: true });
const CAP = path.join(HERE, "captions");
const take = (d) => path.join(HERE, "takes", d, "take.mp4");
const ff = (args) => execFileSync(FF, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
const VENC = ["-an", "-c:v", "libx264", "-preset", "slow", "-crf", "15", "-pix_fmt", "yuv420p", "-r", String(FPS)];
const CRUSH = "curves=all='0/0 0.12/0 1/1'";
const CRUSH_CODE = "curves=all='0/0 0.06/0 1/1'";

function marks(d) {
  const m = JSON.parse(fs.readFileSync(path.join(HERE, "takes", d, "meta.json"), "utf8"));
  const t0 = m.frames[0].t;
  return Object.fromEntries(m.marks.map((x) => [x.label, x.wall / 1000 - t0]));
}
function onset(d) {
  const pcm = fs.readFileSync(path.join(HERE, "takes", d, "audio.s16le"));
  const s = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
  for (let i = 0; i < s.length; i += 2) if (Math.abs(s[i]) > 328) return i / 2 / 48000 - SYNC;
  throw new Error("no onset in " + d);
}
const CAMS = ["full", "code", "roll", "beat", "hydra", "rings"];
const bar0 = Object.fromEntries(CAMS.map((c) => [c, marks(`song-${c}`)["bar-0"]]));
const T = (cam, bar) => bar0[cam] + bar * BAR;

// ---- the song's picture: an edit decision list in bars --------------------------
const one = (cam, len, credit) => ({ kind: "cam", cam, len, credit });
const grid = (cams, len, credits) => ({ kind: "grid", cams, len, credits });
const EDL = [
  one("code", 2),
  one("full", 2, "roll"),
  grid(["roll", "beat"], 1, ["roll", "halftime"]),
  one("code", 1),
  grid(["beat", "rings"], 2, ["halftime", "rings"]),
  one("full", 1, "hydra"),
  grid(["roll", "beat", "hydra"], 1, ["roll", "halftime", "hydra"]),
  grid(["roll", "beat", "hydra", "rings"], 2, ["roll", "beat", "hydra", "rings"]),
  one("code", 1),
  one("full", 1, "arp"),
  one("full", 0.5, "riser"), one("code", 0.5),
  one("hydra", 0.25), one("code", 0.25), one("rings", 0.125), one("full", 0.125),
  { kind: "rest", len: 0.25, credit: "rest" },
  one("full", 1, "drop"),
  one("code", 0.5), grid(["roll", "beat", "hydra", "rings"], 0.5, [null, null, null, null]),
  one("full", 1, "mandala"),
  one("code", 0.5), one("full", 0.5),
  one("hydra", 1, "opart"),
  one("full", 0.5), one("code", 0.25), one("hydra", 0.25),
  one("full", 1, "everything"),
  one("code", 0.5), grid(["roll", "beat", "hydra", "rings"], 0.5, [null, null, null, null]),
  one("rings", 1, "rings"),
  one("code", 1),
  one("full", 2, "tunnel"),
  one("full", 1, "last"),
  { kind: "cam", cam: "full", len: 0.7, fade: true },
];
const total = EDL.reduce((s, e) => s + e.len, 0);
if (Math.abs(total - 29.7) > 1e-9) throw new Error(`EDL is ${total} bars, want 29.7`);

let clipN = 0;
const clips = [];
function clip(args, frames, name) {
  const f = path.join(out, "clips", `${String(clipN++).padStart(3, "0")}-${name}.mp4`);
  ff([...args, "-frames:v", String(frames), ...VENC, f]);
  clips.push({ f, frames });
}
const capIn = (name, small) => ["-i", path.join(CAP, `${name}${small ? "-sm" : ""}.png`)];
const restPng = path.join(out, "rest.png");
ff(["-ss", String(onset("score-new") + 1.05), "-i", take("score-new"), "-frames:v", "1", restPng]);

// Frames per segment from cumulative positions, so eighth-bar cuts can't drift.
let at = 0;
for (const e of EDL) {
  const f0 = Math.round(at * 100), f1 = Math.round((at + e.len) * 100);
  const frames = f1 - f0, bar = at;
  at += e.len;
  if (e.kind === "cam") {
    const crush = e.cam === "code" ? CRUSH_CODE : CRUSH;
    const fade = e.fade ? `,fade=t=out:st=0:d=${(frames / FPS).toFixed(3)}` : "";
    if (e.credit) {
      clip(["-ss", String(T(e.cam, bar)), "-i", take(`song-${e.cam}`), ...capIn(e.credit),
        "-filter_complex", `[0:v]${crush}[b];[b][1:v]overlay=40:H-h-110${fade}`], frames, `${e.cam}-${e.credit}`);
    } else {
      clip(["-ss", String(T(e.cam, bar)), "-i", take(`song-${e.cam}`), "-vf", `${crush}${fade}`], frames, e.cam);
    }
  } else if (e.kind === "rest") {
    clip(["-loop", "1", "-framerate", String(FPS), "-i", restPng, ...capIn(e.credit),
      "-filter_complex", `[0:v][1:v]overlay=40:H-h-110`], frames, "rest");
  } else {
    const n = e.cams.length;
    const ins = e.cams.flatMap((c) => ["-ss", String(T(c, bar)), "-i", take(`song-${c}`)]);
    const caps = e.credits.map((c) => (c ? capIn(c, n === 4) : ["-f", "lavfi", "-i", "color=c=black@0:s=2x2,format=rgba"])).flat();
    const f = [];
    if (n === 4) {
      e.cams.forEach((_, k) => f.push(`[${k}:v]${CRUSH},scale=537:957[c${k}]`));
      e.cams.forEach((_, k) => f.push(`[c${k}][${n + k}:v]overlay=18:H-h-18[p${k}]`));
      f.push(`[p0][p1][p2][p3]xstack=inputs=4:layout=0_0|543_0|0_963|543_963:fill=black,pad=1080:1920:0:0:black`);
    } else {
      const h = n === 2 ? 957 : 636;
      e.cams.forEach((_, k) => f.push(`[${k}:v]${CRUSH},crop=1080:${h}:0:(ih-${h})/2[c${k}]`));
      e.cams.forEach((_, k) => f.push(`[c${k}][${n + k}:v]overlay=32:H-h-26[p${k}]`));
      const layout = e.cams.map((_, k) => `0_${k * (h + 6)}`).join("|");
      f.push(`${e.cams.map((_, k) => `[p${k}]`).join("")}xstack=inputs=${n}:layout=${layout}:fill=black,pad=1080:1920:0:0:black`);
    }
    clip([...ins, ...caps, "-filter_complex", f.join(";")], frames, `grid${n}`);
  }
}
const songFrames = clips.reduce((s, c) => s + c.frames, 0);

// ---- intro: flash, black, VOID, RING -------------------------------------------
const introClips = [];
function iclip(args, frames, name) {
  const f = path.join(out, "clips", `i${introClips.length}-${name}.mp4`);
  ff([...args, "-frames:v", String(frames), ...VENC, f]);
  introClips.push({ f, frames });
}
iclip(["-ss", String(T("full", 22)), "-i", take("song-full"), "-vf", CRUSH], 100, "flash");
iclip(["-f", "lavfi", "-i", `color=c=black:s=1080x1920:r=${FPS}`], 27, "black");
const oOld = onset("score-old"), oNew = onset("score-new");
const VOID_S = 6.3, RING_S = 5.3; // the song's bar 0 falls where Rest's bar 3 would (5.0 s after its first note)
iclip(["-ss", String(oOld - 0.3), "-i", take("score-old")], Math.round(VOID_S * FPS), "void");
iclip(["-ss", String(oNew - 0.3), "-i", take("score-new")], Math.round(RING_S * FPS), "ring");
// OUT: the rest glyph over the last of the tail.
const OUT_S = 3.0;
const outClip = path.join(out, "clips", "z-out.mp4");
ff(["-loop", "1", "-framerate", String(FPS), "-i", restPng, "-vf", `fade=t=in:d=0.7,fade=t=out:st=${OUT_S - 1.3}:d=1.3`, "-frames:v", String(OUT_S * FPS), ...VENC, outClip]);

const all = [...introClips, ...clips, { f: outClip, frames: OUT_S * FPS }];
fs.writeFileSync(path.join(out, "list.txt"), all.map((c) => `file '${c.f}'`).join("\n"));
ff(["-f", "concat", "-safe", "0", "-i", path.join(out, "list.txt"), "-c", "copy", path.join(out, "video.mp4")]);

// ---- audio: one timeline -------------------------------------------------------
const sec = (frames) => frames / FPS;
const tFlash = 0, tVoid = sec(100 + 27), tRing = tVoid + VOID_S, tSong = tRing + RING_S;
const totalS = sec(all.reduce((s, c) => s + c.frames, 0));
const songLen = sec(songFrames) + OUT_S;
const A = [
  { src: take("song-full"), from: T("full", 22), len: BAR, at: tFlash, fadeOut: 0.06 },
  { src: take("score-old"), from: oOld - 0.3, len: VOID_S, at: tVoid },
  { src: take("score-new"), from: oNew - 0.3, len: 7.6, at: tRing },
  { src: take("song-full"), from: T("full", 0) - 0.02, len: songLen, at: tSong - 0.02, fadeOut: 1.2 },
];
const ins = A.flatMap((a) => ["-ss", String(a.from), "-t", String(a.len), "-i", a.src]);
const graph = A.map((a, k) => `[${k}:a]aformat=channel_layouts=stereo,aresample=48000${a.fadeOut ? `,afade=t=out:st=${(a.len - a.fadeOut).toFixed(3)}:d=${a.fadeOut}` : ""},adelay=${Math.round(a.at * 1000)}|${Math.round(a.at * 1000)}[a${k}]`);
graph.push(`${A.map((_, k) => `[a${k}]`).join("")}amix=inputs=${A.length}:normalize=0:duration=longest,atrim=0:${totalS.toFixed(3)}[mix]`);
ff([...ins, "-filter_complex", graph.join(";"), "-map", "[mix]", "-c:a", "pcm_s16le", path.join(out, "audio.wav")]);
const run = spawnSync(FF, ["-hide_banner", "-i", path.join(out, "audio.wav"), "-af", "loudnorm=I=-14:TP=-1.2:LRA=16:print_format=json", "-f", "null", "-"], { encoding: "utf8" });
const m = JSON.parse(run.stderr.match(/\{[\s\S]*\}/)[0]);
const ln = `loudnorm=I=-14:TP=-1.2:LRA=16:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
const final = path.join(out, "rest-v5.mp4");
ff(["-i", path.join(out, "video.mp4"), "-i", path.join(out, "audio.wav"), "-af", `aformat=channel_layouts=stereo,${ln},aresample=48000,aformat=channel_layouts=stereo`, "-ac", "2",
  "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-shortest", "-movflags", "+faststart", final]);
console.log(JSON.stringify({ seconds: +totalS.toFixed(2), songBars: total, clips: all.length, measured: m.input_i }), "→", final);
