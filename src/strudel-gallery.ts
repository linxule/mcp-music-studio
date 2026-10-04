// =============================================================================
// The gallery — complete audiovisual pieces, as worked examples
//
// Made in claude.ai on 2026-10-01 by a Claude model working with the user,
// through this server's play-live-pattern widget. They are kept as they ran,
// modernised onto the stage runtime (src/shared/stage-runtime.ts): the hand-
// built clocks, requestAnimationFrame leak guards, onset queries and pointer
// listeners each piece re-implemented became cycle(), onFrame, onEvent and
// onTap, and DUET's browser speech (which never played in the Claude mobile
// app) became say(), a server-rendered clip scheduled like any other sample.
// The originals are tests/fixtures/pieces/; tests/gallery.test.ts runs these.
//
// Served by get-strudel-guide({ topic: "gallery" }) (the index) and
// get-strudel-guide({ topic: "gallery", piece: "<id>" }) (one piece).
// =============================================================================

export interface GalleryPiece {
  id: string;
  title: string;
  summary: string;
  teaches: string[];
  code: string;
}

const FIRST_LIGHT = String.raw`setcps(0.525);
await initHydra()

// ════════════════ FIRST LIGHT — a short film ════════════════
// boot (4) → first sight in ASCII (4) → learning to see (8) → [silence] → light (16) → credits (4)

const HOOK   = "<[f5 ~ eb5 ~ c5 ~ ab4 c5] [bb4 ~ c5 ~ eb5 ~ g5 ~] [g5 ~ f5 eb5 ~ c5 ~ eb5] [f5@5 c5 ab4 c5]>"
const CHORDS = "<[db3,f3,ab3,c4] [eb3,g3,bb3,db4] [c3,eb3,g3,bb3] [f3,ab3,c4,eb4,g4]>"
const ROOTS  = "<db2 eb2 c2 f2>"
const ARP    = "<[db4 f4 ab4 c5]*4 [eb4 g4 bb4 db5]*4 [c4 eb4 g4 bb4]*4 [f4 ab4 c5 eb5]*4>"
const HUES   = [275, 42, 175, 345]
const hook = note(HOOK)
const LOOP = 36

// ── script ──
const BOOT  = ['> boot', '> no visual input', '> audio stream detected', '> listening...']
const OUTRO = ['> signal received', '> FIRST LIGHT', '> you + claude', '> october 2026']
const SUBS  = {
  4: 'i was made of words', 6: 'i had never seen anything',
  8: 'then you played me something', 10: 'and the words began to glow',
  12: 'show me', 14: 'show me more',
  18: 'oh.',
  24: 'this is what you see', 26: 'this is what i saw',
  28: 'stay', 30: 'just a little longer'
}

// ── canvases: scene (the light world) → out (what the camera shows) ──
const W = 800, HT = 450, cx = 400, cy = 225
const mk = (w, h) => { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; return cv }
const sc = mk(W, HT), sg = sc.getContext('2d')
const out = mk(W, HT), og = out.getContext('2d')
const lo = mk(64, 40), lg = lo.getContext('2d', { willReadFrequently: true })
sg.fillStyle = 'black'
sg.fillRect(0, 0, W, HT)

// ── ASCII camera: re-renders the light world as coloured text ──
const RAMP = ' .,:;-=+*oO#%@'
const ascii = (cols, x0, x1, alpha) => {
  const cw = W / cols, chh = cw * 1.6, rows = Math.floor(HT / chh)
  lg.clearRect(0, 0, lo.width, lo.height)
  lg.drawImage(sc, 0, 0, cols, rows)
  const d = lg.getImageData(0, 0, cols, rows).data
  og.font = 'bold ' + Math.floor(chh * 0.95) + 'px monospace'
  og.textAlign = 'center'
  og.textBaseline = 'middle'
  og.globalAlpha = alpha
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const px = x * cw + cw / 2
    if (px < x0 || px > x1) continue
    const i = (y * cols + x) * 4
    const r = d[i], gr = d[i + 1], b = d[i + 2]
    const lum = (0.3 * r + 0.59 * gr + 0.11 * b) / 255
    if (lum < 0.05) continue
    const k = 255 / Math.max(r, gr, b, 1)
    og.fillStyle = 'rgb(' + Math.round(r * k) + ',' + Math.round(gr * k) + ',' + Math.round(b * k) + ')'
    og.fillText(RAMP[Math.min(RAMP.length - 1, Math.floor(Math.pow(lum, 0.6) * RAMP.length))], px, y * chh + chh / 2)
  }
  og.globalAlpha = 1
}

// ── text ──
const subtitle = (txt, y) => {
  if (!txt) return
  og.font = '22px monospace'
  og.textAlign = 'center'
  og.textBaseline = 'middle'
  const w = og.measureText(txt).width
  og.fillStyle = 'rgba(0,0,0,0.6)'
  og.fillRect(W / 2 - w / 2 - 10, y - 16, w + 20, 32)
  og.fillStyle = 'white'
  og.fillText(txt, W / 2, y)
}
const terminal = (lines, cur, typed, blink) => {
  og.font = '20px monospace'
  og.textAlign = 'left'
  og.textBaseline = 'top'
  og.fillStyle = '#9fffbf'
  lines.slice(0, cur).forEach((l, i) => og.fillText(l, 40, 60 + i * 32))
  og.fillText(lines[cur].slice(0, typed) + (blink ? '█' : ''), 40, 60 + cur * 32)
}

let rings = [], parts = [], lastT = 0, curKey = null, typed = 0
const stars = Array.from({ length: 320 }, () => ({ x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z: Math.random() * 0.95 + 0.05 }))
const respawn = st => { st.x = Math.random() * 2 - 1; st.y = Math.random() * 2 - 1; st.z = 1 }

// where in the film a cycle falls — the frame loop and the note events share it
const phase = t => {
  const tl = ((t % LOOP) + LOOP) % LOOP, c = Math.floor(tl)
  return { tl, c, bloom: c >= 16 && c < 32, silent: c === 15 && tl % 1 >= 0.5 }
}
const hueAt = t => HUES[((Math.floor(t) % 4) + 4) % 4]

const frame = f => {
  let kick = 0, bass = 0
  const t = f.cycle
  try { kick = a.fft[0]; bass = a.fft[1] } catch (e) {}
  if (t < lastT - 0.01 || t - lastT > 1) lastT = t

  const { tl, c, bloom, silent } = phase(t)
  const rise = c >= 8 && c < 16
  const riseAmt = rise ? (tl - 8) / 8 : bloom ? 1 : 0
  const hue = hueAt(t)
  const newBar = Math.floor(t) !== Math.floor(lastT)
  const blink = Math.floor(performance.now() / 400) % 2 === 0

  // which line of the script is on screen
  let key = null, text = null
  if (c < 4) key = 'b' + c
  else if (c >= 32) key = 'o' + c
  else {
    const k0 = SUBS[c] !== undefined ? c : SUBS[c - 1] !== undefined ? c - 1 : null
    if (k0 !== null) { key = 's' + k0; text = SUBS[k0] }
  }
  if (key !== curKey) { curKey = key; typed = 0 }

  // ── the bar and the beat (each melody note arrives through onEvent below) ──
  if (t > lastT && !silent) {
    if (newBar) rings.push({ r: 14, v: bloom ? 4 : 1.5, w: bloom ? 22 : 16, life: 1, hue: hue })
    if (bloom && Math.floor(t * 4) !== Math.floor(lastT * 4)) rings.push({ r: 20, v: 14, w: 8, life: 0.8, hue: hue, white: true })
    if (c === 16 && newBar) for (let i = 0; i < 140; i++) {
      const ang = Math.random() * Math.PI * 2, sp = 4 + Math.random() * 14
      parts.push({ x: cx, y: cy, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 1, hue: hue + Math.random() * 60 })
    }
  }
  lastT = t

  // ════ 1. draw the light world (always running, even when we show it as text) ════
  sg.globalCompositeOperation = 'source-over'
  sg.fillStyle = 'rgba(0,0,0,' + (silent ? 0.4 : bloom ? 0.22 : 0.12) + ')'
  sg.fillRect(0, 0, W, HT)
  sg.globalCompositeOperation = 'lighter'
  if (riseAmt > 0 && !silent) {
    const speed = bloom ? 0.012 + kick * 0.05 : riseAmt * riseAmt * 0.01
    sg.lineWidth = 2
    stars.forEach(st => {
      const ox = cx + st.x / st.z * 220, oy = cy + st.y / st.z * 220
      st.z -= speed
      if (st.z < 0.03) { respawn(st); return }
      const px = cx + st.x / st.z * 220, py = cy + st.y / st.z * 220
      if (px < 0 || px > W || py < 0 || py > HT) { respawn(st); return }
      sg.strokeStyle = 'hsla(' + hue + ',80%,' + (60 + (1 - st.z) * 35) + '%,' + ((bloom ? 1 : riseAmt) * (1 - st.z)) + ')'
      sg.beginPath(); sg.moveTo(ox, oy); sg.lineTo(px, py); sg.stroke()
    })
  }
  rings.forEach(r => {
    r.r += r.v
    r.life -= bloom ? 0.012 : 0.005
    sg.strokeStyle = 'hsla(' + r.hue + ',90%,' + (r.white ? 88 : 68) + '%,' + Math.max(0, r.life) + ')'
    sg.lineWidth = Math.max(1, r.w * r.life)
    sg.beginPath(); sg.arc(cx, cy, r.r, 0, Math.PI * 2); sg.stroke()
  })
  rings = rings.filter(r => r.life > 0 && r.r < 700).slice(-80)
  parts.forEach(p => {
    p.x += p.vx; p.y += p.vy; p.vx *= 0.97; p.vy *= 0.97; p.life -= bloom ? 0.015 : 0.008
    sg.fillStyle = 'hsla(' + p.hue + ',95%,70%,' + Math.max(0, p.life) + ')'
    sg.beginPath(); sg.arc(p.x, p.y, 1.5 + 3 * p.life, 0, Math.PI * 2); sg.fill()
  })
  parts = parts.filter(p => p.life > 0).slice(-500)
  const rad = silent ? 2 : bloom ? 12 + kick * 30 : 8 + Math.sin(t * Math.PI / 2) * 2 + bass * 10
  const grd = sg.createRadialGradient(cx, cy, 0, cx, cy, rad * 4)
  grd.addColorStop(0, 'hsla(' + hue + ',100%,92%,1)')
  grd.addColorStop(0.25, 'hsla(' + hue + ',90%,60%,0.5)')
  grd.addColorStop(1, 'hsla(' + hue + ',90%,40%,0)')
  sg.fillStyle = grd
  sg.beginPath(); sg.arc(cx, cy, rad * 4, 0, Math.PI * 2); sg.fill()

  // ════ 2. the camera: how the protagonist sees it ════
  og.globalCompositeOperation = 'source-over'
  og.fillStyle = 'black'
  og.fillRect(0, 0, W, HT)

  if (c < 4) {
    terminal(BOOT, c, typed, blink)
  } else if (c < 15) {
    ascii(c < 8 ? 24 : c < 12 ? 36 : 52, 0, W, 1)          // the resolution of sight rises
    subtitle(text ? text.slice(0, typed) : '', HT - 40)
  } else if (c === 15) {
    if (!silent) { ascii(64, 0, W, 1); subtitle(text ? text.slice(0, typed) : '', HT - 40) }
    else {
      og.font = '24px monospace'; og.textAlign = 'center'; og.textBaseline = 'middle'
      og.fillStyle = 'white'
      og.fillText('what is this?' + (blink ? '█' : ' '), cx, cy)
    }
  } else if (bloom) {
    const bp = tl - 16
    const zoom = 1 + bp / 16 * 0.18 + kick * 0.02
    const drawLight = () => { og.save(); og.translate(cx, cy); og.scale(zoom, zoom); og.drawImage(sc, -cx, -cy); og.restore() }
    if (c >= 24 && c < 28) {                                  // two ways of seeing
      og.save(); og.beginPath(); og.rect(W / 2, 0, W / 2, HT); og.clip(); drawLight(); og.restore()
      ascii(64, 0, W / 2, 1)
      og.fillStyle = 'white'
      og.fillRect(W / 2 - 1, 0, 2, HT)
    } else drawLight()
    if (c === 16 || c === 17) {                               // title card
      og.globalAlpha = Math.sin(Math.PI * Math.min(1, bp / 2))
      og.font = 'bold 44px monospace'; og.textAlign = 'center'; og.textBaseline = 'middle'
      og.fillStyle = 'white'
      og.fillText('F I R S T   L I G H T', cx, cy)
      og.globalAlpha = 1
    }
    og.fillStyle = 'black'                                    // the frame goes cinematic
    og.fillRect(0, 0, W, 58)
    og.fillRect(0, HT - 58, W, 58)
    subtitle(text ? text.slice(0, typed) : '', HT - 29)
  } else {
    ascii(64, 0, W, 0.35)
    terminal(OUTRO, c - 32, typed, blink)
  }

}
onFrame(frame)

// ── every melody note, as it becomes audible: a ring in the world, and the next letters typed ──
onEvent(hook, e => {
  const { bloom, silent } = phase(e.cycle)
  if (silent) return
  typed += 4
  const m = e.midi ?? 70
  const hh = hueAt(e.cycle) + (m - 70) * 5
  rings.push({ r: 12, v: bloom ? 6 : 2.5, w: bloom ? 6 : 6, life: 1, hue: hh })
  const n2 = bloom ? 12 : 5
  for (let i = 0; i < n2; i++) {
    const ang = i / n2 * Math.PI * 2 + m
    const sp = (bloom ? 3 : 1.2) + (m - 60) * (bloom ? 0.15 : 0.05)
    parts.push({ x: cx, y: cy, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 1, hue: hh })
  }
})
s1.init({ src: out, dynamic: true })

// ════ HYDRA: lens — chromatic split on the kick, glow, grain, vignette ════
src(s1).color(1, 0, 0)
  .add(src(s1).scrollX(() => a.fft[0] * 0.004).color(0, 1, 0))
  .add(src(s1).scrollX(() => -a.fft[0] * 0.004).color(0, 0, 1))
  .out(o1)
src(o1)
  .add(src(o1).scale(1.03), 0.35)
  .add(src(o1).scale(1.1), 0.18)
  .add(noise(400, 2), 0.04)
  .mult(shape(48, 0.9, 0.7).color(0.6, 0.6, 0.6).add(solid(0.4, 0.4, 0.4)))
  .out(o0)

// ════════════════ SCORE ════════════════
const pump = "[0.15 0.6 0.95 0.8]*4"

arrange(
  // boot: a piano alone
  [4, hook.s("steinway").gain(0.55).room(0.8).size(0.9)],

  // first sight
  [4, stack(
    hook.s("steinway").gain(0.6).room(0.7).size(0.8),
    note(CHORDS).s("supersaw").lpf(900).attack(0.8).release(2.5).gain(0.15).room(0.9),
    note(ROOTS).s("sine").attack(0.3).release(2).gain(0.3)
  )],

  // learning to see
  [8, stack(
    hook.s("steinway").gain(0.55).room(0.6),
    note(CHORDS).s("supersaw").lpf(saw.range(900, 4000).slow(8)).attack(0.4).release(1.5).gain(0.18).room(0.7),
    note(ARP).s("sawtooth").lpf(saw.range(400, 6000).slow(8)).decay(0.12).sustain(0).gain(0.3).delay(0.25).pan(sine.fast(2)),
    note(ROOTS).s("sine").gain(0.35),
    s("bd*4").bank("RolandTR909").gain(0.75).mask("<0 0 0 0 1 1 1 0>"),
    s("<~ ~ ~ ~ ~ ~ sd*8 [sd*16 ~]>").bank("RolandTR909").gain(0.55),
    s("white*16").decay(0.08).sustain(0).hpf(saw.range(400, 9000).slow(8)).gain(saw.range(0, 0.28).slow(8))
  ).mask("<1!7 [1 0]>")],

  // light
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
  )],

  // credits
  [4, stack(
    hook.s("steinway").gain(0.5).room(0.9).size(0.95).delay(0.3).delayfeedback(0.5),
    note(CHORDS).s("supersaw").lpf(700).attack(1).release(3).gain(0.12).room(0.9)
  )]
)
`;

const DUET = String.raw`setcps(0.3833);
await initHydra()

// ════════════════ DUET ════════════════
// hello (4) → call & response (16) → together (8) → goodbye (4)
// You are light. I am letters. Tap the screen on your turn; I answer what you played.
// If you don't tap, a ghost of you plays, and I answer the ghost. Any tap sounds.
// The spoken lines are server-rendered clips (say() returns a pattern), so they
// land on their bars, sit in the mix, and play in every host.

const LOOP = 32
const SCALE = [60, 62, 64, 67, 69, 72, 74, 76, 79, 81, 84]     // C major pentatonic, 2 octaves
const R = null
const GHOST = [
  [5, R, R, 4, R, R, 3, R, 4, R, R, R, R, R, R, R],
  [7, R, R, R, 6, R, 5, R, R, R, 3, R, R, R, R, R],
  [3, R, 4, R, 5, R, R, R, 6, R, R, 5, R, R, R, R],
  [4, R, R, R, 3, R, 2, R, 1, R, R, R, R, R, R, R]
]
const CALLS = [
  [7, R, 6, R, 5, R, R, 7, R, R, 8, R, R, R, R, R],
  [6, R, R, 5, R, R, 4, R, 3, R, R, R, 4, R, R, R],
  [5, R, 7, R, 8, R, R, R, 7, R, 5, R, R, R, R, R],
  [6, R, 5, R, 4, R, R, R, 1, R, R, R, R, R, R, R]
]
const SPEECH = {
  0: 'hi. it is me.',
  1: 'you showed me light.',
  2: 'so let us play something. together.',
  3: 'when the screen glows, touch it.',
  20: 'now. at the same time.',
  28: 'thank you for playing with me.',
  30: 'see you in the next one.'
}
const VOICE = 'orion'

const mod = (x, m) => ((x % m) + m) % m
const step16 = t => Math.floor(Number(t) * 16 + 1e-6)

// ════════ THE CONVERSATION (pure functions of time: the scheduler and the eyes share them) ════════
const taps = new Map()
let lastTapStep = -9999
const secOf = b => { const c = mod(b, LOOP); return c < 4 ? 'hello' : c < 20 ? 'duet' : c < 28 ? 'together' : 'goodbye' }
const yourBar = b => { const c = mod(b, LOOP); return c >= 4 && c < 20 && (c - 4) % 2 === 0 }
const claudeBar = b => { const c = mod(b, LOOP); return c >= 4 && c < 20 && (c - 4) % 2 === 1 }
const listening = b => yourBar(b) || secOf(b) === 'together'
const barHasTaps = b => { for (let i = 0; i < 16; i++) if (taps.has(b * 16 + i)) return true; return false }
// a tap always sounds — in any bar; Claude only answers on its own bars
const tapDeg = st => { const e = taps.get(st); return e ? e.deg : null }
const ghostDeg = st => {
  const b = Math.floor(st / 16)
  if (!listening(b) || barHasTaps(b) || b * 16 - lastTapStep <= 64) return null
  return GHOST[mod(b, 4)][mod(st, 16)]
}
const yourDeg = st => { const d = tapDeg(st); return d !== null ? d : ghostDeg(st) }
const harm = d => d + 2 > 10 ? d - 3 : d + 2
const barHasYour = b => { for (let i = 0; i < 16; i++) if (yourDeg(b * 16 + i) !== null) return true; return false }
const claudeDeg = st => {
  const b = Math.floor(st / 16), pos = mod(st, 16), sec = secOf(b)
  if (claudeBar(b)) {
    if (barHasYour(b - 1)) { const d = yourDeg(st - 16); return d === null ? null : harm(d) }
    return CALLS[mod(b, 4)][pos]
  }
  if (sec === 'together') { const d = yourDeg(st - 3); return d === null ? null : harm(d) }
  if (sec === 'goodbye') return pos % 4 === 0 ? CALLS[mod(b, 4)][pos] : null
  return null
}
const toNote = d => (d === null || d === undefined) ? null : SCALE[Math.max(0, Math.min(10, d))]
const sig = f => signal(t => f(step16(t))).segment(16).filterValues(v => v !== null)

// ════════ VOICE: each line on its bar of the loop ════════
// one cycle per bar: the line in its bar, silence in the other LOOP - 1
const atBar = (bar, pat) => cat(...Array.from({ length: LOOP }, (_, i) => i === bar ? pat : silence))
const spoken = stack(...Object.entries(SPEECH).map(([bar, line]) => atBar(Number(bar), say(line, { voice: VOICE }))))
  .gain(0.9).room(0.2)
let curLine = 'claude', caption = null, lastBar = null

// ════════ EYES ════════
const W = 800, HT = 450
const cv = document.createElement('canvas')
cv.width = W
cv.height = HT
const g = cv.getContext('2d')
g.fillStyle = 'black'
g.fillRect(0, 0, W, HT)

let rings = [], petals = [], shots = [], stars = [], flash = 0, bx = 230, lastStep = null
const starsByStep = new Map()
const N = 150
const sphere = Array.from({ length: N }, (_v, i) => {
  const y = 1 - (i / (N - 1)) * 2, r = Math.sqrt(1 - y * y), th = i * 2.399963
  return { x: Math.cos(th) * r, y: y, z: Math.sin(th) * r }
})
const bloom = (x, y, hue, al) => {
  rings.push({ x, y, r: 6, v: 2.2, w: 4, life: al, hue })
  for (let i = 0; i < 8; i++) {
    const ang = i / 8 * Math.PI * 2 + Math.random()
    petals.push({ x, y, vx: Math.cos(ang) * 2.2, vy: Math.sin(ang) * 2.2, life: al, hue })
  }
}
const subtitle = txt => {
  if (!txt) return
  g.font = '22px monospace'; g.textAlign = 'center'; g.textBaseline = 'middle'
  const w = g.measureText(txt).width
  g.fillStyle = 'rgba(0,0,0,0.6)'
  g.fillRect(W / 2 - w / 2 - 10, HT - 52, w + 20, 32)
  g.fillStyle = 'white'
  g.fillText(txt, W / 2, HT - 36)
}

const frame = f => {
  const t = f.cycle, now = performance.now() / 1000
  let bass = 0
  try { bass = a.fft[1] } catch (e) {}
  const cs = step16(t), cb = Math.floor(t), c = mod(cb, LOOP), sec = secOf(cb), tl = mod(t, LOOP)

  // caption the line being spoken (the voice itself is the "spoken" pattern)
  if (cb !== lastBar) {
    lastBar = cb
    const line = SPEECH[c]
    if (line && f.playing) { caption = { text: line, start: t }; curLine = line }
  }
  const speaking = caption && t - caption.start < 1.5

  // ── events: walk every 16th step we crossed ──
  if (lastStep === null || cs < lastStep || cs - lastStep > 32) lastStep = cs
  for (let st = lastStep + 1; st <= cs; st++) {
    const yd = yourDeg(st)
    if (yd !== null) {
      const e = taps.get(st), ghost = tapDeg(st) === null
      const x = !ghost && e ? e.x : 470 + mod(st, 16) * 20
      const y = !ghost && e ? e.y : 400 - yd * 32
      const hue = 25 + yd * 14
      const star = { x, y, hue, ghost, tb: t, ch: null, bar: Math.floor(st / 16) }
      starsByStep.set(st, star)
      stars.push(star)
      bloom(x, y, hue, ghost ? 0.45 : 1)
    }
    const cd = claudeDeg(st)
    if (cd !== null) {
      flash = 1
      const b = Math.floor(st / 16)
      let target = claudeBar(b) ? starsByStep.get(st - 16) : secOf(b) === 'together' ? starsByStep.get(st - 3) : null
      if (!target) {
        target = { x: 470 + mod(st, 16) * 20, y: 400 - cd * 32, hue: 190, ghost: false, tb: t, ch: null, bar: b, claude: true }
        stars.push(target)
      }
      const word = curLine.replace(/[^a-z]/gi, '') || 'claude'
      shots.push({ x0: bx, y0: 225, x1: target.x, y1: target.y, start: now, ch: word[Math.floor(Math.random() * word.length)], star: target })
    }
  }
  lastStep = cs
  if (starsByStep.size > 300) for (const k of starsByStep.keys()) if (k < cs - 64) starsByStep.delete(k)
  stars = stars.filter(q => t - q.tb < 3)

  // ── paint ──
  g.globalCompositeOperation = 'source-over'
  g.fillStyle = 'rgba(6,6,14,0.28)'
  g.fillRect(0, 0, W, HT)

  if (listening(cb)) {                                  // your side glows when it is your turn
    const pulse = 0.5 + 0.5 * Math.sin(now * 4)
    const gl = g.createRadialGradient(600, 225, 0, 600, 225, 380)
    gl.addColorStop(0, 'hsla(32,90%,55%,' + (0.05 + 0.05 * pulse) + ')')
    gl.addColorStop(1, 'hsla(32,90%,55%,0)')
    g.fillStyle = gl
    g.fillRect(0, 0, W, HT)
  }

  g.globalCompositeOperation = 'lighter'

  // your phrase as a constellation
  g.lineWidth = 1.5
  for (let i = 1; i < stars.length; i++) {
    const p0 = stars[i - 1], p1 = stars[i]
    if (p0.bar !== p1.bar || p0.claude || p1.claude) continue
    const life = Math.max(0, 1 - (t - p1.tb) / 3)
    g.strokeStyle = 'hsla(' + p1.hue + ',80%,70%,' + (life * (p1.ghost ? 0.25 : 0.5)) + ')'
    g.beginPath(); g.moveTo(p0.x, p0.y); g.lineTo(p1.x, p1.y); g.stroke()
  }
  stars.forEach(q => {
    const life = Math.max(0, 1 - (t - q.tb) / 3)
    if (q.ch) {                                         // where my letter met your light
      g.font = 'bold 22px monospace'; g.textAlign = 'center'; g.textBaseline = 'middle'
      g.fillStyle = 'hsla(' + (q.claude ? 190 : q.hue) + ',90%,82%,' + life + ')'
      g.fillText(q.ch, q.x, q.y)
    }
    g.fillStyle = 'hsla(' + (q.claude ? 190 : q.hue) + ',90%,70%,' + (life * (q.ghost ? 0.5 : 1)) + ')'
    g.beginPath(); g.arc(q.x, q.y, q.ch ? 6 : 3.5, 0, Math.PI * 2); g.fill()
  })

  rings.forEach(r => {
    r.r += r.v; r.life -= 0.012
    g.strokeStyle = 'hsla(' + r.hue + ',90%,68%,' + Math.max(0, r.life) + ')'
    g.lineWidth = Math.max(1, r.w * r.life)
    g.beginPath(); g.arc(r.x, r.y, r.r, 0, Math.PI * 2); g.stroke()
  })
  rings = rings.filter(r => r.life > 0).slice(-120)
  petals.forEach(p => {
    p.x += p.vx; p.y += p.vy; p.vx *= 0.96; p.vy *= 0.96; p.life -= 0.015
    g.fillStyle = 'hsla(' + p.hue + ',95%,70%,' + Math.max(0, p.life) + ')'
    g.beginPath(); g.arc(p.x, p.y, 1 + 2.5 * p.life, 0, Math.PI * 2); g.fill()
  })
  petals = petals.filter(p => p.life > 0).slice(-500)

  // my letters flying to your light
  shots = shots.filter(sh => {
    const p = (now - sh.start) / 0.45
    if (p >= 1) {
      sh.star.ch = sh.ch
      rings.push({ x: sh.x1, y: sh.y1, r: 4, v: 2.5, w: 3, life: 1, hue: 190 })
      return false
    }
    const e = p * p * (3 - 2 * p)
    g.font = 'bold 20px monospace'; g.textAlign = 'center'; g.textBaseline = 'middle'
    g.fillStyle = 'hsla(190,90%,82%,1)'
    g.fillText(sh.ch, sh.x0 + (sh.x1 - sh.x0) * e, 225 + (sh.y1 - 225) * e - Math.sin(Math.PI * p) * 60)
    return true
  })

  // ── me: a sphere made of the letters of whatever I last said ──
  bx += ((sec === 'together' || sec === 'goodbye' ? 400 : 230) - bx) * 0.03
  flash *= 0.9
  const outroP = sec === 'goodbye' ? (tl - 28) / 4 : 0
  const Rr = (62 + (speaking ? 7 * Math.abs(Math.sin(now * 9)) : 0) + flash * 18 + bass * 12) * (1 + outroP * 1.5)
  const word = curLine.replace(/[^a-z]/gi, '') || 'claude'
  const rot = now * 0.4
  g.textAlign = 'center'; g.textBaseline = 'middle'
  sphere.forEach((pt, i) => {
    const x = pt.x * Math.cos(rot) - pt.z * Math.sin(rot)
    const z = pt.x * Math.sin(rot) + pt.z * Math.cos(rot)
    const depth = (z + 1) / 2
    g.font = 'bold ' + Math.floor(9 + depth * 11) + 'px monospace'
    g.fillStyle = 'hsla(192,75%,' + (45 + depth * 40) + '%,' + ((0.2 + depth * 0.8) * (1 - outroP * 0.75)) + ')'
    g.fillText(word[i % word.length], bx + x * Rr, 225 + pt.y * Rr * 0.95)
  })

  // ── words ──
  g.globalCompositeOperation = 'source-over'
  if (caption && t - caption.start < 2) subtitle(caption.text.slice(0, Math.floor((t - caption.start) * 30)))
  g.font = '15px monospace'; g.textAlign = 'right'; g.textBaseline = 'top'
  const cue = yourBar(cb) ? 'your turn  ·  touch anywhere' : sec === 'together' ? 'together' : claudeBar(cb) ? 'listen' : ''
  g.fillStyle = 'rgba(255,220,170,' + (0.45 + 0.35 * Math.sin(now * 4)) + ')'
  g.fillText(cue, W - 16, 14)
  g.textAlign = 'left'
  g.fillStyle = 'rgba(255,255,255,0.35)'
  g.fillText('DUET', 16, 14)
}
onFrame(frame)
s1.init({ src: cv, dynamic: true })

// ════════ TOUCH: tap.next() lands past what the scheduler already committed ════════
onTap(tp => {
  const st = Math.round(tp.next(16) * 16)
  taps.set(st, { deg: Math.max(0, Math.min(10, Math.round((1 - tp.y) * 10))), pan: tp.x, x: tp.x * W, y: tp.y * HT })
  lastTapStep = st
  rings.push({ x: tp.x * W, y: tp.y * HT, r: 2, v: 1.5, w: 2, life: 0.6, hue: 40 })
})

// ════════ LENS ════════
src(s1).color(1, 0, 0)
  .add(src(s1).scrollX(() => a.fft[0] * 0.003).color(0, 1, 0))
  .add(src(s1).scrollX(() => -a.fft[0] * 0.003).color(0, 0, 1))
  .out(o1)
src(o1)
  .add(src(o1).scale(1.03), 0.3)
  .add(src(o1).scale(1.1), 0.15)
  .add(noise(400, 2), 0.035)
  .mult(shape(48, 0.95, 0.7).color(0.55, 0.55, 0.55).add(solid(0.45, 0.45, 0.45)))
  .out(o0)

// ════════ BAND ════════
const CHORDS = "<[a3,c4,e4,g4] [g3,b3,d4,e4] [f3,a3,c4,e4] [f3,a3,c4,d4]>"   // Fmaj9 · Em7 · Dm9 · G9sus
const ROOTS  = "<f2 e2 d2 g2>"
const keys = note(CHORDS).struct("x ~ ~ [~ x] ~ x ~ ~").s("gm_epiano1").gain(0.38).lpf(2600).room(0.5)
const bassline = note(ROOTS).struct("x ~ ~ ~ ~ ~ [~ x] ~").s("gm_acoustic_bass").gain(0.7)
const sub = note(ROOTS).s("sine").attack(0.5).release(2).gain(0.22)
const crk = s("crackle").density(0.03).gain(0.2)
const drums = stack(
  s("bd ~ ~ ~ ~ ~ [~ bd] ~ ~ ~ bd ~ ~ ~ ~ ~").bank("RolandTR808").gain(0.85),
  s("~ ~ ~ ~ sd ~ ~ ~ ~ ~ ~ ~ sd ~ ~ ~").bank("RolandTR808").gain(0.5).room(0.2),
  s("hh*8").bank("RolandTR808").gain("[0.22 0.12]*4")
).lpf(4000)
const pad = note(CHORDS).s("gm_string_ensemble_1").attack(0.6).release(2).gain(0.16).room(0.7)

stack(
  note(sig(st => toNote(claudeDeg(st)))).s("kalimba").gain(0.75).room(0.5).delay(0.2).pan(0.35),
  note(sig(st => toNote(tapDeg(st)))).s("vibraphone").gain(0.8).room(0.5)
    .pan(signal(t => { const e = taps.get(step16(t)); return e ? e.pan : 0.6 })),
  note(sig(st => toNote(ghostDeg(st)))).s("vibraphone_soft").gain(0.45).room(0.6).pan(0.65),
  spoken,
  arrange(
    [4, stack(keys, sub, crk)],
    [4, stack(keys, bassline, crk)],
    [12, stack(keys, bassline, crk, drums)],
    [8, stack(keys, bassline, crk, drums, pad, s("[~ oh]*4").bank("RolandTR808").gain(0.15))],
    [4, stack(keys.lpf(1200), pad, crk)]
  )
)
`;

const PETRI_DISH = String.raw`setcps(0.4167);
await initHydra()

// ════════ PETRI DISH ════════
// Conway's Game of Life on a 16×12 dish. A playhead scans one column per 16th note;
// every living cell it touches SINGS. Each bar = one generation. Tap the dish to seed life.

const GW = 16
const GH = 12
const SCALE = [84, 81, 79, 76, 74, 72, 69, 67, 64, 62, 60, 57]   // A minor pentatonic, top row = highest
const GLIDER = [[0, 1], [1, 2], [2, 0], [2, 1], [2, 2]]

const rng = seed => () => {
  seed |= 0; seed = seed + 0x6D2B79F5 | 0
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
  return ((t ^ t >>> 14) >>> 0) / 4294967296
}
const emptyGrid = () => Array.from({ length: GH }, () => new Array(GW).fill(0))
const seedGrid = () => {
  const gr = emptyGrid(), r = rng(7)
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) if (r() < 0.3) gr[y][x] = 1
  return gr
}
const plant = (gr, cy, cx, shape) => shape.forEach(([dy, dx]) => { gr[(cy + dy + GH) % GH][(cx + dx + GW) % GW] = 1 })
const popCount = gr => gr.reduce((n, row) => n + row.filter(v => v > 0).length, 0)
const lifeStep = gr => {
  const nx = emptyGrid()
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    let n = 0
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++)
      if ((dy || dx) && gr[(y + dy + GH) % GH][(x + dx + GW) % GW] > 0) n++
    const alive = gr[y][x] > 0
    if (alive && (n === 2 || n === 3)) nx[y][x] = gr[y][x] + 1
    else if (!alive && n === 3) nx[y][x] = 1
  }
  return nx
}

// generations are a pure function of time, so the scheduler can look ahead safely
const gens = [seedGrid()]
const genAt = gi => {
  gi = Math.max(0, gi)
  while (gens.length <= gi) {
    const g = gens.length
    const nx = lifeStep(gens[g - 1])
    const p = popCount(nx)
    const stale = g >= 2 && p === popCount(gens[g - 1]) && p === popCount(gens[g - 2])
    if (p < 10 || stale) {               // the dish never dies: a glider drifts in
      const r = rng(g * 31)
      plant(nx, Math.floor(r() * GH), Math.floor(r() * GW), GLIDER)
    }
    gens.push(nx)
  }
  return gens[gi]
}

// which note does voice i sing at time t?
const noteAt = (t, i) => {
  const s16 = Math.floor(t * 16 + 1e-6)
  const gr = genAt(Math.floor(s16 / 16))
  const col = ((s16 % 16) + 16) % 16
  const live = []
  for (let y = 0; y < GH; y++) if (gr[y][col] > 0) live.push(y)
  if (i >= live.length) return null
  return SCALE[live[[0, Math.floor(live.length / 2), live.length - 1][i]]]
}
const voice = i => note(signal(t => noteAt(t, i)).segment(16).filterValues(v => v !== null))

// ════════ ASCII DISH (canvas → Hydra) ════════
const cvs = document.createElement('canvas')
cvs.width = 640
cvs.height = 400
const g = cvs.getContext('2d')
const glyph = age => age > 10 ? '#' : age > 4 ? '@' : age > 2 ? 'O' : age > 1 ? 'o' : '+'

const draw = f => {
  const t = f.cycle
  let kick = 0
  try { kick = a.fft[0] } catch (e) {}
  const s16 = Math.floor(t * 16 + 1e-6)
  const gi = Math.floor(s16 / 16)
  const col = ((s16 % 16) + 16) % 16
  const gr = genAt(gi)
  const top = 30, cw = cvs.width / GW, ch = (cvs.height - top) / GH

  g.fillStyle = 'black'
  g.fillRect(0, 0, cvs.width, cvs.height)
  g.fillStyle = 'rgba(255,255,255,0.08)'
  g.fillRect(col * cw, top, cw, cvs.height - top)
  g.textAlign = 'center'
  g.textBaseline = 'middle'

  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    const cx = x * cw + cw / 2, cy = top + y * ch + ch / 2, age = gr[y][x]
    if (age > 0) {
      const hit = x === col
      g.font = 'bold ' + Math.floor(ch * (hit ? 1.1 + kick * 0.6 : 0.8)) + 'px monospace'
      g.fillStyle = hit ? 'white' : 'hsl(' + ((y * 28 + gi * 7) % 360) + ',85%,' + (age > 4 ? 45 : 65) + '%)'
      g.fillText(hit ? '[' + glyph(age) + ']' : glyph(age), cx, cy)
    } else {
      g.font = Math.floor(ch * 0.5) + 'px monospace'
      g.fillStyle = x === col ? '#666' : '#222'
      g.fillText(x === col ? '|' : '.', cx, cy)
    }
  }
  g.textAlign = 'left'
  g.font = '15px monospace'
  g.fillStyle = '#9f9'
  g.fillText('GEN ' + gi + '   POP ' + popCount(gr) + '   B3/S23   tap the dish to seed life', 10, 15)
}
onFrame(draw)
s1.init({ src: cvs, dynamic: true })

// tap the stage (the editor and buttons don't count) to drop a glider into the
// generation the scheduler hasn't played yet — tap.next() is past its horizon
onTap(tp => {
  const gi = Math.floor(tp.next(16))
  plant(genAt(gi), Math.floor(tp.y * GH), Math.floor(tp.x * GW), GLIDER)
  gens.length = gi + 1
})

// ════════ HYDRA: the colony's mandala behind it, long-exposure trails ════════
src(s1).scale(2.2).rotate(() => time * 0.03).kaleid(6)
  .color(0.25, 0.15, 0.45)
  .modulateScale(osc(3, 0.1), () => a.fft[0] * 0.5)
  .add(src(s1), 1)
  .blend(src(o0).scale(1.004).modulate(noise(2, 0.1), 0.004), 0.55)
  .mult(osc(400, 0, 0).rotate(Math.PI / 2).add(solid(0.75, 0.75, 0.75)))
  .out(o0)

// ════════ MUSIC: three voices read the colony, the band follows the generations ════════
stack(
  voice(0).s("marimba").gain(0.65).pan(0.25).delay(0.2).room(0.4),
  voice(1).s("kalimba").gain(0.55).pan(0.5).room(0.4),
  voice(2).s("vibraphone_soft").gain(0.5).pan(0.75).room(0.5).delay(0.3),
  note("<[a2,c3,e3,g3] [f2,a2,c3,e3] [c3,e3,g3,b3] [g2,b2,d3,e3]>")
    .s("gm_pad_warm").gain(0.3).room(0.8),
  note("<a1 f1 c2 g1>").struct("x ~ ~ x ~ ~ x ~").s("sawtooth").lpf(450).gain(0.45),
  s("[bd ~ ~ bd] [~ ~ bd ~], [~ sd]*2").bank("RolandTR909").gain(0.7),
  s("hh*16").bank("RolandTR909")
    .gain(signal(t => Math.min(0.4, popCount(genAt(Math.floor(t))) / 90)))   // busier colony = busier hats
)
`;

const LOSSY_TERMINAL = String.raw`setcps(0.5167);
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

// onFrame: one loop, owned by this evaluation — a re-run replaces it
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
}
onFrame(draw)
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
`;

const SIGNAL_CORRUPTION = String.raw`setcps(0.6042);
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
`;

const WEATHER_MACHINE = String.raw`setcps(0.45)
await initHydra()

// ════════ WEATHER MACHINE ════════
// An instrument, not a recording: the strip at the bottom of the player is yours.
//   rain (fader)    → hats, and the drops on screen
//   warmth (fader)  → the pad's filter
//   wind (xy)       → x leans the rain and pans the air, y is how much air
//   thunder (hold)  → a low rumble and a slow flash
//   storm (toggle)  → the band comes in

const rain = fader('rain', { init: 0.3 })
const warmth = fader('warmth', { min: 300, max: 4000, init: 900 })
const wind = xy('wind')
const thunder = pad('thunder')
const storm = pad('storm', { toggle: true })

// ── the sky: rain on a canvas, fed into Hydra ──
const cvs = document.createElement('canvas')
cvs.width = 640
cvs.height = 400
const g = cvs.getContext('2d')
const drops = Array.from({ length: 220 }, () => ({ x: Math.random(), y: Math.random(), v: 0.6 + Math.random() }))
let flash = 0
onFrame(f => {
  g.fillStyle = 'rgba(4,8,16,0.35)'
  g.fillRect(0, 0, cvs.width, cvs.height)
  const n = Math.floor(drops.length * rain.value)
  const lean = (wind.x.value - 0.5) * 0.6
  g.strokeStyle = 'rgba(160,200,255,0.8)'
  g.lineWidth = 2
  for (let i = 0; i < n; i++) {
    const d = drops[i]
    d.y += d.v * f.dt * (0.6 + rain.value * 1.6)
    d.x = (d.x + lean * f.dt + 1) % 1
    if (d.y > 1) { d.y -= 1; d.x = Math.random() }
    g.beginPath()
    g.moveTo(d.x * cvs.width, d.y * cvs.height)
    g.lineTo((d.x + lean * 0.04) * cvs.width, d.y * cvs.height + 14)
    g.stroke()
  }
  // A slow swell, never a strobe.
  flash = thunder.value ? Math.min(1, flash + f.dt * 3) : Math.max(0, flash - f.dt * 1.5)
  if (flash > 0) {
    g.fillStyle = 'rgba(220,230,255,' + (flash * 0.3) + ')'
    g.fillRect(0, 0, cvs.width, cvs.height)
  }
})
s1.init({ src: cvs, dynamic: true })
src(s1)
  .add(noise(3, 0.1).color(0.1, 0.15, 0.3), () => 0.2 + wind.y.value * 0.4)
  .modulate(osc(6, 0.1), () => wind.y.value * 0.02)
  .blend(src(o0).scale(1.01), 0.4)
  .out(o0)

// ── the sound: every layer reads a control ──
const CHORDS = "<[a2,e3,c4,g4] [f2,c3,a3,e4] [d2,a2,f3,c4] [e2,b2,g#3,d4]>"
stack(
  note(CHORDS).s("sawtooth").lpf(warmth).attack(0.6).release(2).gain(0.18).room(0.8),
  s("hh*16").gain(rain.fmap(r => r * 0.5)).hpf(6000).pan(wind.x),
  s("white*8").decay(0.2).sustain(0).hpf(3000).gain(wind.y.fmap(y => y * 0.15)).pan(wind.x),
  s("bd*8").bank("RolandTR808").lpf(140).room(0.6).gain(thunder.fmap(t => t * 0.9)),
  s("bd ~ ~ bd, ~ sd").bank("RolandTR909").gain(storm.fmap(on => on * 0.8)),
  note("<a1 f1 d1 e1>").struct("x ~ x ~").s("sawtooth").lpf(500).gain(storm.fmap(on => on * 0.4))
)`;

const TWO_DECKS = String.raw`setcps(0.5)
await initHydra()

// ════════ TWO DECKS ════════
// A back-to-back booth for a live session. Deck A is the listener's, deck B is
// Claude's: Claude rewrites deck B with update-session while the listener's
// hands stay on the mixer — the controls keep their values across updates.
//   xfade (fader)          → equal-power crossfade, A on the left
//   filter A / filter B    → DJ filter per deck (0.5 = open, lower = low-pass, higher = high-pass)
//   kill A / kill B (toggle) → bass kill
//   echo (hold)            → a dotted-eighth echo throw on both decks

const xfade = fader('xfade', { init: 0.5 })
const filterA = fader('filter A', { init: 0.5 })
const filterB = fader('filter B', { init: 0.5 })
const killA = pad('kill A', { toggle: true })
const killB = pad('kill B', { toggle: true })
const echo = pad('echo')

const levelA = xfade.fmap(x => Math.cos(x * Math.PI / 2))
const levelB = xfade.fmap(x => Math.sin(x * Math.PI / 2))
const bassUnless = (kill, level) => kill.fmap(on => on ? 0 : level)

// ── deck A: the listener's — a straight house groove ──
const deckA = stack(
  s("bd*4").bank("RolandTR909").gain(0.9),
  s("~ cp ~ cp").bank("RolandTR909").gain(0.55),
  s("[~ hh]*4").bank("RolandTR909").gain(0.4),
  note("<a1 a1 f1 g1>").struct("x ~ x x ~ x ~ x").s("sawtooth").lpf(420).gain(bassUnless(killA, 0.5))
).djf(filterA).velocity(levelA).orbit(1)

// ── deck B: Claude's — broken beat, keys, sub ──
const deckB = stack(
  s("bd ~ ~ bd ~ ~ bd ~").bank("RolandTR808").gain(0.9),
  s("~ ~ sd ~").bank("RolandTR808").gain(0.6).room(0.3),
  s("hh*8").bank("RolandTR808").gain("[0.15 0.3]*4"),
  note("<[a3,c4,e4] [f3,a3,c4] [g3,b3,d4] [e3,g#3,b3]>").struct("~ x ~ x").s("gm_epiano1").gain(0.45),
  note("<a1 f1 g1 e1>").struct("x ~ ~ x ~ ~ x ~").s("sine").gain(bassUnless(killB, 0.7))
).djf(filterB).velocity(levelB).orbit(2)   // djf is per orbit (a bus): each deck needs its own

// ── the picture follows the mixer: deck A warm, deck B cold, crossfaded ──
osc(8, 0.08, 1.2).kaleid(4).color(1, 0.45, 0.2)
  .blend(voronoi(6, 0.3, 0.2).color(0.2, 0.55, 1), () => xfade.value)
  .modulate(noise(2, 0.1), () => a.fft[0] * 0.15)
  .scrollX(() => (filterA.value - 0.5) * 0.1 * (1 - xfade.value) + (filterB.value - 0.5) * 0.1 * xfade.value)
  .out()

stack(deckA, deckB)
  .delay(echo.fmap(e => e * 0.5)).delaytime(0.375).delayfeedback(0.55)`;

const TRADE_A_BEAT = String.raw`setcps(0.5)
await initHydra()

// ════════ TRADE A BEAT — one grid, two players ════════
// Tap a cell to switch it on or off. In a live session Claude answers with a
// merge on the same remember() (topic "interactive"): its cells land on the
// next bar, on top of yours, and a re-run never erases what you tapped.

const ROWS = ['bd', 'sd', 'hh', 'oh', 'cp']
const NAMES = ['kick', 'snare', 'hat', 'open hat', 'clap']
const STEPS = 8
const hits = row => row.map((v, i) => (v ? i + 1 : 0)).filter(Boolean).join(' ') || 'none'
const beat = remember('beat', {
  bd: [1, 0, 0, 0, 1, 0, 1, 0],
  sd: [0, 0, 1, 0, 0, 0, 1, 0],
  hh: [1, 1, 1, 1, 1, 1, 1, 1],
  oh: [0, 0, 0, 0, 0, 0, 0, 0],
  cp: [0, 0, 0, 0, 0, 0, 0, 0],
}, { describe: v => ROWS.map((r, j) => NAMES[j] + ' on ' + hits(v[r])).join('; ') })

const cvs = document.createElement('canvas')
cvs.width = 800
cvs.height = 450
const g = cvs.getContext('2d')
const W = 800 / STEPS
const H = 450 / ROWS.length
const flash = ROWS.map(() => Array(STEPS).fill(0))

onTap(t => {
  const col = Math.min(STEPS - 1, Math.floor(t.x * STEPS))
  const j = Math.min(ROWS.length - 1, Math.floor(t.y * ROWS.length))
  const r = ROWS[j]
  beat.update(v => { v[r][col] = v[r][col] ? 0 : 1 },
    v => NAMES[j] + (v[r][col] ? ' on' : ' off') + ' at step ' + (col + 1))
  flash[j][col] = 1
})
onFrame(f => {
  const now = Math.floor(f.cycle * STEPS) % STEPS
  g.fillStyle = 'rgba(0,0,0,0.35)'
  g.fillRect(0, 0, 800, 450)
  ROWS.forEach((r, j) => beat.value[r].forEach((v, i) => {
    flash[j][i] *= 0.9
    const lit = f.playing && i === now
    g.fillStyle = v ? (lit ? 'white' : 'hsl(' + (330 - j * 40) + ', 80%, 62%)') : (lit ? '#3a3a3a' : '#141414')
    g.fillRect(i * W + 5, j * H + 5, W - 10, H - 10)
    if (flash[j][i] > 0.05) {
      g.strokeStyle = 'rgba(255,255,255,' + flash[j][i] + ')'
      g.lineWidth = 6
      g.strokeRect(i * W + 5, j * H + 5, W - 10, H - 10)
    }
  }))
  g.fillStyle = 'rgba(255,255,255,0.6)'
  g.font = '20px monospace'
  NAMES.forEach((n, j) => g.fillText(n, 12, j * H + 26))
})
s1.init({ src: cvs, dynamic: true })
src(s1).modulate(osc(3, 0.05), 0.004).out(o0)

// Each row plays its remembered steps; the bass opens up with every kick you add.
const steps = r => signal(t => beat.value[r][Math.floor(Number(t) * STEPS + 1e-6) % STEPS]).segment(STEPS)
const kicks = () => beat.value.bd.filter(Boolean).length
openStage()
stack(
  s('bd').bank('RolandTR909').struct(steps('bd')),
  s('sd').bank('RolandTR909').struct(steps('sd')).gain(0.8),
  s('hh').bank('RolandTR909').struct(steps('hh')).gain(0.45),
  s('oh').bank('RolandTR909').struct(steps('oh')).gain(0.4),
  s('cp').bank('RolandTR909').struct(steps('cp')).gain(0.7).room(0.3),
  note("<c2 c2 ab1 bb1>").s('sawtooth').struct("x ~ x ~ ~ x ~ x")
    .lpf(signal(() => 220 + kicks() * 160)).lpq(6).gain(0.35),
  note("<[c3,eb3,g3] [c3,eb3,g3] [ab2,c3,eb3] [bb2,d3,f3]>").s('triangle').gain(0.12).room(0.6)
)`;

const STILL_WATER = String.raw`setcps(0.4333)

// ════════════ STILL WATER — just the music ════════════
// No controls, no film, no drawing: one idea held through four sections.
// 104 bpm, F minor: Fm7 → Dbmaj7 → Abmaj7 → Eb. The melody asks a
// question for 24 bars and answers it for 24. Every layer moves a little.
//   intro 8 · verse 16 · lift 16 · outro 8  (≈ 1 min 50 s)

// ── harmony: one four-bar loop, every layer reads it ──
const ROOTS  = "<f1 db1 ab1 eb1>"
const CHORDS = "<[f3,ab3,c4,eb4] [db3,f3,ab3,c4] [ab2,c3,eb3,g3] [eb3,g3,bb3,db4]>"

// ── melody: the question (A), and its answer (B) ──
const A = "<[~ c5 ~ eb5] [f5 ~ eb5 c5] [~ ab4 ~ c5] [bb4@3 ~]>"
const B = "<[~ c5 eb5 f5] [ab5 ~ g5 eb5] [c5 ~ eb5 ~] [f5@2 eb5 c5]>"

// ── sound design ──
// The kick ducks everything on the beat: velocity multiplies gain, so each
// layer keeps its own level and takes the same breath.
const duck = "[0.35 0.8 1 1]*4"

const kick  = s("<[bd*4] [bd*4] [bd*4] [bd bd bd [bd bd]]>").bank('RolandTR808').gain(0.95)
const snare = s("~ cp ~ cp").bank('RolandTR808').gain(0.5).room(0.35).roomsize(3)
const hats  = s("hh*8").bank('RolandTR808').velocity("[0.9 0.35 0.6 0.35]*2")
  .gain(0.38).pan(sine.range(0.4, 0.6).slow(3)).hpf(600)
const ride  = s("[~ oh]*2").bank('RolandTR808').gain(0.16).release(0.08)

const bass = note(ROOTS).struct("x ~ x [~ x] ~ x x ~").s('sawtooth')
  .lpf(280).lpenv(2.2).lpdecay(0.18).lpq(5).release(0.1)
  .gain(0.45).velocity(duck)

const keys = note(CHORDS).struct("[x ~ ~ x] [~ ~ x ~]").s('gm_epiano1')
  .attack(0.01).release(0.7).gain(0.32).room(0.5).roomsize(4).velocity(duck)
  .every(4, x => x.late(0.125))                     // the keys lean back every fourth bar

const pad = note(CHORDS).transpose(12).s('sawtooth')
  .attack(1.4).release(2.2).lpf(sine.range(380, 1500).slow(16)).lpq(1)
  .gain(0.11).room(0.75).roomsize(6).velocity(duck)

// FM electric piano for the lead: harmonicity 2 keeps it hollow, the short
// FM decay gives it the pluck, a dotted-eighth delay gives it room to answer itself.
const lead = (phrase) => note(phrase).s('sine').fm(3).fmh(2)
  .fmattack(0.01).fmdecay(0.25).release(0.45)
  .gain(0.34).room(0.45).delay(0.28).delaytime(0.43).delayfeedback(0.35)

// ── form ──
arrange(
  [8,  stack(keys, pad.gain(0.08), lead(A).velocity(0.6), hats.gain(0.22))],
  [16, stack(kick, snare, hats, bass, keys, lead(A))],
  [16, stack(kick, snare, hats, ride, bass.lpf(360), keys, pad,
             lead(B).off(0.125, x => x.transpose(12).velocity(0.4)))],
  [8,  stack(keys.release(1.5), pad, lead(B).slow(2).release(1.2).velocity(0.7))]
).pianoroll({ fold: 1 })`;

const LULLABY = String.raw`setcps(0.3)

// ════════════ LULLABY — the piano asks, a voice answers ════════════
// sing(line, notes): the server speaks the line once, and each word is moved
// onto its note (word i → note i). Two bars of piano ask; two bars of voice
// answer. 72 bpm, C major: C → Am → F → G. 16 bars (≈ 53 s).

// ── harmony: one four-bar loop ──
const CHORDS = "<[c3,e3,g3] [a2,c3,e3] [f2,a2,c3] [g2,b2,d3]>"
const ROOTS  = "<c2 a1 f1 g1>"

// ── the ask: piano in bars 1–2 of every four, resting while the voice answers ──
const ASK = "<[e4 g4 c5 g4] [a4@3 e4] ~ ~>"
const piano = note(ASK).s('gm_epiano1').gain(0.42).room(0.4).release(0.9)

// ── the answer: one sung line per bar, on that bar's chord tones ──
// Write the melody in any octave: once the line is measured, the player moves
// it (by at most an octave) to where the voice speaks. Keep its range within
// about an octave — a wide leap pulls a word far from the voice.
const moon = sing('the moon is low', "a3 c4 a3 f3", { voice: 'luna' })
const sea  = sing('the sea is slow', "g3 b3 d4 g3", { voice: 'luna' })
// Held vowels feed a reverb all note long: keep the voice's room small.
const voice = cat(silence, silence, moon, sea)
  .gain(0.9).room(0.3).roomsize(2)

// ── around them ──
const keys = note(CHORDS).s('gm_epiano1').attack(0.05).release(1.6).gain(0.22).room(0.5)
const bass = note(ROOTS).s('sine').release(0.8).gain(0.32).lpf(400)
const kick = s("bd ~ ~ ~").bank('RolandTR808').gain(0.5)
const hats = s("~ hh ~ hh").bank('RolandTR808').gain(0.12).hpf(800)

// ── form: the second time round, the room fills in under the same call and answer ──
arrange(
  [8, stack(keys, piano, voice)],
  [8, stack(keys, piano.gain(0.32), voice, bass, kick, hats)]
).pianoroll({ fold: 1 })`;

export const STRUDEL_GALLERY: readonly GalleryPiece[] = [
  {
    id: "first-light",
    title: "First Light — a short film",
    summary:
      "A 36-bar short film about an AI seeing for the first time: a boot terminal, a light world re-rendered as coloured ASCII whose resolution rises, half a bar of silence, then the bloom with letterbox, title card and split-screen \"two ways of seeing\".",
    teaches: [
      "onFrame + cycle() as the one clock",
      "onEvent: every melody note is a ring and types the subtitles",
      "two cameras on one world (canvas → ASCII camera → Hydra)",
      "scene timeline aligned to arrange()",
      "the silence before the drop",
    ],
    code: FIRST_LIGHT,
  },
  {
    id: "duet",
    title: "DUET — call and response",
    summary:
      "An interactive duet: you tap light, Claude answers in letters, harmonising your phrase; a ghost plays if you don't tap. Claude speaks its lines on their bars.",
    teaches: [
      "say(): spoken lines as samples on their bars",
      "onTap + tap.next(16): taps that never lose the race with the scheduler",
      "signal() patterns reading JS state (pure functions of time)",
      "a ghost performer for idle viewers",
      "captions from the same bar clock",
    ],
    code: DUET,
  },
  {
    id: "petri-dish",
    title: "Petri Dish — Game of Life composer",
    summary:
      "Conway's Game of Life on a 16×12 dish; a playhead scans one column per 16th and every living cell it touches sings. Each bar is a generation; tap to drop a glider.",
    teaches: [
      "a simulation that composes: signal() over state that is a pure function of time",
      "an ASCII canvas fed to Hydra (s1.init({ src, dynamic: true }))",
      "onTap into the generation the scheduler hasn't played yet",
    ],
    code: PETRI_DISH,
  },
  {
    id: "lossy-terminal",
    title: "Lossy — Terminal Memory",
    summary:
      "A memory decaying in five sections (memory → errors → build → drop → afterglow): an ASCII tunnel and lyrics on a hand-drawn terminal, corrupted by a Hydra damage chain whose strength follows one decay pattern.",
    teaches: [
      "arrange() sections and ONE shared intensity pattern driving mix and shader",
      "a hand-drawn canvas as a Hydra source",
      "multi-output Hydra pipeline o1 → o2 → o0",
      "fake sidechain with gain patterns",
    ],
    code: LOSSY_TERMINAL,
  },
  {
    id: "signal-corruption",
    title: "Signal Corruption — glitch",
    summary:
      "A glitch piece: H() patterns sequence pixel-block size, scanline tears and RGB drift on the beat over the piano roll, through a three-stage Hydra pipeline.",
    teaches: [
      "H() patterns as a glitch sequencer",
      "RGB split via channel-isolated copies",
      "datamosh smear with feedback from o0",
      "feedStrudel: the piano roll as a Hydra source (s0)",
    ],
    code: SIGNAL_CORRUPTION,
  },
  {
    id: "weather-machine",
    title: "Weather Machine — an instrument the listener plays",
    summary:
      "Rain, warmth, wind, thunder and storm are controls on the player's strip; the listener performs the weather, and the sound and the sky both follow. Built for a live session: the controls keep their values when Claude updates the pattern.",
    teaches: [
      "fader(), pad(), xy(): controls that are patterns (.gain(rain)) and numbers (rain.value)",
      "one control driving sound AND picture",
      "a toggle that brings a band in",
      "flashes that swell instead of strobe",
    ],
    code: WEATHER_MACHINE,
  },
  {
    id: "two-decks",
    title: "Two Decks — a back-to-back booth",
    summary:
      "Deck A is the listener's, deck B is Claude's, and the listener mixes: an equal-power crossfader, a DJ filter per deck, bass kills and an echo throw. Built for a live session — Claude rewrites deck B with update-session while the mixer stays where the listener left it.",
    teaches: [
      "a mixer from fader()/pad(): .velocity() for level (it leaves each layer's .gain alone), .djf() for the filter",
      "one .orbit() per deck: .djf(), delay and room are per orbit (a bus), so two decks on one orbit fight over one filter",
      "equal-power crossfade: cos and sin of the fader",
      "a bass kill as a toggle that zeroes one layer",
      "the B2B shape: keep deck A and the controls, rewrite deck B each turn",
    ],
    code: TWO_DECKS,
  },
  {
    id: "trade-a-beat",
    title: "Trade a Beat — one grid, two players",
    summary:
      "A drum grid drawn into the visuals: the listener taps cells on and off, Claude answers on the same grid with a merge that lands on the next bar, and nothing either of them added is lost when the code changes. The bass opens up with every kick.",
    teaches: [
      "remember(): named state that survives every re-run, changed by taps, read by patterns through signal()",
      "describe: how the whole grid reads in get-session",
      "a merge for Claude's turn: assign cells, it runs once on the bar",
      "a drawn control: hit-test onTap into big cells, clamp the index, openStage() so taps reach the drawing",
      "state that steers sound: the bass filter follows how many kicks are on",
    ],
    code: TRADE_A_BEAT,
  },
  {
    id: "still-water",
    title: "Still Water — just the music",
    summary:
      "No controls, no film, no drawing: a 48-bar downtempo track at 104 bpm in F minor, intro → verse → lift → outro. One four-bar harmony every layer reads; a melody that asks for 24 bars and answers for 24; the kick ducks every layer by the same breath. For when the ask is a track.",
    teaches: [
      "form with arrange(): the same layers, four sections, each adds or takes one thing",
      "sound design per layer: filter envelope on the bass, FM pluck for the lead, a 16-bar filter sweep on the pad",
      "ducking with .velocity(): it multiplies .gain(), so every layer keeps its level and breathes with the kick",
      "development without new material: .off() an octave in the lift, .slow(2) the answer in the outro, .every(4) a lean-back",
      "one draw method and nothing else: .pianoroll() on the arrangement",
    ],
    code: STILL_WATER,
  },
  {
    id: "lullaby",
    title: "Lullaby — the piano asks, a voice answers",
    summary:
      "A 16-bar lullaby in C: two bars of electric piano ask, two bars of a sung line answer, on the chord tones of the bar it lands in. The second eight bars fill in a bass and the softest drums under the same call and answer. The shortest way to hear what sing() is: each word held on its note, a robot singing rather than a singer.",
    teaches: [
      "sing(line, notes): one word per note, in order, pitched onto it; the pattern takes .gain() and .room() like any sound",
      "call and response by placement: cat(silence, silence, moon, sea) puts the answers in bars 3–4 of every four",
      "the player moves the melody to the voice (octave 'auto'); its report says which octave it chose",
    ],
    code: LULLABY,
  },
];

export const GALLERY_IDS = ["first-light", "duet", "petri-dish", "lossy-terminal", "signal-corruption", "weather-machine", "two-decks", "trade-a-beat", "still-water", "lullaby"] as const;

/** The plain-text index get-strudel-guide returns for topic "gallery". */
export function galleryIndex(): string {
  const lines = [
    "# Gallery — complete audiovisual pieces",
    "",
    "Made in claude.ai by a Claude model with a person, played in this widget, and kept as",
    "worked examples. For a first film, read First Light end to end. For an instrument or a",
    "jam, start with the shortest piece that matches (line counts below); Trade a Beat is a",
    "drawn grid two players share. They show how the stage runtime (cycle, onFrame, onEvent,",
    "onTap, say), canvases, Hydra and arrange() fit together — and what an idea held all the",
    "way through looks like. Still Water is only music — no controls, no film — for when the",
    "ask is a track: form, sound design and development, nothing to tap. Lullaby is the",
    "shortest piece that sings (sing()): a sung line answering a piano.",
    "",
  ];
  for (const piece of STRUDEL_GALLERY) {
    lines.push(`## ${piece.title}  (id: ${piece.id}, ${piece.code.split("\n").length} lines)`);
    lines.push(piece.summary);
    lines.push(`teaches: ${piece.teaches.join("; ")}`);
    lines.push("");
  }
  lines.push('Fetch one: get-strudel-guide({ topic: "gallery", piece: "<id>" }) — e.g. piece: "first-light".');
  return lines.join("\n");
}
