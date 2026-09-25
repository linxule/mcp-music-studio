// =============================================================================
// Score stage — "Rest" drawn by abcjs on black, for the release film.
//
// The same engine and Room as the sheet widget (abcjs CreateSynth, the
// widget's synth options, src/room-reverb.ts), with no widget around it. A
// camera cuts from glyph to glyph as abcjs plays; what the glyph looks like is
// driven by the audio actually coming out (an AnalyserNode on the master), so a
// note that stops dead goes dark at once and a note that rings keeps glowing.
//
//   ?mode=old  0.5.8's sound: abcjs's 200 ms linear release, no Room — white
//   ?mode=new  0.5.13's: the 500 ms release and the Room — amber, with echoes
// =============================================================================

import ABCJS from "abcjs";
import { buildRoom } from "../src/room-reverb";
import { buildSynthOptions, NOTE_FADE_MS } from "../src/music-logic";
import { routeThroughRoom } from "../src/room-reverb";

const params = new URLSearchParams(location.search);
const OLD = params.get("mode") === "old";
const REST = params.get("abc") ?? `X:1
M:3/4
L:1/8
Q:1/4=72
K:Dm
[D,A,F]2 z2 A2 | [B,,F,D]2 z2 F2 |]`;
const INK = OLD ? "#ece8ff" : "#ffd6a0";
const ECHO = "#ff8a3d";
const ECHOES = OLD ? 0 : 6;

const stage = document.getElementById("stage")!;
const [visual] = ABCJS.renderAbc("src", REST, { add_classes: true, staffwidth: 1100, paddingtop: 0, paddingbottom: 0 });
const src = document.querySelector("#src svg") as SVGSVGElement;

// Glyphs are invisible until the camera lands on them; staff lines stay as a dim ground.
const style = document.createElement("style");
style.textContent = `
  #stage svg path, #stage svg text { fill: ${INK}; }
  #stage svg .abcjs-note, #stage svg .abcjs-rest, #stage svg .abcjs-clef, #stage svg .abcjs-key-signature,
  #stage svg .abcjs-time-signature, #stage svg .abcjs-bar, #stage svg .abcjs-tempo, #stage svg .abcjs-meta-top { opacity: 0; }
  #stage svg .abcjs-staff path, #stage svg .abcjs-staff { fill: #26222e; }
  #stage svg .cur { opacity: var(--lvl, 1) !important; }
  #stage svg.all .abcjs-note, #stage svg.all .abcjs-rest { opacity: var(--lvl, 1) !important; }
`;
document.head.appendChild(style);

const main = src.cloneNode(true) as SVGSVGElement;
main.removeAttribute("width");
main.removeAttribute("height");
main.setAttribute("preserveAspectRatio", "xMidYMid meet");
const echoes: SVGSVGElement[] = [];
for (let k = ECHOES; k >= 1; k--) {
  const e = main.cloneNode(true) as SVGSVGElement;
  e.style.cssText = `transform: scale(${1 + k * 0.1}); filter: blur(${k * 7}px); opacity: 0;`;
  e.querySelectorAll("path, text").forEach((p) => ((p as SVGElement).style.fill = ECHO));
  stage.appendChild(e);
  echoes.unshift(e);
}
stage.appendChild(main);

// ---- the camera --------------------------------------------------------------

const ASPECT = innerHeight / innerWidth;
let view = { x: 0, y: 0, w: 100 };
function setView(v: { x: number; y: number; w: number }): void {
  view = v;
  const h = v.w * ASPECT;
  const box = `${v.x} ${v.y - h / 2} ${v.w} ${h}`;
  for (const s of [main, ...echoes]) s.setAttribute("viewBox", box);
}
/** Frame the glyph with index `i` among .abcjs-note/.abcjs-rest, filling ~`fill` of the width. */
const glyphs = () => [...main.querySelectorAll(".abcjs-note, .abcjs-rest")] as SVGGraphicsElement[];
function frameGlyph(i: number, fill = 0.42): void {
  const gs = glyphs();
  const g = gs[i];
  if (!g) return;
  for (const s of [main, ...echoes]) {
    s.querySelectorAll(".cur").forEach((e) => e.classList.remove("cur"));
    (s.querySelectorAll(".abcjs-note, .abcjs-rest")[i] as Element | undefined)?.classList.add("cur");
  }
  const b = g.getBBox();
  // Size by whichever dimension binds: a chord is tall, a rest is narrow.
  const w = Math.max(b.width / fill, b.height / (0.5 * ASPECT));
  setView({ x: b.x + b.width / 2 - w / 2, y: b.y + b.height / 2, w });
}
function frameAll(): void {
  const b = (main.querySelector(".abcjs-staff-wrapper, .abcjs-staff") as SVGGraphicsElement).getBBox();
  const gs = glyphs().map((g) => g.getBBox());
  const x0 = Math.min(...gs.map((g) => g.x)) - 20, x1 = Math.max(...gs.map((g) => g.x + g.width)) + 20;
  setView({ x: x0, y: b.y + b.height / 2, w: x1 - x0 });
  for (const s of [main, ...echoes]) s.classList.add("all");
}

// ---- audio -------------------------------------------------------------------

const ctx = new AudioContext({ sampleRate: 48000 });
const master = ctx.createGain();
master.connect(ctx.destination);
const analyser = ctx.createAnalyser();
analyser.fftSize = 1024;
master.connect(analyser);
const room = OLD ? null : buildRoom(ctx, master);

// The level drives the ink; a short history drives the echoes (each echo is the level a little earlier).
const buf = new Float32Array(analyser.fftSize);
const history: number[] = [];
function level(): number {
  analyser.getFloatTimeDomainData(buf);
  let s = 0;
  for (const v of buf) s += v * v;
  const db = 10 * Math.log10(s / buf.length + 1e-12);
  return Math.min(1, Math.max(0, (db + 62) / 44));
}
let resting = false;
function frame(): void {
  const l = level();
  history.unshift(l);
  history.length = 64;
  // A rest is the one glyph that shows in silence: it IS the silence.
  const ink = resting ? Math.max(OLD ? 1 : 0.55, l) : Math.pow(l, 0.6);
  for (const s of [main, ...echoes]) s.style.setProperty("--lvl", String(ink));
  echoes.forEach((e, k) => {
    const h = history[(k + 1) * 4] ?? 0;
    e.style.opacity = String(Math.min(1, h * 1.3) * (0.75 / (k + 1)));
  });
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

async function play(): Promise<void> {
  await ctx.resume();
  const synth = new ABCJS.synth.CreateSynth();
  await synth.init({
    visualObj: visual,
    audioContext: ctx,
    options: { ...buildSynthOptions({ instrument: "Acoustic Grand Piano" }), fadeLength: OLD ? 200 : NOTE_FADE_MS },
  });
  await synth.prime();
  routeThroughRoom(synth, () => ctx, () => (room ? room.input : master));
  // Glyph order in the SVG follows the score, so the n-th timing event is the n-th glyph.
  let n = 0;
  const timing = new ABCJS.TimingCallbacks(visual, {
    eventCallback: (ev) => {
      if (!ev) return undefined;
      const els = (ev.elements ?? []).flat() as Element[];
      const all = glyphs();
      const i = els.length ? all.findIndex((g) => els.includes(g) || els.some((e) => e.contains(g) || g.contains(e))) : -1;
      const at = i >= 0 ? i : n;
      resting = all[at]?.classList.contains("abcjs-rest") ?? false;
      frameGlyph(at);
      console.log(`[stage] event ${at} ${resting ? "rest" : "note"} @${Math.round(ev.milliseconds)}`);
      n = at + 1;
      return undefined;
    },
  });
  console.log("[stage] start", Date.now());
  (window as unknown as { __startWall: number }).__startWall = Date.now();
  synth.start();
  timing.start();
  // Hold on the last note while it ends: dark at once (0.5.8) or ringing out (0.5.13).
  const dur = (visual.getTotalTime?.() ?? 5) * 1000;
  await new Promise((r) => setTimeout(r, dur + 2600));
  console.log("[stage] done", Date.now());
}

frameGlyph(0);
(main.querySelector(".cur") as Element | null)?.classList.remove("cur");
(window as unknown as { __stage: unknown }).__stage = { play, frameGlyph, frameAll, glyphs };
console.log("[stage] ready");
