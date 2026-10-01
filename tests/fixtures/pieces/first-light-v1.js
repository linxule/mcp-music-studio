setcps(0.525);
await initHydra()

// ════════ FIRST LIGHT ════════
// void (8 bars) → rise (8) → [half a bar of nothing] → bloom (16)
// Rule: every note you hear is a ring you see. Every chord is a colour.

const HOOK   = "<[f5 ~ eb5 ~ c5 ~ ab4 c5] [bb4 ~ c5 ~ eb5 ~ g5 ~] [g5 ~ f5 eb5 ~ c5 ~ eb5] [f5@5 c5 ab4 c5]>"
const CHORDS = "<[db3,f3,ab3,c4] [eb3,g3,bb3,db4] [c3,eb3,g3,bb3] [f3,ab3,c4,eb4,g4]>"
const ROOTS  = "<db2 eb2 c2 f2>"
const ARP    = "<[db4 f4 ab4 c5]*4 [eb4 g4 bb4 db5]*4 [c4 eb4 g4 bb4]*4 [f4 ab4 c5 eb5]*4>"
const HUES   = [275, 42, 175, 345]   // Db violet · Eb gold · Cm teal · Fm crimson
const hook = note(HOOK)

const NM = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }
const toMidi = v => {
  if (typeof v === 'number') return v
  const m = /^([a-g])(#|b)?(-?\d)$/.exec(String(v).toLowerCase())
  if (!m) return 70
  return 12 * (+m[3] + 1) + NM[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0)
}

// ════════ LIGHT ENGINE ════════
const nowP = H(signal(t => t))
const W = 800, HT = 450, cx = 400, cy = 225
const cvs = document.createElement('canvas')
cvs.width = W
cvs.height = HT
const g = cvs.getContext('2d')
g.fillStyle = 'black'
g.fillRect(0, 0, W, HT)

let rings = [], parts = [], lastT = 0
const stars = Array.from({ length: 320 }, () => ({ x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z: Math.random() * 0.95 + 0.05 }))
const respawn = st => { st.x = Math.random() * 2 - 1; st.y = Math.random() * 2 - 1; st.z = 1 }

if (window.__lightRaf) cancelAnimationFrame(window.__lightRaf)
const frame = () => {
  let t = 0, kick = 0, bass = 0
  try { t = nowP() } catch (e) {}
  try { kick = a.fft[0]; bass = a.fft[1] } catch (e) {}
  if (t < lastT - 0.01 || t - lastT > 1) lastT = t

  const c = ((Math.floor(t) % 32) + 32) % 32
  const drop = c >= 16
  const rise = c >= 8 && c < 16
  const riseAmt = rise ? (((t % 32) + 32) % 32 - 8) / 8 : drop ? 1 : 0
  const silent = c === 15 && (t % 1) >= 0.5
  const hue = HUES[((Math.floor(t) % 4) + 4) % 4]
  const newBar = Math.floor(t) !== Math.floor(lastT)

  // ── spawn: the melody's real note onsets ──
  if (t > lastT && !silent) {
    let haps = []
    try { haps = hook.queryArc(lastT, t).filter(h => h.hasOnset()) } catch (e) {}
    haps.forEach(h => {
      const m = toMidi(h.value.note)
      const hh = hue + (m - 70) * 5
      rings.push({ r: 4, v: drop ? 6 : 2.2, w: drop ? 3 : 1.5, life: 1, hue: hh })
      if (drop) for (let i = 0; i < 10; i++) {
        const ang = i / 10 * Math.PI * 2 + m
        const sp = 3 + (m - 60) * 0.15
        parts.push({ x: cx, y: cy, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 1, hue: hh })
      }
    })
    if (newBar) rings.push({ r: 10, v: drop ? 4 : 1.2, w: drop ? 18 : 10, life: 1, hue: hue })
    if (drop && Math.floor(t * 4) !== Math.floor(lastT * 4)) rings.push({ r: 20, v: 14, w: 6, life: 0.8, hue: hue, white: true })
    if (c === 16 && newBar) for (let i = 0; i < 90; i++) {
      const ang = Math.random() * Math.PI * 2, sp = 4 + Math.random() * 12
      parts.push({ x: cx, y: cy, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 1, hue: hue + Math.random() * 60 })
    }
  }
  lastT = t

  // ── fade (trails) ──
  g.globalCompositeOperation = 'source-over'
  g.fillStyle = 'rgba(0,0,0,' + (silent ? 0.4 : drop ? 0.25 : 0.14) + ')'
  g.fillRect(0, 0, W, HT)
  g.globalCompositeOperation = 'lighter'

  // ── stars: absent in the void, waking in the rise, warp speed in the bloom ──
  if (riseAmt > 0 && !silent) {
    const speed = drop ? 0.012 + kick * 0.05 : riseAmt * riseAmt * 0.01
    g.lineWidth = 1.2
    stars.forEach(st => {
      const ox = cx + st.x / st.z * 220, oy = cy + st.y / st.z * 220
      st.z -= speed
      if (st.z < 0.03) { respawn(st); return }
      const px = cx + st.x / st.z * 220, py = cy + st.y / st.z * 220
      if (px < 0 || px > W || py < 0 || py > HT) { respawn(st); return }
      g.strokeStyle = 'hsla(' + hue + ',80%,' + (60 + (1 - st.z) * 35) + '%,' + ((drop ? 1 : riseAmt) * (1 - st.z)) + ')'
      g.beginPath()
      g.moveTo(ox, oy)
      g.lineTo(px, py)
      g.stroke()
    })
  }

  // ── rings ──
  rings.forEach(r => {
    r.r += r.v
    r.life -= drop ? 0.012 : 0.006
    g.strokeStyle = 'hsla(' + r.hue + ',90%,' + (r.white ? 88 : 65) + '%,' + Math.max(0, r.life) + ')'
    g.lineWidth = Math.max(0.5, r.w * r.life)
    g.beginPath()
    g.arc(cx, cy, r.r, 0, Math.PI * 2)
    g.stroke()
  })
  rings = rings.filter(r => r.life > 0 && r.r < 700).slice(-80)

  // ── petals ──
  parts.forEach(p => {
    p.x += p.vx; p.y += p.vy; p.vx *= 0.97; p.vy *= 0.97; p.life -= 0.015
    g.fillStyle = 'hsla(' + p.hue + ',95%,70%,' + Math.max(0, p.life) + ')'
    g.beginPath()
    g.arc(p.x, p.y, 1 + 2.5 * p.life, 0, Math.PI * 2)
    g.fill()
  })
  parts = parts.filter(p => p.life > 0).slice(-450)

  // ── the light at the centre ──
  const rad = silent ? 1.5 : drop ? 10 + kick * 28 : 4 + Math.sin(t * Math.PI / 2) * 1.5 + bass * 8
  const grd = g.createRadialGradient(cx, cy, 0, cx, cy, rad * 4)
  grd.addColorStop(0, 'hsla(' + hue + ',100%,92%,1)')
  grd.addColorStop(0.25, 'hsla(' + hue + ',90%,60%,0.5)')
  grd.addColorStop(1, 'hsla(' + hue + ',90%,40%,0)')
  g.fillStyle = grd
  g.beginPath()
  g.arc(cx, cy, rad * 4, 0, Math.PI * 2)
  g.fill()

  window.__lightRaf = requestAnimationFrame(frame)
}
frame()
s1.init({ src: cvs, dynamic: true })

// ════════ HYDRA: only glow and a whisper of chromatic split on the kick ════════
src(s1).color(1, 0, 0)
  .add(src(s1).scrollX(() => a.fft[0] * 0.006).color(0, 1, 0))
  .add(src(s1).scrollX(() => -a.fft[0] * 0.006).color(0, 0, 1))
  .out(o1)
src(o1)
  .add(src(o1).scale(1.04), 0.5)
  .add(src(o1).scale(1.12), 0.28)
  .add(src(o1).scale(1.35), 0.14)
  .out(o0)

// ════════ MUSIC ════════
const pump = "[0.15 0.6 0.95 0.8]*4"

arrange(
  // VOID: a piano in the dark
  [8, stack(
    hook.s("steinway").gain(0.6).room(0.7).size(0.8),
    note(CHORDS).s("supersaw").lpf(900).attack(0.8).release(2.5).gain(0.15).room(0.9),
    note(ROOTS).s("sine").attack(0.3).release(2).gain(0.3)
  )],

  // RISE: arps wake up, the filter opens, the roll — then nothing
  [8, stack(
    hook.s("steinway").gain(0.55).room(0.6),
    note(CHORDS).s("supersaw").lpf(saw.range(900, 4000).slow(8)).attack(0.4).release(1.5).gain(0.18).room(0.7),
    note(ARP).s("sawtooth").lpf(saw.range(400, 6000).slow(8)).decay(0.12).sustain(0).gain(0.3).delay(0.25).pan(sine.fast(2)),
    note(ROOTS).s("sine").gain(0.35),
    s("bd*4").bank("RolandTR909").gain(0.75).mask("<0 0 0 0 1 1 1 0>"),
    s("<~ ~ ~ ~ ~ ~ sd*8 [sd*16 ~]>").bank("RolandTR909").gain(0.55),
    s("white*16").decay(0.08).sustain(0).hpf(saw.range(400, 9000).slow(8)).gain(saw.range(0, 0.28).slow(8))
  ).mask("<1!7 [1 0]>")],

  // BLOOM
  [16, stack(
    s("<cr ~ ~ ~ ~ ~ ~ ~>").bank("RolandTR909").gain(0.55).room(0.5),
    s("bd*4").bank("RolandTR909").gain(0.9).shape(0.25),
    s("bd*4").bank("RolandTR808").gain(0.65).lpf(160),
    s("~ cp ~ cp").bank("RolandTR909").gain(0.6).room(0.25),
    s("[~ oh]*4").bank("RolandTR909").gain(0.28),
    s("hh*16").bank("RolandTR909").gain("[0.12 0.25]*8"),
    note(ROOTS).struct("x*8").s("sawtooth").lpf(600).gain(pump).velocity(0.55),
    note(ROOTS).s("sine").gain(0.4),
    note(CHORDS).s("supersaw").lpf(3200).room(0.35).gain(pump).velocity(0.3),
    hook.s("supersaw").lpf(5000).gain(0.3).delay(0.25).delayfeedback(0.4).room(0.4),
    hook.s("steinway").gain(0.45).room(0.5),
    note(ARP).s("sawtooth").lpf(2500).decay(0.1).sustain(0).gain(0.15).pan(sine.fast(2))
  )]
)
