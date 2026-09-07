// Ready-made tool arguments for driving the widgets by hand in the harness.
// The Strudel entries mirror the recipes in the guide's "visuals" topic
// (src/strudel-guide.ts) so what we test is what the model is told to write.

export interface Preset {
  id: string;
  label: string;
  widget: "strudel" | "abc";
  args: Record<string, unknown>;
}

export const PRESETS: Preset[] = [
  {
    id: "hydra-minimal",
    label: "Hydra — minimal moving background",
    widget: "strudel",
    args: {
      title: "Minimal moving background",
      code: `await initHydra()
osc(8, 0.05, 0.9).rotate(0.3).kaleid(5).color(0.5, 0.35, 1).out(o0)

s("bd*2 [~ sd] hh*4").bank("RolandTR909")`,
    },
  },
  {
    id: "hydra-feedstrudel",
    label: "Hydra — feedStrudel (pianoroll through the shader)",
    widget: "strudel",
    args: {
      title: "feedStrudel",
      code: `await initHydra({ feedStrudel: true })
src(s0)
  .kaleid(4)
  .modulate(noise(3, 0.2), 0.06)
  .colorama(0.01)
  .blend(o0, 0.65)
  .out(o0)

note("<[c3 e3 g3 b3] [a2 c3 e3 g3]>*2").s("sawtooth").lpf(1400).pianoroll({ cycles: 2 })`,
    },
  },
  {
    id: "hydra-pulse",
    label: "Hydra — kick pulse via H()",
    widget: "strudel",
    args: {
      title: "Kick pulse",
      code: `await initHydra()
const pulse = "1 0 0.6 0 1 0 0.3 0.3"
shape(6, () => 0.15 + 0.35 * H(pulse)(), 0.3)
  .repeat(3, 3)
  .modulateRotate(osc(4, 0.1), 0.4)
  .color(0.2, 0.8, 1)
  .out(o0)

stack(
  s("bd*2 [~ bd] bd*2 [~ bd]").bank("RolandTR808"),
  s("~ cp").bank("RolandTR808"),
  s("hh*8").gain(0.5)
)`,
    },
  },
  {
    id: "pianoroll-only",
    label: "Pianoroll only (no Hydra — v0.4.2 backdrop)",
    widget: "strudel",
    args: {
      title: "Pianoroll",
      code: `note("c3 e3 g3 c4 <b3 a3>").s("sawtooth").lpf(2000).pianoroll({ cycles: 2 })`,
    },
  },
  {
    id: "plain",
    label: "Plain pattern (no visuals at all)",
    widget: "strudel",
    args: {
      title: "Plain beat",
      code: `stack(
  s("bd*2 [~ sd]").bank("RolandTR909"),
  s("hh*8").gain(0.5)
)`,
    },
  },
  {
    id: "hydra-shader-error",
    label: "ERROR — Hydra shader typo (.foo())",
    widget: "strudel",
    args: {
      title: "Broken shader",
      code: `await initHydra()
osc(8).foo().out(o0)

s("bd*4")`,
    },
  },
  {
    id: "strudel-syntax-error",
    label: "ERROR — Strudel syntax error",
    widget: "strudel",
    args: {
      title: "Broken pattern",
      code: `s("bd*4" .nope(`,
    },
  },
  {
    id: "strudel-unknown-sound",
    label: "ERROR — unknown sound name",
    widget: "strudel",
    args: {
      title: "Unknown sound",
      code: `s("definitely_not_a_sound*4")`,
    },
  },
  {
    id: "abc-basic",
    label: "ABC — folk tune with chords",
    widget: "abc",
    args: {
      title: "Harness tune",
      style: "folk",
      abcNotation: `X:1
T:Harness Tune
M:4/4
L:1/8
K:G
"G"G2 B2 d2 B2 | "C"c2 e2 "D"d4 | "G"B2 d2 g2 d2 | "D"A2 F2 "G"G4 |]`,
    },
  },
  {
    // Two voices, so the Edit pane's bar counting (per voice, not summed) and
    // the multi-stave re-render are both easy to eyeball.
    id: "abc-two-voice",
    label: "ABC — 2-voice invention (Edit pane)",
    widget: "abc",
    args: {
      title: "Two-Voice Invention",
      style: "classical",
      abcNotation: `X:1
T:Two-Voice Invention
M:4/4
L:1/8
Q:1/4=96
K:C
V:1 clef=treble
V:2 clef=bass
[V:1] "C"c2 e2 g2 e2 | "F"f2 a2 "G"g2 f2 | "C"e2 g2 c'2 g2 | "G"d2 f2 "C"e4 |]
[V:2] "C"C,2 G,2 E,2 G,2 | "F"F,2 C2 "G"G,2 B,2 | "C"C,2 E,2 G,2 E,2 | "G"G,,2 B,,2 "C"C,4 |]`,
    },
  },
];
