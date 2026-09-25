// Cut v3 ("flash-forward"), ~80 s:
//   2 s of the climax → black → Rest bars 1–2 on 0.5.8, paused (dead air) →
//   the same on 0.5.13 (it rings) and on, through the build and the shader
//   montage, to Stop's ring-out → end card.
// Under both Rests, a waveform line drawn from the real audio (log scale, so a
// tail stays visible where 0.5.8 goes flat).
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { FF, HERE, SRC } from "./lib.mjs";

const SYNC_MS = -120; // audio trails video by 105–133 ms in the capture (sync.py)
const out = path.join(HERE, "cut");
fs.mkdirSync(out, { recursive: true });
const endcard = path.join(HERE, "endcard.png");
execFileSync("bun", [path.join(SRC, "shot.mjs"), path.join(SRC, "endcard.html"), endcard], { stdio: "inherit" });
const ff = (args) => execFileSync(FF, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
const marks = (d) => {
  const m = JSON.parse(fs.readFileSync(path.join(HERE, "takes", d, "meta.json"), "utf8"));
  const t0 = m.frames[0].t;
  return Object.fromEntries(m.marks.map((x) => [x.label, x.wall / 1000 - t0]));
};
for (const d of ["old", "new"]) execFileSync("bun", [path.join(SRC, "encode.mjs"), path.join(HERE, "takes", d), "30", String(SYNC_MS)], { stdio: "inherit" });
const mo = marks("old"), mn = marks("new");
const ENC = ["-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2"];
const take = (d) => path.join(HERE, "takes", d, "take.mp4");

/**
 * Waveform band over the bottom of the frame for the first `until` seconds:
 * cube-root scaled (a tail at −50 dB still wiggles), over a thin baseline
 * that is always drawn, so dead air reads as a flatline.
 */
const WAVE_Y = 1660, WAVE_H = 180;
const waveGraph = (until) =>
  `[0:a]afade=t=in:d=0.02,asplit[a][aw];[aw]showwaves=s=1080x${WAVE_H}:mode=cline:rate=30:scale=cbrt:colors=0xffd6a0:draw=full,format=rgba[w];` +
  `[0:v]drawbox=y=${WAVE_Y - 24}:h=${WAVE_H + 48}:w=iw:color=0x0d0c11@0.9:t=fill:enable='lt(t,${until})',` +
  `drawbox=x=60:y=${WAVE_Y + WAVE_H / 2 - 1}:w=960:h=2:color=0xffd6a0@0.55:t=fill:enable='lt(t,${until})'[vb];` +
  `[vb][w]overlay=0:${WAVE_Y}:enable='lt(t,${until})':shortest=1`;

// 0. Flash-forward: two seconds of the climax, loud, then nothing.
const f0 = mn["scene-everything"] + 2.0;
ff(["-ss", String(f0), "-t", "2.2", "-i", take("new"), "-af", "afade=t=out:st=2.12:d=0.08", ...ENC, path.join(out, "c0.mov")]);
ff(["-f", "lavfi", "-t", "0.45", "-i", "color=c=black:s=1080x1920:r=30", "-f", "lavfi", "-t", "0.45", "-i", "anullsrc=r=48000:cl=stereo", ...ENC, path.join(out, "c1.mov")]);
// 1. 0.5.8: Rest bars 1–2, paused — the chord drops into digital silence.
const a0 = mo["tap-rest"] - 0.35, a1 = mo["pause-rest"] + 1.35;
ff(["-ss", String(a0), "-to", String(a1), "-i", take("old"), "-filter_complex", `${waveGraph(99)}[v]`, "-map", "[v]", "-map", "[a]", ...ENC, path.join(out, "c2.mov")]);
// 2. 0.5.13: the same, ringing out — and on through the build and the montage.
const b0 = mn["tap-rest"] - 0.35, b1 = mn.stop + 4.0;
const waveUntil = mn.scroll + 0.6 - b0;
const fadeAt = mn.stop + 1.4 - b0;
ff(["-ss", String(b0), "-to", String(b1), "-i", take("new"),
  "-filter_complex", `${waveGraph(waveUntil)},fade=t=out:st=${fadeAt.toFixed(2)}:d=2.4[v];[a]afade=t=out:st=${(b1 - b0 - 0.9).toFixed(2)}:d=0.9[ao]`,
  "-map", "[v]", "-map", "[ao]", ...ENC, path.join(out, "c3.mov")]);
// 3. End card.
ff(["-loop", "1", "-framerate", "30", "-t", "4", "-i", endcard, "-f", "lavfi", "-t", "4", "-i", "anullsrc=r=48000:cl=stereo",
  "-vf", "fade=t=in:d=0.8,fade=t=out:st=3.3:d=0.7", "-shortest", ...ENC, path.join(out, "c4.mov")]);

const parts = ["c0.mov", "c1.mov", "c2.mov", "c3.mov", "c4.mov"];
fs.writeFileSync(path.join(out, "list.txt"), parts.map((f) => `file '${path.join(out, f)}'`).join("\n"));
ff(["-f", "concat", "-safe", "0", "-i", path.join(out, "list.txt"), "-c", "copy", path.join(out, "joined.mov")]);
const run = spawnSync(FF, ["-hide_banner", "-i", path.join(out, "joined.mov"), "-af", "loudnorm=I=-16:TP=-1.5:LRA=14:print_format=json", "-f", "null", "-"], { encoding: "utf8" });
const m = JSON.parse(run.stderr.match(/\{[\s\S]*\}/)[0]);
const ln = `loudnorm=I=-16:TP=-1.5:LRA=14:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
const final = path.join(out, "mcp-music-studio-0.5.13-rest-v3.mp4");
ff(["-i", path.join(out, "joined.mov"), "-af", `aformat=channel_layouts=stereo,${ln},aresample=48000,aformat=channel_layouts=stereo`, "-ac", "2",
  "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", final]);
console.log(JSON.stringify({ measured: m.input_i, tp: m.input_tp, old: +(a1 - a0).toFixed(2), new: +(b1 - b0).toFixed(2) }), "→", final);
