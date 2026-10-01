setcps(0.5167);
await initHydra({ feedStrudel: true })

// ── the story: memory (8) → errors (4) → build (4) → DROP (8) → afterglow (8) ──
const decayP = H("<0!8 0.2!4 0.3 0.45 0.6 0.8 1!8 0.12!8>")
const blocksP = H("<[40 400] [12 200 400 60] 80 [400 8]>*2")
const tearP   = H("0 0 0.3 0 0 0.6 0 0.12 0 0.4 0 0 0.2 0 0.7 0")
const splitP  = H("<0.004 0.012 0.002 [0.02 0.006]>*4")
const mirrorP = H("<2 2 4 [3 6]>")
const k = () => decayP()
const px = () => k() > 0.9 ? blocksP() : 400 - k() * 450

// ── signal: blue wash bruising toward magenta ──
noise(2.5, 0.06)
  .color(() => 0.15 + k() * 0.8, () => 0.25 - k() * 0.15, () => 0.6 - k() * 0.3)
  .modulate(voronoi(5, 0.3), () => 0.04 + k() * 0.3 + a.fft[0] * 0.3 * k())
  .add(src(s0), 0.9)
  .add(src(s0).kaleid(mirrorP), () => k() * 0.7)
  .out(o1)

// ── corruption + kick punch-zoom ──
src(o1)
  .modulateScrollX(osc(30, 0).rotate(Math.PI / 2).posterize(4, 1), () => tearP() * k())
  .pixelate(px, px)
  .scale(() => 1 + a.fft[0] * 0.12 * k())
  .out(o2)

// ── playback: RGB drift, smear, CRT ──
src(o2).color(1, 0, 0)
  .add(src(o2).scrollX(() => 0.001 + splitP() * k() * 1.5).color(0, 1, 0))
  .add(src(o2).scrollX(() => -0.001 - splitP() * k() * 1.5).color(0, 0, 1))
  .blend(src(o0).modulate(noise(3, 0.2), 0.01).scale(1.01), () => 0.3 + k() * 0.35)
  .colorama(() => a.fft[3] * 0.05 * k())
  .mult(osc(400, 0, 0).rotate(Math.PI / 2).add(solid(0.65, 0.65, 0.65)))
  .add(shape(2, 0.02, 0.3).scrollY(() => (time * 0.12) % 1).color(0.4, 0.4, 0.5), () => 0.08 + k() * 0.3)
  .out(o0)

all(p => p.pianoroll({ fold: 1, cycles: 2 }))

// ── the memory ──
const lead = note("<[a4 ~ c5 e5] [d5 ~ c5 b4] [c5 ~ a4 e4] [g#4 ~ b4 ~]>")
  .s("kalimba").room(0.6).delay(0.25).gain(0.8).color("white")
const keys = note("<[a2,c3,e3,g3,b3] [f2,a2,c3,e3] [d2,f2,a2,c3,e3] [e2,g#2,b2,d3]>")
  .s("gm_epiano1").room(0.6).gain(0.45).color("cyan")
const pump = "[0.1 0.5 0.9 0.8]*4"   // fake sidechain: ducks on every kick

arrange(
  // 1. memory
  [8, stack(lead, keys,
    s("hh*8").bank("RolandTR909").gain(0.1).lpf(3000))],

  // 2. first errors: a heartbeat
  [4, stack(
    lead.sometimesBy(0.2, x => x.coarse(6)),
    keys.sometimesBy(0.1, x => x.ply(2)),
    s("bd ~ ~ ~ bd ~ ~ ~").bank("RolandTR808").gain(0.8),
    s("hh*16").bank("RolandTR909").degradeBy(0.5).gain(0.15)
  )],

  // 3. build: snare roll, noise riser, kick pulls out at the last second
  [4, stack(
    lead.crush(8),
    keys.crush(10).lpf(saw.range(800, 4000).slow(4)),
    s("bd*4").bank("RolandTR909").gain(0.75).mask("<1 1 1 [1 1 0 0]>"),
    s("<sd*4 sd*8 sd*16 sd*32>").bank("RolandTR909").gain(saw.range(0.2, 0.7).slow(4)),
    s("white*16").decay(0.08).sustain(0)
      .hpf(saw.range(500, 8000).slow(4)).gain(saw.range(0.02, 0.3).slow(4))
  )],

  // 4. DROP: four on the floor, sub boom, pumping saws, glitch everywhere
  [8, stack(
    s("<cr ~ ~ ~ ~ ~ ~ ~>").bank("RolandTR909").gain(0.6).room(0.4),
    s("bd*4").bank("RolandTR909").gain(0.9).shape(0.3),
    s("bd*4").bank("RolandTR808").gain(0.7).lpf(180),
    s("~ cp ~ cp").bank("RolandTR909").gain(0.7).room(0.2),
    s("[~ oh]*4").bank("RolandTR909").gain(0.3),
    s("hh*16").bank("RolandTR909").gain(0.3)
      .degradeBy(0.3).speed("<1 2 1 [1 4]>").pan(rand),
    s("sd*16").bank("RolandTR909").crush(4).gain(0.35).mask("<0 0 0 [0 0 0 1]>"),
    s("cp(3,8,2)").bank("RolandTR909").crush(3).speed("<2 4 1.5 3>").gain(0.35).color("yellow"),
    note("<[a1 a2]*8 [f1 f2]*8 [d1 d2]*8 [e1 e2]*8>").s("sawtooth")
      .lpf(sine.range(400, 2200).slow(4)).lpq(8)
      .shape(0.5).crush(6).gain(pump).color("red"),
    note("<[a3,c4,e4,g4] [f3,a3,c4,e4] [d3,f3,a3,c4] [e3,g#3,b3,d4]>*2")
      .s("supersaw").lpf(2500).room(0.3).gain(pump).color("magenta"),
    lead.coarse("<8 16 4 12>").sometimesBy(0.4, x => x.ply(3))
      .jux(rev).delayfeedback(0.55).gain(0.9)
  ).mask("<1 1 1 [1 1 1 [1 0]] 1 1 [1 0 1 1] [1 1 1 [0 1]]>")],

  // 5. afterglow: it comes back, scarred
  [8, stack(
    lead.delay(0.5).delayfeedback(0.6).room(0.9).gain(0.65)
      .sometimesBy(0.12, x => x.coarse(4)),
    keys.lpf(1200).gain(0.3),
    s("bd ~ ~ ~").bank("RolandTR808").gain(0.5).lpf(150)
  )]
)
