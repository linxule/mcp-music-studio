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
