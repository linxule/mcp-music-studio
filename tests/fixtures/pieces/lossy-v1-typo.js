setcps(0.5);
await initHydra({ feedStrudel: true })

// ── the story: how damaged the memory is, cycle by cycle ──
// memory (8) → first errors (4) → spreading (4) → collapse (8) → afterglow (8)
const decay  = "<0!8 0.25!4 0.5!4 1!8 0.12!8>"
const k = () => H(decay)()

const blocks = "<[40 400] [12 200 400 60] 80 [400 8]>*2"
const tear   = "0 0 0.3 0 0 0.6 0 0.12 0 0.4 0 0 0.2 0 0.7 0"
const split  = "<0.004 0.012 0.002 [0.02 0.006]>*4"
const mirror = "<2 2 4 [3 6]>"

// ── signal: a soft blue wash that bruises toward magenta as it decays ──
noise(2.5, 0.06)
  .color(() => 0.15 + k() * 0.8, () => 0.25 - k() * 0.15, () => 0.6 - k() * 0.3)
  .modulate(voronoi(5, 0.3), () => 0.04 + k() * 0.3 + a.fft[0] * 0.3 * k())
  .add(src(s0), 0.9)
  .add(src(s0).kaleid(H(mirror)), () => k() * 0.7)
  .out(o1)

// ── corruption: only as strong as the memory is damaged ──
src(o1)
  .modulateScrollX(osc(30, 0).rotate(Math.PI / 2).posterize(4, 1), () => H(tear)() * k())
  .pixelate(() => k() > 0.6 ? H(blocks)() : 400 - k() * 500,
            () => k() > 0.6 ? H(blocks)() : 400 - k() * 500)
  .out(o2)

// ── playback: RGB drift, smear, old CRT ──
src(o2).color(1, 0, 0)
  .add(src(o2).scrollX(() => 0.001 + H(split)() * k() * 1.5).color(0, 1, 0))
  .add(src(o2).scrollX(() => -0.001 - H(split)() * k() * 1.5).color(0, 0, 1))
  .blend(src(o0).modulate(noise(3, 0.2), 0.01).scale(1.01), () => 0.3 + k() * 0.35)
  .colorama(() => a.fft[3] * 0.05 * k())
  .mult(osc(400, 0, 0).rotate(Math.PI / 2).add(solid(0.65, 0.65, 0.65)))
  .add(shape(2, 0.02, 0.3).scrollY(() => (time * 0.12) % 1).color(0.4, 0.4, 0.5), () => 0.08 + k() * 0.3)
  .out(o0)

all(p => p.pianoroll({ fold: 1, cycles: 2 }))

// ── the memory itself ──
const lead = note("<[a4 ~ c5 e5] [d5 ~ c5 b4] [c5 ~ a4 e4] [g#4 ~ b4 ~]>")
  .s("gm_music_box").room(0.7).delay(0.25).gain(0.75).color("white")
const keys = note("<[a2,c3,e3,g3,b3] [f2,a2,c3,e3] [d2,f2,a2,c3,e3] [e2,g#2,b2,d3]>")
  .s("gm_epiano1").room(0.6).gain(0.45).color("cyan")
const bass = note("<[a1 ~ a1 a2] [f1 ~ f1 f2] [d1 ~ d1 d2] [e1 ~ e1 e2]>")
  .s("sawtooth").lpf(600).gain(0.5).color("red")
const hats = s("hh*16").bank("RolandTR909").gain(0.3).color("cyan")

arrange(
  // 1. memory: clean, fragile
  [8, stack(lead, keys, s("hh*8").bank("RolandTR909").gain(0.1).lpf(3000))],

  // 2. first errors: a heartbeat, the occasional stutter
  [4, stack(
    lead.sometimesBy(0.2, x => x.coarse(6)),
    keys.sometimesBy(0.1, x => x.ply(2)),
    s("bd ~ ~ ~ bd ~ ~ ~").bank("RolandTR909").gain(0.7),
    hats.degradeBy(0.5).gain(0.15)
  )],

  // 3. spreading: the beat locks in, bits start falling off
  [4, stack(
    lead.crush(8).sometimesBy(0.3, x => x.ply(2)),
    keys.crush(10),
    bass,
    s("bd*2 [~ bd] sd [~ bd]").bank("RolandTR909").crush(10),
    hats.degradeBy(0.3).speed("<1 1 2 1>")
  )],

  // 4. collapse: buffer underruns, everything breaks at once
  [8, stack(
    lead.coarse("<8 16 4 12>").sometimesBy(0.4, x => x.ply(3)).jux(rev).delayfeedback(0.6),
    keys.crush(4).ply("<1 2 4 1>").gain(0.35),
    bass.crush(5).shape(0.4).lpf(sine.range(300, 1800).slow(4)),
    s("bd*2 [~ bd] sd [bd ~ bd sd]").bank("RolandTR909")
      .sometimesBy(0.3, x => x.ply(2)).rarely(x => x.ply(4))
      .sometimesBy(0.15, x => x.speed(-1)).crush("<6 4 8 [4 3]>"),
    hats.degradeBy(0.3).speed("<1 2 1 [1 4]>").pan(rand),
    s("cp(3,8,2)").bank("RolandTR909").crush(3).speed("<2 4 1.5 3>").gain(0.4).color("yellow"),
    s("white*16").degradeBy(0.85).decay(0.03).sustain(0).hpf(4000).gain(0.22)
  ).mask("<1 1 [1 1 1 0] [1 0 1 [0 1]]>")),

  // 5. afterglow: it comes back, but not quite the same
  [8, stack(
    lead.delay(0.5).delayfeedback(0.6).room(0.9).gain(0.6)
      .sometimesBy(0.12, x => x.coarse(4)),
    keys.lpf(1200).gain(0.3)
  )]
)
