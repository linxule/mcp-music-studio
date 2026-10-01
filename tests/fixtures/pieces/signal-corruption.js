setcps(0.6042);
await initHydra({ feedStrudel: true })

// ── glitch sequencer (all locked to the beat, no rests) ──
const blocks = "<[40 400] [12 200 400 60] 80 [400 8]>*2"   // codec crunch
const tear   = "0 0 0.3 0 0 0.6 0 0.12 0 0.4 0 0 0.2 0 0.7 0" // scanline slips
const split  = "<0.004 0.012 0.002 [0.02 0.006]>*4"          // RGB channel drift
const mirror = "<2 2 4 [3 6]>"                                // kaleid fold of the piano roll

// ── layer 1: signal (oscillator + the notes themselves) ──
osc(18, 0.04, 1.6)
  .color(0.9, 0.2, 1)
  .modulate(voronoi(6, 0.4), () => 0.06 + a.fft[0] * 0.5)
  .add(src(s0).kaleid(H(mirror)), 0.9)
  .out(o1)

// ── layer 2: corruption ──
src(o1)
  .modulateScrollX(osc(30, 0).rotate(Math.PI / 2).posterize(4, 1), H(tear))
  .modulateScrollY(noise(1, 0.1).posterize(2, 1), () => a.fft[1] * 0.05)
  .pixelate(H(blocks), H(blocks))
  .out(o2)

// ── layer 3: RGB split + datamosh + CRT ──
src(o2).color(1, 0, 0)
  .add(src(o2).scrollX(H(split)).color(0, 1, 0))
  .add(src(o2).scrollX(() => -H(split)()).color(0, 0, 1))
  .blend(src(o0).modulate(noise(3, 0.2), 0.01).scale(1.01), 0.5)
  .colorama(() => a.fft[3] * 0.05)
  .mult(osc(400, 0, 0).rotate(Math.PI / 2).add(solid(0.65, 0.65, 0.65)))
  .add(shape(2, 0.02, 0.3).scrollY(() => (time * 0.15) % 1).color(0.4, 0.4, 0.5), 0.3)
  .out(o0)

all(p => p.pianoroll({ fold: 1, cycles: 2 }))

stack(
  // drums: stutters, reverse hits, bit depth collapsing
  s("bd*2 [~ bd] sd [bd ~ bd sd]").bank("RolandTR909")
    .sometimesBy(0.3, x => x.ply(2))
    .rarely(x => x.ply(4))
    .sometimesBy(0.15, x => x.speed(-1))
    .crush("<16 6 16 [4 3]>")
    .color("white"),
  // hats: dropouts, pitch jumps, scattered across stereo
  s("hh*16").bank("RolandTR909").gain(0.4)
    .degradeBy(0.3)
    .speed("<1 2 1 [1 4]>")
    .pan(rand)
    .color("cyan"),
  // crushed clap glitches
  s("cp(3,8,2)").bank("RolandTR909")
    .crush(3).speed("<2 4 1.5 3>")
    .gain(0.45).room(0.3)
    .color("yellow"),
  // noise bursts
  s("white*16").degradeBy(0.85)
    .decay(0.03).sustain(0)
    .hpf(4000).gain(0.25)
    .color("white"),
  // distorted bass
  note("<a1 a1 c2 [g1 a2]>*4").s("sawtooth")
    .lpf(sine.range(300, 1800).slow(4))
    .crush(5).shape(0.4).gain(0.55)
    .color("red"),
  // broken lead
  note("a4 ~ e5 ~ [c5 a5] ~ ~ g5").s("square")
    .coarse("<1 8 2 16>")
    .sometimesBy(0.2, x => x.ply(3))
    .delay(0.35).delayfeedback(0.5)
    .room(0.4).gain(0.3)
    .jux(rev)
    .color("magenta")
)
