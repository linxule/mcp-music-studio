// Code credits as transparent PNGs (real SF Mono, not ffmpeg drawtext): white
// type on a black slab, Fred again..-style sample credits for code.
//   bun captions.mjs <outDir>  → <outDir>/<name>.png
const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");
import fs from "node:fs";
import path from "node:path";
export const CREDITS = {
  roll: ".pianoroll({ ctx: getDrawContext('roll') })",
  beat: 's("bd ~ ~ bd, ~ cp, hh*8").punchcard(…)',
  hydra: "osc(10).color(1, 0.2, () => … H(mel)() …)",
  rings: ".onPaint(… ctx.arc(w / 2, h / 2, age * h, 0, 7) …)",
  tunnel: "osc(50, -0.12, 0).kaleid(64)",
  cells: "voronoi(() => 6 + a.fft[0] * 30, 0.6, 0.2)",
  mandala: "src(s0).repeat(3, 3).kaleid(6)",
  opart: "osc(40, 0.25, 0).kaleid(3).rotate(() => H(mel)() / 30)",
  everything: ".add(src(s0).kaleid(6), 0.6)",
  rest: '.mask("<1!15 [1 1 1 0] 1!13 0>")',
  drop: '.mask("<0!16 1!8 0!6>")',
  halftime: 's("bd ~ ~ ~, ~ ~ sd ~, hh*4").mask("<0!4 1!11 …>")',
  arp: 'n("0 2 4 6 7 6 4 2").scale("<d4:minor bb3:lydian …>")',
  riser: 's("sd*16").gain(saw.range(0.1, 0.65).slow(2))',
  spiral: "note(mel).s(\"gm_vibraphone\").spiral()",
  last: "note(chords).s(\"piano\").room(0.6)",
};
const out = process.argv[2];
if (out) {
  fs.mkdirSync(out, { recursive: true });
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1080, height: 200 }, deviceScaleFactor: 1 });
  for (const [size, suffix] of [[30, ""], [19, "-sm"]]) {
    for (const [name, text] of Object.entries(CREDITS)) {
      await p.setContent(`<html><head><style>
        @font-face { font-family: M; src: url("file:///Library/Fonts/SF-Mono-Medium.otf"); }
        html, body { margin: 0; background: transparent; }
        span { display: inline-block; font: 500 ${size}px/1.3 M, Menlo, monospace; color: #fff; background: #000; padding: ${size * 0.45}px ${size * 0.7}px; white-space: pre; }
      </style></head><body><span>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</span></body></html>`);
      await p.waitForTimeout(80);
      await p.locator("span").screenshot({ path: path.join(out, `${name}${suffix}.png`), omitBackground: true });
    }
  }
  await b.close();
}
