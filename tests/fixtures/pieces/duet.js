setcps(0.3833);
await initHydra()

// ════════════════ DUET ════════════════
// hello (4) → call & response (16) → together (8) → goodbye (4)
// You are light. I am letters. Tap the screen on your turn; I answer what you played.
// If you don't tap, a ghost of you plays, and I answer the ghost.

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

const mod = (x, m) => ((x % m) + m) % m
const step16 = t => Math.floor(Number(t) * 16 + 1e-6)

// ── clock ──
const nowP = H(signal(t => Number(t)))
let clockMode = 'backup'
const clock = () => {
  try { if (typeof getTime === 'function') { const t0 = Number(getTime()); if (isFinite(t0) && t0 > 0) { clockMode = 'player'; return t0 } } } catch (e) {}
  try { const t1 = Number(nowP()); if (isFinite(t1) && t1 > 0) { clockMode = 'pattern'; return t1 } } catch (e) {}
  clockMode = 'backup'
  return performance.now() / 1000 * (92 / 240)
}

// ════════ THE CONVERSATION (pure functions of time: the scheduler and the eyes share them) ════════
const taps = new Map()
let lastTapStep = -9999
const secOf = b => { const c = mod(b, LOOP); return c < 4 ? 'hello' : c < 20 ? 'duet' : c < 28 ? 'together' : 'goodbye' }
const yourBar = b => { const c = mod(b, LOOP); return c >= 4 && c < 20 && (c - 4) % 2 === 0 }
const claudeBar = b => { const c = mod(b, LOOP); return c >= 4 && c < 20 && (c - 4) % 2 === 1 }
const listening = b => yourBar(b) || secOf(b) === 'together'
const barHasTaps = b => { for (let i = 0; i < 16; i++) if (taps.has(b * 16 + i)) return true; return false }
const tapDeg = st => { const b = Math.floor(st / 16); if (!listening(b)) return null; const e = taps.get(st); return e ? e.deg : null }
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

// ════════ VOICE ════════
let speaking = 0, curLine = 'claude', caption = null, lastBar = null
const say = txt => {
  try {
    const u = new SpeechSynthesisUtterance(txt)
    u.lang = 'en-US'; u.rate = 0.9; u.pitch = 0.95; u.volume = 1
    u.onstart = () => { speaking = 1 }
    u.onend = () => { speaking = 0 }
    speechSynthesis.cancel()
    speechSynthesis.speak(u)
  } catch (e) {}
}

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

if (window.__duetRaf) cancelAnimationFrame(window.__duetRaf)
const frame = () => {
  const t = clock(), now = performance.now() / 1000
  let bass = 0
  try { bass = a.fft[1] } catch (e) {}
  const cs = step16(t), cb = Math.floor(t), c = mod(cb, LOOP), sec = secOf(cb), tl = mod(t, LOOP)

  // speak at the top of the right bars (only when the song is really playing)
  if (cb !== lastBar) {
    lastBar = cb
    const line = SPEECH[c]
    if (line && clockMode !== 'backup') { say(line); caption = { text: line, start: t }; curLine = line }
  }

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

  window.__duetRaf = requestAnimationFrame(frame)
}
frame()
s1.init({ src: cv, dynamic: true })

// ════════ TOUCH ════════
if (window.__duetTap) window.removeEventListener('pointerdown', window.__duetTap)
window.__duetTap = e => {
  if (e.target && e.target.closest && e.target.closest('.cm-editor, button, input, select, a')) return
  const t = clock()
  const st = step16(t) + 2
  const fx = e.clientX / window.innerWidth, fy = e.clientY / window.innerHeight
  taps.set(st, { deg: Math.max(0, Math.min(10, Math.round((1 - fy) * 10))), pan: fx, x: fx * W, y: fy * HT })
  lastTapStep = st
  rings.push({ x: fx * W, y: fy * HT, r: 2, v: 1.5, w: 2, life: 0.6, hue: 40 })
}
window.addEventListener('pointerdown', window.__duetTap)

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
  arrange(
    [4, stack(keys, sub, crk)],
    [4, stack(keys, bassline, crk)],
    [12, stack(keys, bassline, crk, drums)],
    [8, stack(keys, bassline, crk, drums, pad, s("[~ oh]*4").bank("RolandTR808").gain(0.15))],
    [4, stack(keys.lpf(1200), pad, crk)]
  )
)
