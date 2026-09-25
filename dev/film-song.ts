// =============================================================================
// "Rest" — the piece. D minor, 144 bpm (twice Rest's 72, so the score's pulse
// carries into it), one cycle = one bar = 1.667 s.
//
// The whole song is in the editor from the start; sections are `$:` blocks
// muted with a leading `_`, and the performance (ACTIONS) unmutes and mutes
// them on the downbeat — a one-character edit, the way a live coder plays.
// The Hydra shader after `await initHydra` is swapped per section.
//
//   bars  0–3   intro      Rest's chords + melody
//         4–7   +half-time drums, bass (the rings)
//         8–13  +arp, the pitch shader
//        14–15  riser (snare roll), tunnel — and on the last beat of bar 15:
//                a REST: everything muted, black
//        16–23  drop: 2-step, sub; four shader scenes
//        24–27  break: drums out
//        28     the last chord; Stop at 29, the room rings out
// =============================================================================

export const SONG = `setcps(0.6)
const chords = "<[d3,a3,f4] [bb2,f3,d4] [a2,e3,c#4] [d3,a3,f4]>"
const mel = "<[a4 ~ f4 ~] [d4 ~ f4 a4] [e4 ~ c#4 ~] [d4 ~ ~ ~]>*2"
const rings = (_, time, haps) => {
  const ctx = getDrawContext('rings')
  const { width: w, height: h } = ctx.canvas
  ctx.clearRect(0, 0, w, h)
  for (const hap of haps) {
    const age = time - hap.whole.begin
    if (age < 0 || age > 0.96) continue
    ctx.globalAlpha = 1 - age / 0.96
    ctx.lineWidth = 3 + a.fft[0] * 40
    ctx.strokeStyle = '#ffd6a0'
    ctx.beginPath()
    ctx.arc(w / 2, h / 2, age * h, 0, 7)
    ctx.stroke()
  }
}

$: note(chords).s("piano").room(0.6).gain(0.7) // chords
  .color('#9fb4ff').pianoroll({ ctx: getDrawContext('roll') })
$: note(mel).s("gm_vibraphone").room(0.5).delay(0.3).gain(0.6) // melody
  .color('#ffd6a0').pianoroll({ fold: 1, cycles: 2 })
_$: s("bd ~ ~ ~, ~ ~ sd ~, hh*4").bank("RolandTR909").gain(0.8) // half-time
  .color('#f7768e').punchcard({ ctx: getDrawContext('beat') })
_$: note("<d2 bb1 a1 d2>").struct("x ~ x x ~ x ~ ~") // bass
  .s("gm_synth_bass_1").lpf(500).onPaint(rings)
_$: n("0 2 4 6 7 6 4 2").scale("<d4:minor bb3:lydian a3:major d4:minor>") // arp
  .s("sawtooth").lpf(sine.range(400, 3200).slow(8))
  .decay(0.15).sustain(0).delay(0.4).gain(0.3)
_$: s("sd*16").bank("RolandTR909") // riser
  .gain(saw.range(0.15, 0.9).slow(2)).lpf(saw.range(800, 9000).slow(2))
_$: s("bd ~ ~ ~ ~ ~ ~ bd ~ ~ bd ~ ~ ~ ~ ~, ~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~, hh*16") // 2-step
  .bank("RolandTR909").gain(0.85)
  .color('#f7768e').punchcard({ ctx: getDrawContext('beat') })
_$: note("<d1 bb0 a0 d1>").struct("x ~ ~ x ~ ~ x ~").s("sine").gain(0.75) // sub

await initHydra({ feedStrudel: true })
`;

/** Shaders per section (everything after `await initHydra`). */
export const SHADERS: Record<string, string> = {
  black: `solid(0, 0, 0).out(o0)`,
  pitch: `osc(10, 0.04, 0).color(1, 0.2, () => 0.45 + Math.max(0, H(mel)() - 60) / 16)
  .kaleid(4).modulate(noise(1.4, 0.08), 0.12).out(o0)`,
  tunnel: `osc(50, -0.12, 0).kaleid(64).color(1, 0.55, 0.25)
  .brightness(() => a.fft[0] * 0.35 - 0.25)
  .mask(shape(64, 0.75, 0.6)).out(o0)`,
  cells: `voronoi(() => 6 + a.fft[0] * 30, 0.6, 0.2).color(1, 0.3, 0.85)
  .scrollY(0, -0.06).modulateScale(osc(2), () => a.fft[1])
  .add(src(o0).scale(1.01).color(0.6, 0.5, 0.8), 0.5).out(o0)`,
  mandala: `src(s0).repeat(3, 3).kaleid(6).rotate(() => time * 0.15)
  .scale(() => 0.9 + a.fft[0] * 0.3).color(1.3, 0.6, 1.5)
  .add(src(o0).scale(1.02).color(0.8, 0.6, 0.95), 0.7).out(o0)`,
  opart: `osc(40, 0.25, 0).kaleid(3).rotate(() => H(mel)() / 30)
  .modulateScale(osc(3, 0.1), () => a.fft[0] * 0.8)
  .color(1, 0.25, 0.85).contrast(1.8).out(o0)`,
  everything: `osc(40, 0.25, 0).kaleid(6).rotate(() => H(mel)() / 30)
  .color(0.9, 0.25, 1).contrast(1.6)
  .modulate(src(o0), () => a.fft[0] * 0.08)
  .add(src(s0).kaleid(6).color(1, 0.7, 0.4), 0.6)
  .blend(o0, 0.35).out(o0)`,
};

export type Action = { at: number; on?: string[]; off?: string[]; shader?: string; label: string };

/** Bar numbers relative to the song's first bar. `on`/`off` name blocks by their comment. */
export const ACTIONS: Action[] = [
  { at: 0, label: "intro", shader: "black" },
  { at: 4, label: "drums", on: ["half-time", "bass"] },
  { at: 8, label: "arp", on: ["arp"], shader: "pitch" },
  { at: 14, label: "riser", on: ["riser"], shader: "tunnel" },
  { at: 15.75, label: "rest", off: ["chords", "melody", "half-time", "bass", "arp", "riser"], shader: "black" },
  { at: 16, label: "drop", on: ["chords", "melody", "2-step", "sub", "arp", "bass"], shader: "cells" },
  { at: 18, label: "mandala", shader: "mandala" },
  { at: 20, label: "opart", shader: "opart" },
  { at: 22, label: "everything", shader: "everything" },
  { at: 24, label: "break", off: ["2-step", "sub", "arp"], shader: "tunnel" },
  { at: 28, label: "last", off: ["melody", "bass"], shader: "pitch" },
];
export const STOP_AT = 29;

/** Apply mutes and a shader to the song text. */
export function applyAction(code: string, a: Action): string {
  const lines = code.split("\n");
  for (const [names, muted] of [[a.on ?? [], false], [a.off ?? [], true]] as const) {
    for (const name of names) {
      const i = lines.findIndex((l) => /^_?\$:/.test(l) && l.endsWith(`// ${name}`));
      if (i < 0) throw new Error(`no block "${name}"`);
      lines[i] = (muted ? "_" : "") + lines[i].replace(/^_/, "");
    }
  }
  let out = lines.join("\n");
  if (a.shader) out = out.replace(/(await initHydra\([^)]*\)\n)[\s\S]*$/, `$1${SHADERS[a.shader]}\n`);
  return out;
}
