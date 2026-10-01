setcps(0.5167);
await initHydra({ feedStrudel: true })

// ── the story: memory (8) → errors (4) → build (4) → DROP (8) → afterglow (8) ──
const decayP  = H("<0!8 0.2!4 0.3 0.45 0.6 0.8 1!8 0.12!8>")
const blocksP = H("<[40 400] [12 200 400 60] 80 [400 8]>*2")
const tearP   = H("0 0 0.3 0 0 0.6 0 0.12 0 0.4 0 0 0.2 0 0.7 0")
const splitP  = H("<0.004 0.012 0.002 [0.02 0.006]>*4")
const mirrorP = H("<2 2 4 [3 6]>")
const lineP   = H("<0 1 2 3>")          // one line of text per chord
const k = () => decayP()

// ════════ ASCII ENGINE: a hand-drawn terminal fed into Hydra ════════
const cvs = document.createElement('canvas')
cvs.width = 640
cvs.height = 400
const g = cvs.getContext('2d')
const COLS = 64
const ROWS = 32
const CW = cvs.width / COLS
const CH = cvs.height / ROWS
const ramp = ' .:-=+*#%@'
const junk = '█▓▒░#$%&01<>/?!'
const lines = {
  mem:   ['do you remember', 'the window light', 'your voice on the radio', 'everything was clear'],
  drop:  ['FILE CORRUPT', 'SIGNAL LOST', '0xDEADBEEF', 'who are you'],
  after: ['i remember', 'almost', 'the light', 'most of it']
}
const pick = s => s[Math.floor(Math.random() * s.length)]
const corrupt = (str, p) => str.split('').map(c => c !== ' ' && Math.random() < p ? pick(junk) : c).join('')

if (window.__lossyRaf) cancelAnimationFrame(window.__lossyRaf)
const draw = () => {
  let kv = 0, li = 0, kick = 0, bass = 0, air = 0
  try { kv = k(); li = lineP() } catch (e) {}
  try { kick = a.fft[0]; bass = a.fft[1]; air = a.fft[3] } catch (e) {}
  const t = performance.now() / 1000

  g.fillStyle = 'black'
  g.fillRect(0, 0, cvs.width, cvs.height)
  g.font = Math.floor(CH) + 'px monospace'
  g.textBaseline = 'top'
  g.fillStyle = 'white'

  // ASCII tunnel: kick fires a ring outward, bass twists it, decay speeds it up
  for (let y = 0; y < ROWS; y++) {
    let row = ''
    for (let x = 0; x < COLS; x++) {
      const dx = (x - COLS / 2) / COLS * 3.2
      const dy = (y - ROWS / 2) / ROWS * 2
      const r = Math.sqrt(dx * dx + dy * dy) + 0.001
      const ang = Math.atan2(dy, dx)
      let v = Math.sin(3 / r - t * (1 + kv * 3) + Math.sin(ang * 3 + t * 0.5) * (0.5 + bass * 2))
      v += Math.sin(ang * (2 + Math.round(kv * 4)) + t * 0.7) * 0.5
      v += Math.max(0, 1 - Math.abs(r - kick * 1.2) * 4) * 2
      v = (v + 1.5) / 4 * Math.min(1, r * 1.5)
      let c = ramp[Math.max(0, Math.min(ramp.length - 1, Math.floor(v * ramp.length)))]
      if (Math.random() < kv * 0.15 + air * 0.05 * kv) c = pick(junk)
      row += c
    }
    g.fillText(row, 0, y * CH)
  }

  // status bar: memory integrity drains as the song falls apart
  const full = Math.round((1 - kv) * 20)
  const status = '> lossy.mem   integrity ' + Math.round((1 - kv) * 100) + '%  [' + '|'.repeat(full) + '-'.repeat(20 - full) + ']'
  g.fillStyle = 'black'
  g.fillRect(0, 0, cvs.width, CH * 1.3)
  g.fillStyle = 'white'
  g.fillText(corrupt(status, kv * 0.2), CW, 2)

  // the words: clear, then rotting, then screaming, then half-recovered
  const set = kv >= 0.9 ? lines.drop : (kv > 0 && kv < 0.15) ? lines.after : lines.mem
  const msg = corrupt(set[li % 4] || '', Math.min(kv, 0.35))
  const big = Math.floor(CH * 2.4)
  g.font = 'bold ' + big + 'px monospace'
  const w = g.measureText(msg).width
  const mx = (cvs.width - w) / 2 + (kv > 0.5 ? (Math.random() - 0.5) * kick * 30 : 0)
  const my = cvs.height / 2 - big / 2
  g.fillStyle = 'black'
  g.fillRect(mx - 12, my - 8, w + 24, big + 16)
  g.fillStyle = 'white'
  g.fillText(msg, mx, my)

  window.__lossyRaf = requestAnimationFrame(draw)
}
draw()
s1.init({ src: cvs, dynamic: true })

// ════════ HYDRA: the terminal goes through the damage chain ════════
const px = () => k() > 0.9 ? blocksP() * 2 : 1200

// signal: mint terminal → hot magenta, piano roll ghosted in
src(s1)
  .color(() => 0.55 + k() * 0.45, () => 0.95 - k() * 0.7, () => 0.85 + k() * 0.15)
  .add(src(s0), 0.35)
  .add(src(s0).kaleid(mirrorP), () => k() > 0.9 ? 0.5 : 0)
  .modulate(voronoi(5, 0.3), () => k() * 0.12 + a.fft[0] * 0.08 * k())
  .out(o1)

// corruption + kick punch-zoom
src(o1)
  .modulateScrollX(osc(30, 0).rotate(Math.PI / 2).posterize(4, 1), () => tearP() * k())
  .pixelate(px, px)
  .scale(() => 1 + a.fft[0] * 0.1 * k())
  .out(o2)

// playback: RGB drift, smear, CRT
src(o2).color(1, 0, 0)
  .add(src(o2).scrollX(() => 0.001 + splitP() * k() * 1.5).color(0, 1, 0))
  .add(src(o2).scrollX(() => -0.001 - splitP() * k() * 1.5).color(0, 0, 1))
  .blend(src(o0).modulate(noise(3, 0.2), 0.01).scale(1.01), () => 0.15 + k() * 0.45)
  .colorama(() => a.fft[3] * 0.05 * k())
  .mult(osc(400, 0, 0).rotate(Math.PI / 2).add(solid(0.65, 0.65, 0.65)))
  .add(shape(2, 0.02, 0.3).scrollY(() => (time * 0.12) % 1).color(0.4, 0.4, 0.5), () => 0.08 + k() * 0.3)
  .out(o0)

all(p => p.pianoroll({ fold: 1, cycles: 2 }))

// ════════ MUSIC ════════
const lead = note("<[a4 ~ c5 e5] [d5 ~ c5 b4] [c5 ~ a4 e4] [g#4 ~ b4 ~]>")
  .s("kalimba").room(0.6).delay(0.25).gain(0.8).color("white")
const keys = note("<[a2,c3,e3,g3,b3] [f2,a2,c3,e3] [d2,f2,a2,c3,e3] [e2,g#2,b2,d3]>")
  .s("gm_epiano1").room(0.6).gain(0.45).color("cyan")
const pump = "[0.1 0.5 0.9 0.8]*4"

arrange(
  [8, stack(lead, keys,
    s("hh*8").bank("RolandTR909").gain(0.1).lpf(3000))],

  [4, stack(
    lead.sometimesBy(0.2, x => x.coarse(6)),
    keys.sometimesBy(0.1, x => x.ply(2)),
    s("bd ~ ~ ~ bd ~ ~ ~").bank("RolandTR808").gain(0.8),
    s("hh*16").bank("RolandTR909").degradeBy(0.5).gain(0.15)
  )],

  [4, stack(
    lead.crush(8),
    keys.crush(10).lpf(saw.range(800, 4000).slow(4)),
    s("bd*4").bank("RolandTR909").gain(0.75).mask("<1 1 1 [1 1 0 0]>"),
    s("<sd*4 sd*8 sd*16 sd*32>").bank("RolandTR909").gain(saw.range(0.2, 0.7).slow(4)),
    s("white*16").decay(0.08).sustain(0)
      .hpf(saw.range(500, 8000).slow(4)).gain(saw.range(0.02, 0.3).slow(4))
  )],

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

  [8, stack(
    lead.delay(0.5).delayfeedback(0.6).room(0.9).gain(0.65)
      .sometimesBy(0.12, x => x.coarse(4)),
    keys.lpf(1200).gain(0.3),
    s("bd ~ ~ ~").bank("RolandTR808").gain(0.5).lpf(150)
  )]
)
