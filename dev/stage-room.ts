// =============================================================================
// The Stage on its own: a synthetic band (no abcjs, no widget), for drawing
// work and screenshots. Params: ?band=grand,guitar,ebass,drums (GM programs or
// names below), ?t=<seconds> (a frozen moment), ?focus=<n>,
// ?play=1, ?theme=dark, ?h=<px>, ?mute=<n> (that player's notes become "yours");
// ?focus=<n> and ?mute=<n> count from 0 in ?band order.
// =============================================================================
import "../src/global.css";
import "../src/stage/stage.css";
import { StageView } from "../src/stage/stage-view";
import { playersFrom, type MapNote } from "../src/stage/stage-model";

const q = new URLSearchParams(location.search);
if (q.has("eye")) (globalThis as { __STAGE_EYE?: number }).__STAGE_EYE = Number(q.get("eye"));
if (q.get("theme")) document.documentElement.dataset.theme = q.get("theme")!;
const PROGRAMS: Record<string, number> = { grand: 0, keys: 4, organ: 16, flute: 73, whistle: 78, clarinet: 71, trumpet: 56, guitar: 24, electric: 27, ebass: 33, upright: 32, cello: 42, violin: 40, marimba: 12, drums: 128 };
const band = (q.get("band") ?? "grand,guitar,ebass,drums").split(",").map((s) => PROGRAMS[s] ?? Number(s));

// Eight bars of 4/4 at ♩=100: C Am F G under a stepwise tune.
const WHOLE = 2.4;
const chords = [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]];
const tune = [60, 62, 64, 65, 67, 65, 64, 62, 60, 64, 67, 72, 71, 67, 65, 62, 64, 65, 67, 69, 67, 64, 62, 60, 59, 62, 65, 67, 72, 71, 72, 72];
const note = (pitch: number, instrument: number, start: number, len: number, volume = 90): MapNote => ({ pitch, instrument, start, end: start + len * 0.95, volume });
const tracks: MapNote[][] = band.map((program, i) => {
  const mute = q.get("mute") === String(i);
  const v = mute ? 0 : 90;
  const out: MapNote[] = [];
  for (let bar = 0; bar < 8; bar++) {
    const s = bar, c = chords[bar % 4];
    if (program === 128) {
      for (let e = 0; e < 8; e++) out.push(note(42, 128, s + e / 8, 1 / 8, v));
      out.push(note(36, 128, s, 0.25, v), note(36, 128, s + 0.5, 0.25, v), note(38, 128, s + 0.25, 0.25, v), note(38, 128, s + 0.75, 0.25, v));
      if (bar % 4 === 0) out.push(note(49, 128, s, 0.5, v));
    } else if (i === 0) {
      for (let b = 0; b < 4; b++) out.push(note(tune[(bar * 4 + b) % tune.length] + (program >= 32 && program <= 43 && program !== 40 ? -12 : 0), program, s + b / 4, 1 / 4, v));
    } else if ((program >= 32 && program <= 39) || program === 43) {
      out.push(note(c[0] - 24, program, s, 0.5, v), note(c[0] - 17, program, s + 0.5, 0.5, v));
    } else {
      for (const half of [0, 0.5]) for (const p of c) out.push(note(p - (program === 42 ? 12 : 0), program, s + half, 0.25, v));
    }
  }
  return out;
});
const players = playersFrom(tracks, WHOLE);

let t0 = performance.now(), playing = q.get("play") === "1";
const frozen = q.has("t") ? Number(q.get("t")) : null;
let ctx: AudioContext | null = null;
const tones = new Map<string, { stop(): void }>();
const stage = new StageView({
  position: () => {
    if (frozen !== null) return { t: frozen, running: true };
    if (!playing) return { t: 0, running: false };
    return { t: ((performance.now() - t0) / 1000) % (8 * WHOLE), running: true };
  },
  noteOn(program, pitch) {
    ctx ??= new AudioContext();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = program === 128 ? "square" : "triangle";
    o.frequency.value = 440 * 2 ** ((pitch - 69) / 12);
    g.gain.setValueAtTime(0.2, ctx.currentTime);
    g.gain.setTargetAtTime(0.08, ctx.currentTime + 0.05, 0.3);
    o.connect(g).connect(ctx.destination);
    o.start();
    tones.get(`${program}:${pitch}`)?.stop();
    tones.set(`${program}:${pitch}`, { stop: () => { g.gain.setTargetAtTime(0, ctx!.currentTime, 0.08); o.stop(ctx!.currentTime + 0.5); } });
    (window as unknown as { __presses: unknown[] }).__presses.push({ program, pitch });
  },
  noteOff(program, pitch) {
    tones.get(`${program}:${pitch}`)?.stop();
    tones.delete(`${program}:${pitch}`);
  },
  join(player) {
    (window as unknown as { __joined: string | null }).__joined = player?.id ?? null;
  },
});
(window as unknown as { __presses: unknown[] }).__presses = [];
if (q.get("h")) stage.el.style.setProperty("--stage-h", `${q.get("h")}px`);
document.getElementById("wrap")!.appendChild(stage.el);
stage.setPlayers(players, "Stepwise in C", WHOLE / 4);
stage.setVisible(true);
if (q.get("focus")) stage.setFocus(players[Number(q.get("focus"))]?.id ?? null);
document.getElementById("play")!.onclick = () => { playing = !playing; t0 = performance.now(); };
document.getElementById("names")!.onclick = () => stage.el.classList.toggle("names");
(window as unknown as { __stage: StageView }).__stage = stage;
