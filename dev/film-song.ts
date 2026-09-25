// =============================================================================
// "Rest" — the piece. D minor, 144 bpm (twice Rest's 72, so the score's pulse
// carries into it), one cycle = one bar = 1.667 s.
//
// The arrangement is IN the code: every block has a mask, one step per bar
// ("<0!4 1!11 …>"), so the whole song is one evaluation and every entry lands
// on its downbeat to the sample (re-evaluating per section didn't: Strudel
// schedules ahead, so a section's first beat went missing). The rest before
// the drop is written as a rest — `[1 1 1 0]`, the last beat of bar 15.
// Only the Hydra shader changes during the performance; that is visual, so
// evaluation latency doesn't matter for it.
//
//   bars  0–3   intro      Rest's chords + melody
//         4–7   +half-time drums, bass (the rings)
//         8–13  +arp
//        14–15  riser — then a rest
//        16–23  drop: 2-step, sub
//        24–27  break
//        28     the last chord
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

// one mask step per bar; [1 1 1 0] is the rest before the drop
$: note(chords).s("piano").room(0.6).gain(0.5)
  .mask("<1!15 [1 1 1 0] 1!13 0>")
  .color('#9fb4ff').pianoroll({ ctx: getDrawContext('roll') })
$: note(mel).s("gm_vibraphone").room(0.5).delay(0.3).gain(0.45)
  .mask("<1!15 [1 1 1 0] 1!12 0!2>")
  .color('#ffd6a0').spiral()
$: s("bd ~ ~ ~, ~ ~ sd ~, hh*4").bank("RolandTR909").gain(0.42)
  .mask("<0!4 1!11 [1 1 1 0] 0!14>")
  .color('#f7768e').punchcard({ ctx: getDrawContext('beat') })
$: note("<d2 bb1 a1 d2>").struct("x ~ x x ~ x ~ ~")
  .s("gm_synth_bass_1").lpf(500).gain(0.6)
  .mask("<0!4 1!11 [1 1 1 0] 1!12 0!2>").onPaint(rings)
$: n("0 2 4 6 7 6 4 2").scale("<d4:minor bb3:lydian a3:major d4:minor>")
  .s("sawtooth").lpf(sine.range(400, 3200).slow(8))
  .decay(0.15).sustain(0).delay(0.4).gain(0.22)
  .mask("<0!8 1!7 [1 1 1 0] 1!8 0!6>")
$: s("sd*16").bank("RolandTR909")
  .gain(saw.range(0.1, 0.65).slow(2)).lpf(saw.range(800, 9000).slow(2))
  .mask("<0!14 1 [1 1 1 0] 0!14>")
$: s("bd ~ ~ ~ ~ ~ ~ bd ~ ~ bd ~ ~ ~ ~ ~, ~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~, hh*16")
  .bank("RolandTR909").gain(0.42)
  .mask("<0!16 1!8 0!6>")
  .color('#f7768e').punchcard({ ctx: getDrawContext('beat') })
$: note("<d1 bb0 a0 d1>").struct("x ~ ~ x ~ ~ x ~").s("sine").gain(0.36)
  .mask("<0!16 1!8 0!6>")

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

/** When the shader changes, in bars from the song's first bar. */
export const SCENE_CUES: Array<{ at: number; shader: string }> = [
  { at: 0, shader: "black" },
  { at: 8, shader: "pitch" },
  { at: 14, shader: "tunnel" },
  { at: 15.75, shader: "black" },
  { at: 16, shader: "cells" },
  { at: 18, shader: "mandala" },
  { at: 20, shader: "opart" },
  { at: 22, shader: "everything" },
  { at: 24, shader: "tunnel" },
  { at: 28, shader: "pitch" },
];
/** Bar 29 is silent in every mask; Stop just before the song would loop. */
export const STOP_AT = 29.9;

export function withShader(shader: string): string {
  return SONG + SHADERS[shader] + "\n";
}
