// Encode one take: timestamped screencast frames + wall-clock audio → mp4 (CFR).
// usage: bun encode.mjs <takeDir> [fps=30] [audioOffsetMs=0]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { FF } from "./lib.mjs";

const dir = path.resolve(process.argv[2]);
const fps = Number(process.argv[3] ?? 30);
const offMs = Number(process.argv[4] ?? 0);
const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
const lines = [];
for (let i = 0; i < meta.frames.length; i++) {
  const f = meta.frames[i];
  const next = meta.frames[i + 1];
  const d = next ? Math.max(0.001, next.t - f.t) : 1 / fps;
  lines.push(`file '${path.join(dir, "frames", f.file)}'`, `duration ${d.toFixed(6)}`);
}
lines.push(`file '${path.join(dir, "frames", meta.frames.at(-1).file)}'`);
fs.writeFileSync(path.join(dir, "frames.txt"), lines.join("\n"));
const out = path.join(dir, "take.mp4");
const aoff = offMs >= 0 ? ["-itsoffset", String(offMs / 1000)] : [];
execFileSync(FF, [
  "-hide_banner", "-loglevel", "error", "-y",
  "-f", "concat", "-safe", "0", "-i", path.join(dir, "frames.txt"),
  ...aoff, "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", path.join(dir, "audio.s16le"),
  "-vf", `fps=${fps},scale=1080:1920:flags=lanczos,format=yuv420p`,
  ...(offMs < 0 ? ["-af", `atrim=start=${-offMs / 1000},asetpts=PTS-STARTPTS`] : []),
  "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-c:a", "aac", "-b:a", "256k",
  "-shortest", "-movflags", "+faststart", out,
], { stdio: "inherit" });
const dur = meta.frames.at(-1).t - meta.frames[0].t;
console.log(out, `${meta.frames.length} frames over ${dur.toFixed(1)} s = ${(meta.frames.length / dur).toFixed(1)} fps captured`);
