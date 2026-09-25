// Cut v1: 0.5.8 "Rest" → hard cut → 0.5.13 take to the stop's ring-out → end card. Loudness-normalised.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { FF, HERE, SRC } from "./lib.mjs";
const SYNC_MS = -120; // audio trails video by 105–133 ms in the capture (measured on the score highlight, sync.py)
const out = path.join(HERE, "cut");
const endcard = path.join(HERE, "endcard.png");
execFileSync("bun", [path.join(SRC, "shot.mjs"), path.join(SRC, "endcard.html"), endcard], { stdio: "inherit" });
fs.mkdirSync(out, { recursive: true });
const ff = (args) => execFileSync(FF, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
const marks = (d) => {
  const m = JSON.parse(fs.readFileSync(path.join(HERE, "takes", d, "meta.json"), "utf8"));
  const t0 = m.frames[0].t;
  return Object.fromEntries(m.marks.map((x) => [x.label, x.wall / 1000 - t0]));
};
for (const d of ["old", "new"]) execFileSync("bun", [path.join(SRC, "encode.mjs"), path.join(HERE, "takes", d), "30", String(SYNC_MS)], { stdio: "inherit" });
const mo = marks("old"), mn = marks("new");
const ENC = ["-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2"];

// 1. 0.5.8 — Rest, then 1.4 s of dead air.
// Cut 1.4 s after the old take's last sound: dead air, then the new version.
const pcm = fs.readFileSync(path.join(HERE, "takes/old/audio.s16le"));
const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
let last = 0;
for (let i = 0; i < samples.length; i += 2) if (Math.abs(samples[i]) > 33) last = i / 2; // > −60 dBFS
const a0 = 1.0, a1 = Number(process.env.OLD_END ?? (last / 48000 + 1.4 + SYNC_MS / 1000));
ff(["-ss", String(a0), "-to", String(a1), "-i", path.join(HERE, "takes/old/take.mp4"),
  "-vf", "fade=t=in:d=0.35", ...ENC, path.join(out, "s1.mov")]);
// 2. 0.5.13 — the same moment, through the build, to the ring-out after Stop.
const b0 = 1.0, b1 = mn.stop + 3.4, fadeAt = mn.stop + 0.9 - b0;
ff(["-ss", String(b0), "-to", String(b1), "-i", path.join(HERE, "takes/new/take.mp4"),
  "-vf", `fade=t=out:st=${fadeAt.toFixed(2)}:d=2.4`, "-af", `afade=t=out:st=${(b1 - b0 - 0.8).toFixed(2)}:d=0.8`, ...ENC, path.join(out, "s2.mov")]);
// 3. End card.
ff(["-loop", "1", "-framerate", "30", "-t", "4.5", "-i", endcard, "-f", "lavfi", "-t", "4.5", "-i", "anullsrc=r=48000:cl=stereo",
  "-vf", "fade=t=in:d=0.9,fade=t=out:st=3.7:d=0.8", "-shortest", ...ENC, path.join(out, "s3.mov")]);

fs.writeFileSync(path.join(out, "list.txt"), ["s1.mov", "s2.mov", "s3.mov"].map((f) => `file '${path.join(out, f)}'`).join("\n"));
ff(["-f", "concat", "-safe", "0", "-i", path.join(out, "list.txt"), "-c", "copy", path.join(out, "joined.mov")]);
// Two-pass loudnorm to -16 LUFS / -1.5 dBTP (linear, no pumping).
const run = spawnSync(FF, ["-hide_banner", "-i", path.join(out, "joined.mov"), "-af", "loudnorm=I=-16:TP=-1.5:LRA=14:print_format=json", "-f", "null", "-"], { encoding: "utf8" });
const m = JSON.parse(run.stderr.match(/\{[\s\S]*\}/)[0]);
const ln = `loudnorm=I=-16:TP=-1.5:LRA=14:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
const final = path.join(out, "mcp-music-studio-0.5.13-rest.mp4");
ff(["-i", path.join(out, "joined.mov"), "-af", `aformat=channel_layouts=stereo,${ln},aresample=48000,aformat=channel_layouts=stereo`, "-ac", "2", "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", final]);
console.log(JSON.stringify({ oldLastSound: (last / 48000).toFixed(2), measured: m.input_i, tp: m.input_tp, s1: a1 - a0, s2: b1 - b0 }), "→", final);
