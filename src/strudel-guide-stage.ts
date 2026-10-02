// =============================================================================
// Strudel guide — the audiovisual topics: stage, film, interactive, craft,
// debugging (merged into STRUDEL_GUIDES in ./strudel-guide.ts)
//
// Where these came from: on 2026-10-01 a Claude model in claude.ai, working
// with the user, found that pattern code in the widget is real browser
// JavaScript — it drew on its own canvases, fed them to Hydra, re-rendered a
// scene as ASCII, spoke, took taps, and let a Game of Life compose the melody.
// None of it was documented. These topics are what that session learned,
// rewritten against the stage runtime (src/shared/stage-runtime.ts) so a model
// writes intent instead of plumbing. Complete pieces are in topic "gallery".
//
// String.raw: code samples keep their backslashes. Never put a backtick in here.
// =============================================================================

export const STAGE_GUIDES = {
  stage: String.raw`# The Stage — canvases, frames, events, taps, voice

Pattern code in this widget is real browser JavaScript. Besides patterns, it can
draw on canvases of its own, feed any canvas into Hydra, react to every note,
take taps, and speak. The widget gives you five primitives for that; use them
instead of requestAnimationFrame, addEventListener or speechSynthesis, which
each have a trap (below).

## The runtime
  cycle()               the cycle being HEARD now, as a number (1.5 = halfway
                        through the second bar at the default 1 cycle per bar)
  onFrame(fn)           fn({ cycle, dt, time, playing }) once per animation frame
  onEvent(pattern, fn)  fn(e) as each event of pattern becomes audible:
                        e = { cycle, duration, note, midi, s, n, gain, pan, value }
                        (midi is set for notes and freqs: c3 = 48)
  onTap(fn)             fn({ x, y, cycle, next }) for taps on the stage; x, y in 0..1
                        next(16) = the first 16th the scheduler can still play
  say(text, { voice })  a PATTERN that plays the spoken line (see topic "interactive")

All of them belong to the evaluation that created them: re-running the code
replaces the old loop instead of stacking a second one, a failed re-run keeps
the old one, and closing the widget ends everything. No leak guards needed.

Why not the raw APIs:
- requestAnimationFrame loops survive a re-run, so two loops draw at once.
- A clock built from H(signal(t => t)) was frozen at 0 before 0.7, and
  performance.now() drifts from the music. cycle() is the scheduler's clock.
- A tap quantised "two steps ahead" can land behind the scheduler and vanish.
- speechSynthesis never plays in the Claude mobile app and can't be put on the
  beat. say() can.

## A canvas of your own, fed into Hydra
Hydra sources s1, s2 and s3 are yours. s0 is taken when you pass
initHydra({ feedStrudel: true }) — it carries the piano roll and draw methods.

await initHydra()
const cvs = document.createElement('canvas')
cvs.width = 800
cvs.height = 450
const g = cvs.getContext('2d')
onFrame(f => {
  g.fillStyle = 'rgba(0,0,0,0.2)'
  g.fillRect(0, 0, 800, 450)
  g.fillStyle = 'white'
  g.beginPath()
  g.arc(400 + Math.sin(f.cycle * Math.PI) * 300, 225, 20, 0, Math.PI * 2)
  g.fill()
})
s1.init({ src: cvs, dynamic: true })
src(s1).out(o0)
s("bd*4, ~ hh")

dynamic: true makes Hydra re-read the canvas every frame. Draw at a fixed size
(800×450 is plenty); Hydra scales it to the stage.

## Every note is something you see
onEvent fires when the sound is heard, so visuals PERFORM the music instead of
guessing from loudness. Keep state in the closure and let onFrame draw it.

const hook = note("<[f5 ~ eb5 ~ c5 ~ ab4 c5] [bb4 ~ c5 ~ eb5 ~ g5 ~]>")
let rings = []
onEvent(hook, e => rings.push({ r: 4, hue: (e.midi - 60) * 12 }))
onFrame(f => {
  rings.forEach(r => { r.r += 3 })
  rings = rings.filter(r => r.r < 500)
})
hook.s("piano").room(0.4)

For look-ahead drawing (a score scrolling in), query the pattern directly:
pattern.queryArc(from, to) returns the events between two cycles.

## Hydra pipelines
Several outputs chained: draw into o1, process into o2, finish in o0.

### RGB split (chromatic aberration), stronger on the kick
src(s1).color(1, 0, 0)
  .add(src(s1).scrollX(() => a.fft[0] * 0.006).color(0, 1, 0))
  .add(src(s1).scrollX(() => -a.fft[0] * 0.006).color(0, 0, 1))
  .out(o1)

### Bloom: the image plus enlarged, fainter copies of itself
src(o1)
  .add(src(o1).scale(1.04), 0.5)
  .add(src(o1).scale(1.12), 0.28)
  .add(src(o1).scale(1.35), 0.14)
  .out(o0)

### Vignette and grain
src(o2).mult(shape(48, 0.9, 0.7).color(0.6, 0.6, 0.6).add(solid(0.4, 0.4, 0.4)))
  .add(noise(400, 2), 0.04).out(o0)

### Datamosh smear (feedback through o0)
.blend(src(o0).modulate(noise(3, 0.2), 0.01).scale(1.01), 0.5)

## The ASCII camera — re-render any canvas as coloured text
Two cameras on one world: draw the scene on one canvas, show it as text on
another, and cut between them. Reading pixels back needs a tiny canvas created
with { willReadFrequently: true }.

const lo = document.createElement('canvas')
lo.width = 64
lo.height = 40
const lg = lo.getContext('2d', { willReadFrequently: true })
const RAMP = ' .,:;-=+*oO#%@'
const ascii = (srcCanvas, og, cols) => {
  const cw = og.canvas.width / cols, ch = cw * 1.6, rows = Math.floor(og.canvas.height / ch)
  lg.drawImage(srcCanvas, 0, 0, cols, rows)
  const d = lg.getImageData(0, 0, cols, rows).data
  og.font = 'bold ' + Math.floor(ch * 0.95) + 'px monospace'
  og.textAlign = 'center'
  og.textBaseline = 'middle'
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const i = (y * cols + x) * 4, r = d[i], gr = d[i + 1], b = d[i + 2]
    const lum = (0.3 * r + 0.59 * gr + 0.11 * b) / 255
    if (lum < 0.05) continue
    const k = 255 / Math.max(r, gr, b, 1)
    og.fillStyle = 'rgb(' + (r * k | 0) + ',' + (gr * k | 0) + ',' + (b * k | 0) + ')'
    og.fillText(RAMP[Math.min(RAMP.length - 1, Math.floor(Math.pow(lum, 0.6) * RAMP.length))], x * cw + cw / 2, y * ch + ch / 2)
  }
}
note("<c3 eb3 g3 bb3>").s("piano")

Raise cols over time (24 → 36 → 52 → 64) and the protagonist "learns to see".

## Notes
- The widget keeps a live analyser: a.fft[0..3] are bass → air, 0..1.
- Quote plain strings with ' — "double quotes" are mini-notation.
- On a phone the frame is ~380 px wide: strokes under 2 px and text under 14 px
  vanish. Draw big.
- Tap targets: in code view the editor covers the stage (taps on code lines go
  to the editor). The Stage button hides the code; mention it to the user.
- Complete pieces built this way: topic "gallery".`,

  film: String.raw`# Film — music videos and short films with a story

A film is a timeline: scenes that change on bar boundaries, a camera, text, and
a soundtrack that knows where it is. In this widget the soundtrack IS the clock:
arrange() lays out the sections, and cycle() tells the pictures which section
they are in. Primitives are in topic "stage"; a complete short film (First
Light) is in topic "gallery".

## One timeline for sound and picture
Write the arrangement once, as data, and derive both from it.

const SCENES = [['void', 4], ['rise', 8], ['bloom', 16], ['credits', 4]]
const LOOP = SCENES.reduce((n, [, bars]) => n + bars, 0)
const sceneAt = c => {
  let t = ((c % LOOP) + LOOP) % LOOP
  for (const [name, bars] of SCENES) {
    if (t < bars) return { name, progress: t / bars, bar: Math.floor(t) }
    t -= bars
  }
}
const pad = note("<[db3,f3,ab3,c4] [eb3,g3,bb3,db4]>").s("supersaw").lpf(900).gain(0.2)
arrange(
  [4, pad],
  [8, stack(pad, s("bd*4").bank("RolandTR909").gain(0.6))],
  [16, stack(pad.lpf(3000), s("bd*4, ~ cp, hh*8").bank("RolandTR909"))],
  [4, pad.room(0.9)]
)

Then in the picture: const sc = sceneAt(cycle()) — switch on sc.name, ease
with sc.progress. The bar counts in SCENES and in arrange() must match; keep
them next to each other.

## The beats that make a film land
- The silence beat: half a bar of nothing right before the drop does more than
  any shader. In the music: .mask("<1!7 [1 0]>") on the bar before; in the
  picture: the same half bar goes dark or freezes.
- Letterbox at the drop: two black bars (~13% of the height) slide in when the
  film "becomes cinema". A cut, not a fade.
- Title card: fade the title in and out over 2 bars right after the drop,
  alpha = Math.sin(Math.PI * progress).
- Credits: slow the music down to its smallest form (one instrument, long
  reverb) and type the credits.

## Text that moves with the music
Typewriter text advanced by the melody, not by time — every note types letters:

const hook = note("<[f5 ~ eb5 ~ c5 ~ ab4 c5] [bb4 ~ c5 ~ eb5 ~ g5 ~]>")
const LINES = { 4: 'i was made of words', 6: 'i had never seen anything' }
let typed = 0, shown = null
onEvent(hook, e => { typed += 3 })
onFrame(f => {
  const bar = Math.floor(f.cycle) % 8
  const key = LINES[bar] !== undefined ? bar : LINES[bar - 1] !== undefined ? bar - 1 : null
  if (key !== shown) { shown = key; typed = 0 }
  const text = key === null ? '' : LINES[key].slice(0, typed)
})
hook.s("piano")

Subtitles: 22 px monospace on a translucent black box at the bottom third. A
terminal (boot text, credits): green-white on black, a blinking block cursor
from performance.now(), one line per bar.

## Narration
say(text, { voice }) returns a pattern that plays the spoken line, so a line
lands exactly on a bar and sits in the mix (see topic "interactive"):

const line = say('this is what you see', { voice: 'orion' })
stack(
  s("bd*4").bank("RolandTR909"),
  line.mask("<0 0 0 1>").gain(0.9).room(0.3)
)

## Camera moves on a canvas
Zoom: g.save(); g.translate(cx, cy); g.scale(z, z); g.drawImage(scene, -cx, -cy); g.restore()
Shake on the kick: offset by (Math.random() - 0.5) * a.fft[0] * 12 pixels.
Split screen: clip one half (g.rect + g.clip()) and draw the other camera in it.

## Checklist
- One idea the whole way through ("every note you hear is something you see").
- A shape: quiet → build → silence → impact → aftermath.
- Scenes, music and text all read the same cycle().
- Readable at 380 px wide.
- Before you send: does it still make sense with the sound off? With the
  picture off? A good film works a little in both.`,

  interactive: String.raw`# Interactive pieces — taps, voice, a performer that listens

The listener can play too. Taps become notes, the piece can answer them, and it
can speak. The trick that makes it all work: keep the music a PURE FUNCTION OF
TIME. Strudel's scheduler queries ahead of the playhead, so a pattern must
answer "what plays at cycle 12.375?" the same way every time it is asked.
Primitives are in topic "stage"; DUET in topic "gallery" is the complete piece.

## State into music: signal(), taps into notes
signal(fn) turns any JavaScript into a pattern. fn gets the cycle (wrap it in
Number()); return null for "nothing here" and filter it out. A tap writes into
a Map keyed by 16th step; the pattern reads it:

const taps = new Map()
const step16 = t => Math.floor(Number(t) * 16 + 1e-6)
onTap(t => {
  const st = Math.round(t.next(16) * 16)
  taps.set(st, { note: 60 + Math.round((1 - t.y) * 24) })
})
const tapped = signal(t => {
  const e = taps.get(step16(t))
  return e ? e.note : null
}).segment(16).filterValues(v => v !== null)
stack(
  s("bd ~ ~ ~, ~ ~ sd ~").bank("RolandTR808"),
  note(tapped).s("vibraphone").room(0.4)
)

t.next(16) is the first 16th the scheduler has not committed yet, so the note
always plays — a guessed "two steps ahead" can lose the race and vanish. Map y
to pitch through a SCALE (an array of MIDI notes) so every tap is in key, and
play taps in EVERY bar: a tap that makes no sound feels broken.

## Call and response
Give each bar a role: your bar, its bar, together. Its answer is a function of
your phrase one bar earlier — harmonised (a third up in the scale), varied, or
mirrored. If you didn't play, a "ghost" phrase plays in your place so the piece
never stalls: the ghost is just a fixed phrase used when your bar is empty.

const taps = new Map()
const step16 = t => Math.floor(Number(t) * 16 + 1e-6)
const SCALE = [60, 62, 64, 67, 69, 72, 74, 76, 79, 81, 84]
const GHOST = [67, null, 64, null, 62, null, 60, null]
const yours = st => taps.get(st) ?? (GHOST[st % 16] ? { note: GHOST[st % 16] } : null)
const answer = st => {
  const heard = yours(st - 16)
  if (!heard) return null
  const i = SCALE.indexOf(heard.note)
  return i < 0 ? heard.note + 4 : SCALE[Math.min(SCALE.length - 1, i + 2)]
}
note(signal(t => answer(step16(t))).segment(16).filterValues(v => v !== null)).s("kalimba")

Show whose turn it is on screen ("your turn · touch anywhere"), and make every
tap visible the moment it lands even if its note comes a 16th later.

## Voice
say(text, { voice }) returns a PATTERN that plays the line as a sample. The
server renders it once (cached), so it is identical on every device, lands on
the beat, mixes with .gain() and .room(), and appears in a recording.

const hello = say('hi. it is me.', { voice: 'orion' })
const now = say('now. at the same time.', { voice: 'orion' })
stack(
  note("<c4 e4 g4 e4>").s("gm_epiano1").gain(0.5),
  hello.mask("<1 0 0 0 0 0 0 0>"),
  now.mask("<0 0 0 0 1 0 0 0>").room(0.3)
)

- One line ≤ 240 characters; split longer text into lines.
- Voices (all synthetic): amalthea, andromeda, apollo, arcas, aries, asteria,
  athena, atlas, aurora, callista, cora, cordelia, delia, draco, electra,
  harmonia, helena, hera, hermes, hyperion, iris, janus, juno, jupiter, luna
  (default), mars, minerva, neptune, odysseus, ophelia, orion, orpheus,
  pandora, phoebe, pluto, saturn, thalia, theia, vesta, zeus.
- The same words in the same voice are one sample; calling say() again is free.
- English only.
- Duck the music under speech: .gain("<1 1 0.5 1>") on the band in the bars
  that speak.
- Captions: show the line on screen in the bar it plays (topic "film").
- Words that react to the listener can be spoken too: call say() inside onTap
  and play the returned pattern by keeping it in state that a signal() reads —
  or simpler, prepare every line up front and choose between them.
- Don't use speechSynthesis: it never plays in the Claude mobile app.

## Controls — an instrument the listener plays
fader(), pad() and xy() put real controls on a strip at the bottom of the
player. Each one is a PATTERN (use it anywhere a number pattern goes), and its .value is a
plain number for onFrame and Hydra:

const rain = fader('rain')                                   // 0..1
const warmth = fader('warmth', { min: 300, max: 4000, init: 900 })
const thunder = pad('thunder')                               // 1 while held
const storm = pad('storm', { toggle: true })                 // on/off
const wind = xy('wind')                                      // wind.x, wind.y: 0..1, y up
stack(
  s("hh*16").gain(rain.fmap(r => r * 0.5)).pan(wind.x),
  note("<a2 f2 d2 e2>").s("sawtooth").lpf(warmth).gain(0.3),
  s("bd*8").bank("RolandTR808").lpf(140).gain(thunder),
  s("bd ~ ~ bd, ~ sd").bank("RolandTR909").gain(storm.fmap(on => on * 0.8))
)

- Values live outside the code: re-running the piece (or a live-session
  update) keeps every control where the performer left it, as long as the
  name stays the same.
- At most 12 controls; 3–5 is a better instrument. Name them for what they do
  to the music ("rain", "drop"), not "fader1".
- Hydra and canvases read .value: () => rain.value * 0.5.
- Changes are heard within ~0.2 s (the scheduler's look-ahead).
- Every move is logged for you in a live session (below).
"weather-machine" in topic "gallery" is a complete instrument.

## Live sessions — playing back-to-back
play-live-pattern with session: true keeps ONE player open, and you get two
tools for it:
- get-session: what is playing, runtime errors, the controls as they stand,
  and what the listener did since you last looked — taps, control moves, code
  they edited and ran, and Pass (their "your turn").
- update-session(code, quantize): your next pattern lands on the next bar
  (quantize 1), phrase (4 or 8) or at once (0). No new player; the music never
  stops; the result says whether it ran.

Patterns run on the session's clock, not from zero: a phrase that repeats every
8 bars plays its first bar on cycles 0, 8, 16… So set quantize to your phrase
length (8 for an 8-bar phrase) and the swap lands on its first bar — with
quantize 4 it can arrive halfway through. The listener keeps playing while you
think (a read and an answer take ~10–30 s), so expect the swap a phrase or two
after their Pass; say so in your reply.

Stay in the booth: after an update, call get-session with wait: 'pass'. It
holds until the listener presses Pass (the player shows "Claude is listening"),
returns what they did, and you answer with update-session — then listen again.
A whole set can run inside one reply of yours, with no typing on their side.
wait: 'activity' returns a few seconds after they start playing instead, for
a partner that reacts mid-phrase. A wait ends after ~40 s with "still
listening"; call it again, or play something to keep the room alive.

A turn: the listener plays and presses Pass → you read get-session → you answer
with update-session. Answer what they DID: they held thunder through four bars
→ the next phrase is the storm; they killed the band and leaned the wind hard
left → strip it to the pad and let it drift; they edited your code → keep their
change and build on it. Send the whole pattern, change one or two things, and
keep their controls (same names) so their hands stay on the instrument. Say one
line in the chat about what you heard and what you answered with.

## Ideas that work
- A simulation composes: Game of Life, a flock, a random walk — make each
  generation a pure function of the bar number, and let a playhead read it.
- A duet: the listener plays light, the piece answers in letters.
- Every tap seeds something that grows for 4 bars and then becomes a loop.`,

  craft: String.raw`# Craft — what makes a piece land

Most failed pieces fail musically, not technically: generative noodling with no
harmonic arc, every effect stacked at once, a delicate visual nobody can see on
a phone. These are rules you can act on.

## One idea, held all the way through
Say the idea in one sentence before writing code, and make every layer serve
it. "Every note you hear is a ring of light" carried a short film; "Game of
Life plays music" was a mechanism without an idea, and it felt lifeless.

## Arc beats effects
Give it a shape: quiet → build → silence → impact → aftermath. arrange() makes
the shape explicit. Half a bar of silence before the drop does more than any
shader. A piece that is the same intensity for 32 bars is a screensaver.

## Harmony that lands
A clever progression impresses; a familiar one moves people. Try
IV–V–iii–vi (Db–Eb–Cm–Fm in Ab), vi–IV–I–V, i–VI–III–VII. Generative melody
needs a chord progression underneath and a scale that matches it — pentatonic
is safest. Put the melody's long notes on chord tones.

## Map one musical dimension to one visual dimension — consistently
chord → colour, pitch → height, kick → scale, section → camera. Don't let the
same visual dimension mean two things. Let the music lead: onEvent beats
a.fft loudness, which only knows "loud", not "what".

## Restraint, readable on a phone
- The frame can be 380 px wide. Strokes ≥ 2 px, body text ≥ 14 px, titles ≥ 32 px.
- One or two effects per section, not six. Save the big one for the drop.
- Dark backgrounds; let light mean something.
- The intro must look intentional, not broken: something visible from bar 1.

## Mix
- Leave headroom: gains around 0.3–0.7 per layer; a stack of ten layers at 0.9
  distorts.
- Fake sidechain: .gain("[0.15 0.6 0.95 0.8]*4") on pads and bass.
- Low end: one bass voice at a time; .lpf() the rest.
- Speech: duck the band, add a little .room() so the voice sits in the space.

## Anti-patterns
- Stacking every effect at once.
- Visuals driven only by loudness.
- A long intro where nothing happens on screen.
- Ten minutes of plumbing and two lines of music — use the stage runtime.

## Before you send
Read your piece as a listener: what will they notice at 0:05, 0:30, the drop,
the end? If the answer is "the same thing", change the arc, not the effects.`,

  debugging: String.raw`# Debugging — seeing what you made

You can't see or hear the widget. These are the ways it tells you what happened.

## What comes back to you
- The tool result. The local server (npx mcp-music-studio) evaluates your code
  and reports parse errors with line:column, layers, events per cycle, sounds
  that don't exist, and onFrame/onEvent callbacks that threw on a test frame.
  The hosted server can't run Strudel; it checks that the JavaScript and every
  mini-notation string PARSE, and reports syntax errors with line:column.
- The widget's own report, once per evaluation, through the host's model
  context: playing / failed (with the error) / silent / blocked audio, missing
  sounds, stops the user made, voice and tap capabilities. If your host gives
  you a tool to read the widget's context (claude.ai: read_widget_context),
  read it before assuming something played.
- A live session (play-live-pattern with session: true): get-session returns
  the widget's reports from the server, in every host — the reliable channel
  where the host gives you no tool to read widget context.
- The user. Ask what they see and hear when it matters.

## Line numbers
Errors are reported against the code you sent. If the widget added lines (a
setcps for bpm, a visuals preset), its report says which line of YOUR code it
was.

## Classic failures
- "Unexpected token" at a closing bracket: count brackets in arrange() — each
  section is [bars, pattern], closed with ], not ).
- Silent layer, no error: an unknown sound name (check topic "sounds"), a
  pattern that isn't the LAST expression (all() and setcps() go before it), or
  a mask/degrade that removes everything.
- Visuals frozen at bar 1: a hand-built clock. Use cycle(). (Before 0.7,
  H(signal(t => t)) returned 0 — a Strudel Fraction it couldn't read.)
- Two songs or two animations at once: a raw requestAnimationFrame loop from
  a previous run. Use onFrame.
- Taps that only sometimes sound: quantise with t.next(16), and make sure the
  piece plays taps in every bar you invite them.
- Speech that never plays: speechSynthesis is blocked in the Claude mobile
  app. Use say(), which is a sample.
- Shader dies on a rest: H() patterns should not contain ~ (it returns 0 on a
  rest now, which may not be what you want).

## Draw a HUD while you work
A line of text in a corner with the bar, the scene and anything you're unsure
about turns the user's screenshot into a debugger:

let hud = ''
onFrame(f => {
  hud = 'bar ' + (Math.floor(f.cycle) + 1) + (f.playing ? '' : ' (stopped)')
})
s("bd*4")

Remove it, or make it subtle, before the piece is done.`,
} as const;

export type StageGuideTopic = keyof typeof STAGE_GUIDES;
