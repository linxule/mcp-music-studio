import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const FF = '/tmp/ms-showcase/ffm/node_modules/ffmpeg-static/ffmpeg';
const OUT = '/tmp/ms-showcase/out';
const manifest = JSON.parse(fs.readFileSync('/tmp/ms-showcase/manifest.json', 'utf8'));
const CARD_SECS = 2.8;
const ENC = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-r', '25',
  '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart'];

const ff = args => execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });

const parts = [];
function card(name) {
  const png = `/tmp/ms-showcase/cards/${name}.png`;
  if (!fs.existsSync(png)) return;
  const out = `${OUT}/card-${name}.mp4`;
  ff(['-loop', '1', '-framerate', '25', '-t', String(CARD_SECS), '-i', png,
    '-f', 'lavfi', '-t', String(CARD_SECS), '-i', 'anullsrc=r=48000:cl=stereo',
    '-vf', `fade=t=in:d=0.35,fade=t=out:st=${CARD_SECS - 0.4}:d=0.4,format=yuv420p`,
    '-shortest', ...ENC, out]);
  parts.push(out);
}

card('00-intro');
for (const m of manifest) {
  if (m.card) card(m.id);
  const S = Math.max(0, m.start), E = m.end - 0.2, D = E - S;
  const out = `${OUT}/scene-${m.id}.mp4`;
  const offMs = Math.round((m.audioOffset ?? 0) * 1000);
  const vf = `[0:v]trim=start=${S}:end=${E},setpts=PTS-STARTPTS,fps=25,fade=t=in:d=0.3,fade=t=out:st=${D - 0.45}:d=0.45,format=yuv420p[v]`;
  const af = m.audio
    ? `[1:a]aresample=48000,adelay=${offMs}|${offMs},atrim=start=${S}:end=${E},asetpts=PTS-STARTPTS,afade=t=in:d=0.25,afade=t=out:st=${D - 0.6}:d=0.6[a]`
    : `anullsrc=r=48000:cl=stereo,atrim=end=${D}[a]`;
  const inputs = m.audio ? ['-i', m.video, '-i', m.audio] : ['-i', m.video];
  ff([...inputs, '-filter_complex', `${vf};${af}`, '-map', '[v]', '-map', '[a]', '-t', String(D), ...ENC, out]);
  parts.push(out);
  console.log('scene', m.id, D.toFixed(1) + 's');
}
card('99-outro');

const list = `${OUT}/concat.txt`;
fs.writeFileSync(list, parts.map(p => `file '${p}'`).join('\n'));
const final = `${OUT}/mcp-music-studio-v0.5.0-showcase.mp4`;
ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', final]);
console.log('→', final);
