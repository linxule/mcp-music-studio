setcps(0.4167);
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
const nowP = H(signal(t => t))
const cvs = document.createElement('canvas')
cvs.width = 640
cvs.height = 400
const g = cvs.getContext('2d')
const glyph = age => age > 10 ? '#' : age > 4 ? '@' : age > 2 ? 'O' : age > 1 ? 'o' : '+'

if (window.__lifeRaf) cancelAnimationFrame(window.__lifeRaf)
const draw = () => {
  let t = 0, kick = 0
  try { t = nowP() } catch (e) {}
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

  window.__lifeRaf = requestAnimationFrame(draw)
}
draw()
s1.init({ src: cvs, dynamic: true })

// tap / click anywhere off the code to drop a glider into the current generation
if (window.__lifeTap) window.removeEventListener('pointerdown', window.__lifeTap)
window.__lifeTap = e => {
  if (e.target && e.target.closest && e.target.closest('.cm-editor, button, input, select')) return
  let t = 0
  try { t = nowP() } catch (err) {}
  const gi = Math.floor(t)
  plant(genAt(gi), Math.floor(e.clientY / window.innerHeight * GH), Math.floor(e.clientX / window.innerWidth * GW), GLIDER)
  gens.length = gi + 1
}
window.addEventListener('pointerdown', window.__lifeTap)

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
