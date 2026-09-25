// =============================================================================
// The film's conversation: five widgets, all real tool calls.
//
// "Rest" (the first score) is written around its silences: rests of one beat,
// one beat, two beats, then a whole empty bar. On 0.5.8 each note falls off a
// cliff into them; on 0.5.12 the notes ring out into the room.
//
// The other four exist to be scrolled past. On 0.5.8 a pan that starts on a
// parked widget wakes it (a touchend is activation), so scrolling the chat
// starts them one after another, in three keys at once.
// =============================================================================

export type Turn = {
  widget: "abc" | "strudel";
  /** Width of the user's bubble, % of the column. */
  ask: number;
  askLines?: number[];
  reply?: number[];
  height?: number;
  args: Record<string, unknown>;
};

export const REST = `X:1
M:3/4
L:1/8
Q:1/4=72
K:Dm
[D,A,F]2 z2 A2 | [B,,F,D]2 z2 F2 |
[A,,E,^C]2 z4 | z6 | [D,A,DF]6 |]`;

const JIG = `X:1
M:6/8
L:1/8
Q:3/8=112
K:G
|:"G"GAB "C"c2e|"G"dBG "D"A2F|"G"GAB "C"cde|"D"dcA "G"G3:|`;

const MARCH = `X:1
M:2/4
L:1/8
Q:1/4=112
K:Bb
"Bb"B,D FB | "F"cA F2 | "Bb"dB FD | "F"C2 F2 | "Bb"B,D FB | "Eb"ce gc' | "F"bg ec | "Bb"B4 |]`;

const TECHNO = `stack(
  s("bd*4").bank("RolandTR909"),
  s("[~ hh]*4").bank("RolandTR909").gain(0.5),
  s("~ cp").bank("RolandTR909"),
  note("<a1 a1 c2 g1>*8").s("sawtooth")
    .lpf(sine.range(300, 2000).slow(4))
    .decay(0.12).sustain(0).gain(0.6)
)`;

/**
 * What the last widget starts as: "Rest"'s four chords, ringing. The recorder
 * types the rest in, one layer at a time, evaluating after each.
 */
export const FINALE_START = `$: note("<[d3,a3,f4] [bb2,f3,d4] [a2,e3,c#4] [d3,a3,f4]>")
  .s("piano").room(0.6).gain(0.8)`;

export const FINALE_LAYERS: string[] = [
  `
  .color('#9fb4ff').pianoroll({ ctx: getDrawContext('roll') })`,
  `

$: s("bd ~ ~ bd, ~ cp, hh*8").bank("RolandTR909").gain(0.8)
  .color('#f7768e').punchcard({ ctx: getDrawContext('beat') })`,
  `

const mel = "<[a4 ~ f4 ~] [d4 ~ f4 a4] [e4 ~ c#4 ~] [d4 ~ ~ ~]>*2"
$: note(mel).s("gm_vibraphone").room(0.5).delay(0.3).gain(0.7)
await initHydra()
osc(10, 0.04, 0).color(() => (H(mel)() - 58) / 14, 0.28, 0.95)
  .kaleid(4).modulate(noise(1.4, 0.08), 0.12).out(o0)`,
  `

// the room, drawn: a ring per note, gone in 1.6 s
$: note("<d2 bb1 a1 d2>").struct("x ~ x x ~ x ~ ~")
  .s("gm_synth_bass_1").lpf(500)
  .onPaint((_, time, haps) => {
    const ctx = getDrawContext('rings')
    const { width: w, height: h } = ctx.canvas
    ctx.clearRect(0, 0, w, h)
    for (const hap of haps) {
      const age = time - hap.whole.begin
      if (age < 0 || age > 0.8) continue
      ctx.globalAlpha = 1 - age / 0.8
      ctx.lineWidth = 3 + a.fft[0] * 40
      ctx.strokeStyle = '#ffd6a0'
      ctx.beginPath()
      ctx.arc(w / 2, h / 2, age * h, 0, 7)
      ctx.stroke()
    }
  })`,
];

export const CONVERSATION: Turn[] = [
  { widget: "abc", ask: 58, askLines: [100], reply: [88, 54], height: 300,
    args: { abcNotation: REST, instrument: "Acoustic Grand Piano" } },
  { widget: "abc", ask: 72, reply: [80], height: 300,
    args: { abcNotation: JIG, instrument: "Violin", style: "folk" } },
  { widget: "strudel", ask: 46, askLines: [100], reply: [94, 40], height: 330,
    args: { code: TECHNO, bpm: 130, theme: "tokyoNight" } },
  { widget: "abc", ask: 64, reply: [72], height: 300,
    args: { abcNotation: MARCH, instrument: "Trumpet", style: "march" } },
  { widget: "strudel", ask: 80, askLines: [100, 86, 30], reply: [90, 76], height: 420,
    args: { code: FINALE_START, theme: "tokyoNight" } },
];

// ---- the montage (stage, fullscreen): the same music, lifted, under five shaders ----

const RINGS = `$: note("<d2 bb1 a1 d2>").struct("x ~ x x ~ x ~ ~")
  .s("gm_synth_bass_1").lpf(500)
  .onPaint((_, time, haps) => {
    const ctx = getDrawContext('rings')
    const { width: w, height: h } = ctx.canvas
    ctx.clearRect(0, 0, w, h)
    for (const hap of haps) {
      const age = time - hap.whole.begin
      if (age < 0 || age > 0.8) continue
      ctx.globalAlpha = 1 - age / 0.8
      ctx.lineWidth = 3 + a.fft[0] * 40
      ctx.strokeStyle = '#ffd6a0'
      ctx.beginPath()
      ctx.arc(w / 2, h / 2, age * h, 0, 7)
      ctx.stroke()
    }
  })`;

/**
 * The finale's music with a lift (16th hats, an arpeggio). The 2D grids step
 * aside; the melody's piano roll becomes a texture the shaders can read (s0).
 * The bass comes from the scene: plain, or drawing the rings.
 */
export const MONTAGE_MUSIC = `$: note("<[d3,a3,f4] [bb2,f3,d4] [a2,e3,c#4] [d3,a3,f4]>")
  .s("piano").room(0.6).gain(0.8)
$: s("bd ~ ~ bd, ~ cp, hh*16").bank("RolandTR909").gain(0.8)
const mel = "<[a4 ~ f4 ~] [d4 ~ f4 a4] [e4 ~ c#4 ~] [d4 ~ ~ ~]>*2"
$: note(mel).s("gm_vibraphone").room(0.5).delay(0.3).gain(0.7)
  .color('#ffd6a0').pianoroll({ fold: 1, cycles: 2 })
$: n("0 2 4 6 7 6 4 2").scale("<d4:minor bb3:lydian a3:major d4:minor>")
  .s("sawtooth").lpf(sine.range(700, 3200).slow(4)).decay(0.15).sustain(0)
  .delay(0.4).gain(0.32)
`;

const BASS = `$: note("<d2 bb1 a1 d2>").struct("x ~ x x ~ x ~ ~")
  .s("gm_synth_bass_1").lpf(500)
`;

export type Scene = { code: string; rings?: boolean };

/** One evaluation of the montage: music, bass (with or without rings), shader. */
export function montage(scene: Scene): string {
  return `${MONTAGE_MUSIC}${scene.rings ? RINGS + "\n" : BASS}await initHydra({ feedStrudel: true })
${scene.code}`;
}

/**
 * Five scenes, one palette (black, violet, magenta, amber), escalating. Each
 * reads the music: a.fft[0] is the kick, a.fft[3] the hats, H(mel) the
 * melody's pitch, s0 the melody's own piano roll.
 */
export const SCENES: Record<string, Scene> = {
  // A tunnel of rings flowing outward; the kick flares it, the vignette keeps it dark.
  tunnel: { code: `osc(50, -0.12, 0).kaleid(64)
  .color(1, 0.55, 0.25)
  .brightness(() => a.fft[0] * 0.35 - 0.25)
  .mask(shape(64, 0.75, 0.6))
  .out(o0)` },
  // Cells that split with the kick and drift upward.
  cells: { code: `voronoi(() => 6 + a.fft[0] * 30, 0.6, 0.2)
  .color(1, 0.3, 0.85)
  .scrollY(0, -0.06)
  .modulateScale(osc(2), () => a.fft[1])
  .mult(solid(1, 1, 1), () => 0.4 + a.fft[0])
  .add(src(o0).scale(1.01).color(0.6, 0.5, 0.8), 0.5)
  .out(o0)` },
  // The melody's piano roll, tiled and folded into a turning mandala.
  mandala: { code: `src(s0).repeat(3, 3).kaleid(6)
  .rotate(() => time * 0.15)
  .scale(() => 0.9 + a.fft[0] * 0.3)
  .color(1.3, 0.6, 1.5)
  .add(src(o0).scale(1.02).color(0.8, 0.6, 0.95), 0.7)
  .out(o0)` },
  // Op-art: stripes that turn with the melody and pump with the kick.
  opart: { code: `osc(40, 0.25, 0).kaleid(3)
  .rotate(() => H(mel)() / 30)
  .modulateScale(osc(3, 0.1), () => a.fft[0] * 0.8)
  .color(1, 0.25, 0.85).contrast(1.8)
  .out(o0)` },
  // All of it: stripes, the roll, and the room's rings on top.
  everything: { rings: true, code: `osc(40, 0.25, 0).kaleid(6)
  .rotate(() => H(mel)() / 30)
  .color(0.9, 0.25, 1).contrast(1.6)
  .modulate(src(o0), () => a.fft[0] * 0.08)
  .add(src(s0).kaleid(6).color(1, 0.7, 0.4), 0.6)
  .blend(o0, 0.35)
  .out(o0)` },
};
