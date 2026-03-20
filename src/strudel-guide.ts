// =============================================================================
// Strudel Guide — comprehensive reference for AI systems
// =============================================================================

export const STRUDEL_GUIDE_TOPICS = [
  "mini-notation",
  "sounds",
  "effects",
  "patterns",
  "genres",
  "tips",
  "advanced",
] as const;

export type StrudelGuideTopic = (typeof STRUDEL_GUIDE_TOPICS)[number];

export const STRUDEL_GUIDES: Record<StrudelGuideTopic, string> = {
  "mini-notation": `# Strudel Mini-Notation

Strudel uses TidalCycles-inspired mini-notation inside JavaScript.
Patterns are written as strings and transformed with chained methods.

## Basics
"bd sd"           two events per cycle (bass drum, snare)
"bd sd hh"        three events per cycle
"bd"              one event per cycle

## Operators

### Repetition
"bd*4"            repeat 4 times per cycle (fast)
"bd/2"            play every 2 cycles (slow)

### Rest
"bd ~ sd ~"       ~ is silence/rest

### Grouping
"[bd sd] hh"      group events into one step: bd+sd take half, hh takes half
"[bd sd hh] cp"   three events in first half, one in second

### Alternating
"<bd sd>"         alternate per cycle: bd first cycle, sd next cycle
"<bd sd hh>"      three-way alternation

### Elongation
"bd@3 sd"         bd takes 3 parts, sd takes 1 (3:1 ratio)
"bd@2 sd@2 hh"    2:2:1 ratio

### Replication
"bd!3"            replicate: same as "bd bd bd" (not faster, just copies)

### Random
"bd? sd"          bd plays with 50% probability
"bd sd?"          sd plays with 50% probability

### Euclidean Rhythms
"bd(3,8)"         3 hits distributed across 8 steps (tresillo: x..x..x.)
"cp(5,8)"         5 hits in 8 steps
"hh(7,16)"        7 hits in 16 steps
"bd(3,8,1)"       third arg = rotation/offset

### Polymetric
"{bd sd hh}%4"    fit 3 events into 4-step grid
"{bd sd hh cp}%3" fit 4 events into 3-step grid

### Subdivision
"[bd [sd sd]]"    nested groups: bd=half, each sd=quarter

### Comma-Separated Polyphony
"bd*4, ~ cp ~ cp, hh*8"    play all three simultaneously (inline stack)
Commas layer patterns within a single string — shorthand for stack():
  s("bd*4, ~ cp ~ cp, hh*8")   is equivalent to:
  stack(s("bd*4"), s("~ cp ~ cp"), s("hh*8"))
Very useful for compact drum patterns.

## Common Patterns

### Basic 4/4 beat
s("bd sd bd sd")

### Breakbeat
s("[bd bd] [~ sd] [~ bd] [sd ~]")

### Hi-hat patterns
s("hh*8")              eighth notes
s("hh*16")             sixteenth notes
s("[hh hh hh ~]*2")    with gaps

### Syncopation
s("bd [~ sd] bd [sd ~]")

## Tempo
setcps(0.5)             0.5 cycles per second = 120 BPM at 4/4
setcps(0.625)           150 BPM at 4/4
Formula: cps = bpm / 60 / 4`,

  sounds: `# Strudel Sounds

## Built-in Synthesizers
Use with s() or sound():
- "sine"        pure sine wave
- "sawtooth"    sawtooth wave (rich, buzzy)
- "square"      square wave (hollow, retro)
- "triangle"    triangle wave (soft, default)
- "white"       white noise
- "pink"        pink noise (softer)
- "brown"       brown noise (very soft, rumble)
- "crackle"     noise crackles

## Wavetable Synthesis
- "wt_*" prefix: 1000+ waveforms from AKWF library
- Example: s("wt_piano"), s("wt_violin")

## ZZFX Synths
- "z_sawtooth", "z_square", "z_sine", "z_noise", "z_tan"
- Retro chip-tune style sounds

## Dirt Samples (default sample library)
Loaded by default from tidalcycles/Dirt-Samples:
- bd, sd, hh, oh, cp, cr, cb, rim, mt, ht, lt
- bass, bass3, bassfwomp
- arpy, bleep, blip, gabba, jungbass, jungle
- casio, gretsch, east, jazz
- feel, future, hc, ho, if, industrial
- kurt, latibro, lighter, lt, made, metal
- moan, mouth, msg, newnotes, odx, off
- pad, pebbles, perc, pluck, psr, rave
- realclaps, reverbkick, rm, rs, sax, sheffield
- short, sine, space, speakspell, speechless
- stab, stomp, tabla, tabla2, tech, tok, trump, ul
- ulgab, uxay, v, voodoo, wind, wobble, world, xmas

Sample variants: s("bd:0"), s("bd:1"), s("bd:2")

## Drum Machine Banks (72 machines via tidal-drum-machines)
Use with .bank("MachineName"):
s("bd sd hh oh").bank("RolandTR808")
s("bd sd hh oh").bank("RolandTR909")

### Popular Banks
RolandTR808, RolandTR909, RolandTR707, RolandTR606, RolandTR505
LinnDrum, LinnLM1, Linn9000
AkaiMPC60, AkaiXR10, AkaiLinn
KorgKR55, KorgKPR77, KorgMinipops, KorgM1, KorgDDM110
BossDR110, BossDR220, BossDR55, BossDR550, BossDR660
EmuDrumulator, EmuSP12, EmuModular
OberheimDMX, AlesisSR16, AlesisHR16
SequentialCircuitsDrumtracks, MFB512
SimmonsSDS5, SimmonsSDS400
CasioRZ1, CasioSK1, CasioVL1
YamahaRX5, YamahaRX21, YamahaRY30, YamahaRM50

### Standard Drum Abbreviations (work across banks)
bd=kick, sd=snare, hh=closed hi-hat, oh=open hi-hat
rim=rimshot, cp=clap, cr=crash, rd=ride
ht=high tom, mt=mid tom, lt=low tom
sh=shaker, cb=cowbell, tb=tambourine
perc=percussion, misc=miscellaneous, fx=effects

## General MIDI Soundfonts (127 instruments)
Use with .s("gm_instrument_name"):
note("c3 e3 g3").s("gm_acoustic_grand_piano")
note("c2 e2 g2").s("gm_electric_bass_finger")

### Common GM Instruments (name → GM program number for ABC crossover)
Piano: gm_acoustic_grand_piano(0), gm_electric_piano_1(4), gm_harpsichord(6)
Organ: gm_drawbar_organ(16), gm_church_organ(19), gm_accordion(21)
Guitar: gm_acoustic_guitar_nylon(24), gm_acoustic_guitar_steel(25), gm_electric_guitar_clean(27), gm_electric_guitar_jazz(26)
Bass: gm_acoustic_bass(32), gm_electric_bass_finger(33), gm_electric_bass_pick(34), gm_slap_bass_1(36)
Strings: gm_violin(40), gm_viola(41), gm_cello(42), gm_string_ensemble_1(48), gm_pizzicato_strings(45)
Brass: gm_trumpet(56), gm_trombone(57), gm_french_horn(60), gm_brass_section(61)
Reed: gm_alto_sax(65), gm_tenor_sax(66), gm_clarinet(71), gm_oboe(68)
Pipe: gm_flute(73), gm_recorder(74), gm_pan_flute(75)
Synth Lead: gm_lead_1_square(80), gm_lead_2_sawtooth(81)
Synth Pad: gm_pad_1_new_age(88), gm_pad_2_warm(89)
Ethnic: gm_sitar(104), gm_banjo(105), gm_kalimba(108), gm_steel_drums(114)

Note: GM numbers match ABC's %%MIDI program N. Same instrument = same number.

## Combining Sounds with Notes
note("c3 e3 g3 c4").s("sawtooth")       synth melody
note("c2 [~ c2] eb2 [~ g1]").s("gm_electric_bass_finger")  bass line
s("bd sd bd sd").bank("RolandTR808")     drum pattern with bank`,

  effects: `# Strudel Effects

Chain effects with dot notation: note("c3 e3").s("sawtooth").lpf(800).room(0.5)

## Filters
.lpf(freq)        low-pass filter (removes highs). Range: 20-20000
.hpf(freq)        high-pass filter (removes lows). Range: 20-20000
.bpf(freq)        band-pass filter (isolates frequency band)
.lpq(q)           filter resonance/Q (0-50, default ~1)
.hpq(q)           high-pass resonance
.vowel("a")       vowel filter. Options: a, e, i, o, u
.djf(0-1)         DJ filter: 0=LP closed, 0.5=bypass, 1=HP open

### Filter Envelopes (animate filter per note)
.lpenv(depth)     LP envelope depth (positive=sweep up, negative=sweep down)
.lpattack(s)      envelope attack time
.lpdecay(s)       envelope decay time
.lpsustain(0-1)   envelope sustain level
.lprelease(s)     envelope release time

### Pattern-Driven Filters
.lpf(sine.range(200, 4000).slow(4))     slow sweep
.lpf(perlin.range(500, 3000))           random movement

## Amplitude Envelope
.attack(s)        attack time in seconds
.decay(s)         decay time
.sustain(0-1)     sustain level
.release(s)       release time
.ad(a, d)         shorthand: attack + decay (no sustain)
.ar(a, r)         shorthand: attack + release
.adsr(a,d,s,r)    full ADSR

## Gain & Dynamics
.gain(0-1)        volume (default 0.8)
.velocity(0-1)    alias for gain in note context
.amp(0-1)         amplitude

## Distortion
.distort(0-1)     soft distortion
.shape(0-1)       wave shaping (heavier distortion)
.crush(bits)      bit crusher (1-16, lower=more crushed)
.coarse(n)        sample rate reduction

## Modulation
.vib(hz)          vibrato frequency
.vibmod(semitones) vibrato depth
.phaser(depth)    phaser effect
.phaserdepth(d)   phaser depth
.phaserrate(hz)   phaser rate
.chorus(0-1)      chorus effect

## Space
.room(0-1)        reverb amount (0=dry, 1=full reverb)
.roomsize(0-10)   reverb room size
.roomlp(freq)     reverb low-pass (darken reverb)
.delay(0-1)       delay amount
.delaytime(s)     delay time in seconds
.delayfeedback(0-1) delay feedback (0=single, 0.9=many echoes)

## Stereo
.pan(0-1)         stereo position (0=left, 0.5=center, 1=right)
.jux(fn)          apply function to right channel only (stereo split)
  Example: .jux(rev)  reverses right channel

## Sample Manipulation
.speed(n)         playback speed (2=octave up, 0.5=octave down, -1=reverse)
.begin(0-1)       start point in sample
.end(0-1)         end point in sample
.cut(group)       cut group (stops other sounds in same group)
.chop(n)          chop sample into n pieces
.slice(n, pat)    slice sample and sequence slices
.loopAt(n)        loop sample to fit n cycles
.striate(n)       granular playback with n grains
.fit()            fit sample to cycle length

## FM Synthesis
.fm(index)        FM modulation index (brightness, 0-20+)
.fmh(ratio)       FM harmonicity ratio
.fmenv(type)      FM envelope: "lin" or "exp"
.fmattack(s)      FM envelope attack
.fmdecay(s)       FM envelope decay

### FM Example: Electric Piano
note("c3 e3 g3 c4").s("sine")
  .fm(2).fmh(2)
  .fmattack(0.01).fmdecay(0.3)
  .room(0.3)

### FM Example: Bass Growl
note("c1 ~ c1 eb1").s("sine")
  .fm(sine.range(1, 8).slow(4))
  .fmh(1).gain(0.6).lpf(400)

### FM Example: Bell
note("c5 e5 g5").s("sine")
  .fm(4).fmh(3.5)
  .fmdecay(2).fmenv("exp")
  .release(3).room(0.5).gain(0.3)`,

  patterns: `# Strudel Pattern Transformations

## Time
.fast(n)          speed up by factor n
.slow(n)          slow down by factor n
.hurry(n)         speed up pattern AND pitch
.early(cycles)    shift earlier in time
.late(cycles)     shift later in time

## Structure
.rev()            reverse the pattern
.palindrome()     play forward then backward
.iter(n)          rotate by 1 step each cycle for n steps
.iterBack(n)      same but rotate backwards
.ply(n)           repeat each event n times
.striate(n)       granular/interlocking pattern

## Probability & Randomness
.degrade()        randomly drop events (50%)
.degradeBy(0-1)   drop events with probability
.sometimes(fn)    apply function ~50% of the time
.sometimesBy(p,fn) apply function with probability p
.often(fn)        apply ~75% of the time
.rarely(fn)       apply ~25% of the time
.almostAlways(fn) apply ~90% of the time
.almostNever(fn)  apply ~10% of the time
.choose(a,b,c)    random choice each cycle
.wchoose([a,3],[b,1]) weighted random choice
.rand()           random float 0-1 per cycle
.irand(n)         random integer 0 to n-1

## Repetition & Alternation
.every(n, fn)     apply function every n cycles
  Example: .every(4, fast(2))   double speed every 4th cycle
.firstOf(n, fn)   apply only on first of every n cycles
.lastOf(n, fn)    apply only on last of every n cycles
.when(fn, fn2)    conditional transformation

## Euclidean
.euclid(hits, steps)           distribute hits evenly
.euclid(hits, steps, rotation) with rotation offset
  Example: note("c3").euclid(3,8)  tresillo pattern

## Combination
stack(pat1, pat2)     layer patterns simultaneously
cat(pat1, pat2)       concatenate patterns sequentially
seq(pat1, pat2)       alias for cat
sequence(pat1, pat2)  alias for cat

## Pitch & Scale
.transpose(n)         transpose by n semitones
.scale("C:minor")     quantize to scale
.scaleTranspose(n)    transpose within scale degrees

### n() — Scale-Degree Notation
n("0 2 4 6")                    scale degrees (0-indexed)
n("0 2 4 6").scale("C4:minor")  play C minor scale degrees
n("0 1 2 3 4 5 6 7").scale("C4:hirajoshi")  exotic scale
n("<0 2 4> <1 3 5>").scale("C4:melodicMinor")  alternating chords

n() vs note(): n() uses scale degrees (numbers), note() uses note names.
n() is much more natural for working with exotic scales — you don't need
to spell out every note name. Combine with .scale() to set key + mode.

Available scales: major, minor, dorian, phrygian, lydian, mixolydian,
locrian, melodicMinor, harmonicMinor, whole, chromatic, blues,
pentatonic, minPent, hex, bebop, diminished

## Off / Superimpose
.off(time, fn)    play original + transformed copy offset in time
  Example: .off(1/8, transpose(7))  add a 5th, offset by 1/8
.superimpose(fn)  layer transformed copy on top (no offset)
  Example: .superimpose(transpose(12))  add octave above
.add(pat)         add values (useful for pitch)
.sub(pat)         subtract values

## Chaining Example
note("c3 [e3 g3] a3 g3")
  .s("sawtooth")
  .lpf(sine.range(400, 2000).slow(4))
  .room(0.3)
  .delay(0.2)
  .delaytime(0.125)
  .delayfeedback(0.4)
  .every(4, rev)
  .jux(rev)`,

  genres: `# Strudel Genre Templates

Complete, working examples. Copy and modify.
Each template notes which features it showcases.

## Techno
// Features: stack(), .bank(), .lpq() resonance, continuous signal panning
setcps(0.5416)
stack(
  s("bd*4").gain(1),
  s("~ cp ~ cp").bank("RolandTR909").gain(0.8),
  s("hh*8").gain(0.4).pan(sine.range(0.3, 0.7)),
  note("[c2 ~ c2 ~] [~ c2] [c2 ~] [~ c2 c2 ~]")
    .s("sawtooth").lpf(600).lpq(5).gain(0.5),
  note("<[c4 eb4] [g4 bb4] [c4 f4] [eb4 g4]>")
    .s("square").gain(0.15).room(0.4).lpf(1200)
)

## House
// Features: GM instruments (.s("gm_*")), offbeat claps, filter sweep with .slow()
setcps(0.5208)
stack(
  s("bd*4").gain(0.9),
  s("~ [~ cp] ~ [cp ~]").bank("RolandTR909").gain(0.7),
  s("[~ oh]*4").bank("RolandTR909").gain(0.3),
  note("c2 ~ [c2 c2] ~").s("gm_electric_bass_finger").gain(0.6),
  note("<c4 eb4 f4 g4>*2").s("square")
    .gain(0.2).lpf(sine.range(800, 3000).slow(8)).room(0.3)
)

## Drum & Bass
// Features: complex breakbeat patterns, rand for gain/pan, high tempo
setcps(0.7291)
stack(
  s("[bd ~ ~ bd] [~ ~ bd ~] [bd ~ ~ ~] [~ bd ~ ~]").gain(1),
  s("[~ sd ~ ~] [~ ~ ~ sd] [~ ~ sd ~] [sd ~ ~ ~]")
    .bank("RolandTR909").gain(0.85),
  s("hh*16").gain(sine.range(0.1, 0.4)).pan(rand),
  note("[c2 ~ ~ c2] [~ eb2 ~ ~] [~ ~ g1 ~] [~ c2 ~ ~]")
    .s("sawtooth").lpf(400).gain(0.5)
)

## Ambient
// Features: long envelopes (.attack/.release), heavy reverb (.roomsize), delay feedback
setcps(0.25)
stack(
  note("<c3 eb3 g3 bb3>").s("sine")
    .attack(2).release(4).gain(0.3).room(0.9).roomsize(8),
  note("<[c4 eb4 g4] [bb3 d4 f4] [ab3 c4 eb4] [g3 bb3 d4]>")
    .s("triangle").attack(1).release(3).gain(0.15)
    .delay(0.4).delaytime(0.75).delayfeedback(0.6),
  note("c2").s("sine").gain(0.4).lpf(200).slow(2)
)

## Jazz
// Features: GM instruments (gm_acoustic_bass, gm_electric_piano_1), swing feel, walking bass
setcps(0.4583)
stack(
  s("[~ hh] [hh ~ hh] [~ hh] [hh ~ hh]").gain(0.35),
  s("~ [~ bd] ~ bd").gain(0.6),
  note("[c2 ~ g2 ~] [a2 ~ e2 ~] [d2 ~ a2 ~] [g1 ~ d2 ~]")
    .s("gm_acoustic_bass").gain(0.5),
  note("<[c4 e4 g4 bb4] [a3 c4 e4 g4] [d4 f4 a4 c5] [g3 b3 d4 f4]>")
    .s("gm_electric_piano_1").gain(0.3).room(0.4)
)

## Lo-fi Hip Hop
// Features: .crush() bit-crushing, GM piano + bass, random panning
setcps(0.3541)
stack(
  s("[bd ~ ~ bd] [~ sd ~ ~]").gain(0.8),
  s("hh*4").gain(0.2).pan(rand),
  note("[c3 ~ e3 ~] [g3 ~ e3 c3]").s("gm_electric_piano_1")
    .gain(0.35).room(0.5).lpf(2000).crush(12),
  note("c2 ~ [~ c2] ~").s("gm_acoustic_bass").gain(0.4).lpf(500)
)

## Dark Synthwave
// Features: filter resonance (.lpq), sawtooth bass, delay with feedback
setcps(0.4583)
stack(
  s("bd*4").gain(0.9),
  s("~ cp ~ cp").gain(0.6).room(0.3),
  s("hh*8").gain(0.25),
  note("[c2 c2 ~ c2] [~ c2 c2 ~]").s("sawtooth")
    .lpf(300).lpq(8).gain(0.5),
  note("<c4 eb4 ab4 g4>").s("sawtooth")
    .attack(0.1).release(0.8).lpf(1500).gain(0.2)
    .delay(0.3).delaytime(0.375).delayfeedback(0.5)
)

## Breakbeat
// Features: nested grouping for syncopation, rand.range(), .every() fills
setcps(0.5416)
stack(
  s("[bd bd] [~ sd] [~ bd] [sd [~ sd]]").gain(0.9),
  s("hh*8").gain(rand.range(0.1, 0.4)),
  note("[c2 ~] [~ eb2] [~ c2] [g1 ~]").s("sawtooth")
    .lpf(sine.range(200, 800).slow(4)).gain(0.5),
  note("<[c4 eb4 g4]!2 [bb3 d4 f4]!2>")
    .s("square").gain(0.15).room(0.3).lpf(2000)
)

## Minimal Techno
// Features: .sometimes(), .degradeBy() probability, sine modulation on filter
setcps(0.5416)
stack(
  s("bd*4"),
  s("~ [~ cp]").sometimes(gain(0.7)),
  s("hh*8").gain(0.3).sometimes(fast(2)),
  note("c2!3 [~ c2]")
    .s("sine").lpf(sine.range(100, 400).slow(16)).gain(0.5),
  note("~ ~ ~ c4").s("sine")
    .gain(0.1).room(0.8).delay(0.5).delaytime(0.375).delayfeedback(0.7)
    .degradeBy(0.3)
)

## Progressive House (multi-section with arrange)
// Demonstrates arrange() for intro→verse→chorus→outro structure.
// Define layers as variables, then arrange them into sections.
setcps(0.5208)
let drums = stack(
  s("bd*4").gain(0.9),
  s("~ cp ~ cp").bank("RolandTR909").gain(0.7),
  s("hh*8").gain(0.3).pan(sine.range(0.3, 0.7))
)
let bass = note("[c2 ~ c2 ~] [~ c2 c2 ~]")
  .s("sawtooth").lpf(500).gain(0.5)
let chords = note("<[c4 eb4 g4] [ab3 c4 eb4] [bb3 d4 f4] [g3 bb3 d4]>")
  .s("gm_pad_2_warm").gain(0.2).room(0.5)
let melody = note("c5 [~ eb5] g5 [~ f5] eb5 [~ c5] bb4 [~ g4]")
  .s("gm_flute").gain(0.3).room(0.4).delay(0.2).delaytime(0.375)
arrange(
  [4, drums],                                  // intro: just drums
  [8, stack(drums, bass)],                     // build: add bass
  [8, stack(drums, bass, chords)],             // verse: add pads
  [8, stack(drums, bass, chords, melody)],     // chorus: full
  [4, stack(bass.slow(2), chords)]             // outro: wind down
)`,

  tips: `# Strudel Tips & Common Mistakes

## Tempo Conversion
Strudel uses cycles per second (cps), not BPM.
Formula: cps = bpm / 60 / 4  (for 4/4 time)

Common tempos:
  80 BPM  = setcps(0.3333)
  90 BPM  = setcps(0.375)
  100 BPM = setcps(0.4166)
  110 BPM = setcps(0.4583)
  120 BPM = setcps(0.5)
  125 BPM = setcps(0.5208)
  130 BPM = setcps(0.5416)
  140 BPM = setcps(0.5833)
  150 BPM = setcps(0.625)
  160 BPM = setcps(0.6666)
  170 BPM = setcps(0.7083)
  175 BPM = setcps(0.7291)

## Tool Parameters

### bpm parameter vs setcps() in code
The bpm parameter auto-converts to setcps() for you:
- If code has no setcps(), bpm prepends setcps(bpm/60/4)
- If code already has setcps(), bpm REPLACES it
- Best practice: use the bpm parameter and omit setcps() from code
- Or: write setcps() in code and omit the bpm parameter
- Don't use both — bpm always wins

### autoplay parameter
Due to browser autoplay policies, AudioContext starts suspended until
a user gesture (click). autoplay: true evaluates the code immediately
but audio may not start until the user clicks Play. This is a browser
restriction, not a tool limitation.

### title parameter
Optional title displayed in the widget header. Give your patterns names!
Example: title: "Midnight Rain" — adds personality to the rendered widget.

## The REPL Is Editable
The rendered widget is a live Strudel REPL — the user can directly edit
the code you wrote, change notes, tweak effects, and press Ctrl+Enter
to re-evaluate. This is the key differentiator from the ABC tool:
the human gets a creative starting point they can immediately modify.
Encourage the user to experiment with the code you generate.

## GM Soundfont Loading
GM instruments (gm_flute, gm_acoustic_bass, etc.) load soundfont data
from the network on first use. There may be a brief delay (~1-2 seconds)
the first time a GM instrument plays. After that, it's cached.
Built-in synths (sine, sawtooth, square) play instantly with no loading.

## Each Call Renders a Fresh Widget
Every play-live-pattern call creates a new independent widget. Sending
a follow-up call doesn't update an existing pattern — it creates another.
For iterative refinement, generate the improved code in a single new call
rather than trying to "update" the previous one.

## Critical Rules

1. ALL function arguments must be explicit
   WRONG:  s("bd sd").lpf(800, 10)     // lpq is a separate method
   RIGHT:  s("bd sd").lpf(800).lpq(10)

2. Mini-notation goes inside quotes
   WRONG:  s(bd sd hh)
   RIGHT:  s("bd sd hh")

3. note() uses letter+octave, s() uses sample names
   WRONG:  s("c3 e3 g3")
   RIGHT:  note("c3 e3 g3").s("sawtooth")
   RIGHT:  s("bd sd hh")

4. .bank() sets drum machine, .s() sets sound source
   WRONG:  s("bd sd").s("RolandTR808")
   RIGHT:  s("bd sd").bank("RolandTR808")

5. stack() layers simultaneously, cat() sequences in time
   WRONG:  stack() for one thing after another
   RIGHT:  stack() for drums + bass + melody together

6. Patterns are quoted strings, not arrays
   WRONG:  note([c3, e3, g3])
   RIGHT:  note("c3 e3 g3")

7. setcps() is standalone, not chained
   WRONG:  note("c3 e3").setcps(0.5)
   RIGHT:  setcps(0.5)  (on its own line, before patterns)

8. Keep gain reasonable (0-1)
   WRONG:  .gain(5)     // clipping / distortion
   RIGHT:  .gain(0.8)   // clean
   Layer volumes should sum to ~1: kick 0.9, hh 0.3, bass 0.5, melody 0.3

9. Balanced brackets and parentheses
   WRONG:  s("[bd [sd hh]")    // missing closing ]
   RIGHT:  s("[bd [sd hh]]")

10. Every pattern needs a sound source
    WRONG:  note("c3 e3 g3")              // no sound!
    RIGHT:  note("c3 e3 g3").s("sawtooth")
    WRONG:  stack(note("c3"), note("e3"))  // both need .s()
    RIGHT:  stack(note("c3").s("sine"), note("e3").s("sine"))

## Pattern Building Strategy

Start simple, layer up:
1. Start with the rhythm: s("bd sd bd sd")
2. Add texture: s("hh*8").gain(0.3)
3. Add bass: note("c2 ~ eb2 ~").s("sawtooth").lpf(400)
4. Add melody/chords: note("c4 eb4 g4 bb4").s("square").gain(0.2)
5. Add effects: .room(0.3).delay(0.2)
6. Add movement: .lpf(sine.range(200, 2000).slow(4))
7. Add variation: .every(4, fast(2))

## Using stack() Effectively
Wrap all layers in stack() with proper formatting:
stack(
  s("bd*4"),                           // kick
  s("~ cp ~ cp"),                      // clap
  s("hh*8").gain(0.3),                 // hi-hat
  note("c2 ~ c2 ~").s("sawtooth"),     // bass
  note("c4 e4 g4 c5").s("triangle")    // melody
)

## Making Patterns More Interesting
- Vary gain: .gain(sine.range(0.2, 0.8))
- Random panning: .pan(rand)
- Occasional changes: .every(4, rev)
- Probability: .sometimes(fast(2))
- Filter movement: .lpf(sine.range(200, 4000).slow(8))
- Slight detuning: .detune(sine.range(-5, 5))
- Stereo width: .jux(rev)

## ABC ↔ Strudel Crossover

The two tools complement each other. Use both for different purposes:

### ABC → Strudel: "Make this groove"
1. Compose a melody in ABC with play-sheet-music
2. Extract the note sequence: C E G A → "c4 e4 g4 a4"
3. Reimagine as a Strudel pattern with effects:
   note("c4 e4 g4 a4").s("sawtooth").lpf(2000).room(0.3).every(4, rev)

### Strudel → ABC: "Notate that melody"
1. Find a melodic idea in a Strudel pattern
2. Extract the notes and translate to ABC:
   note("c4 e4 g4 c5") → C E G c (in ABC)
3. Score it with play-sheet-music for proper notation

### Key Differences
- ABC: fixed notation, through-composed, uses GM program numbers
- Strudel: live patterns, algorithmic, uses named synths/samples
- Same GM instruments: %%MIDI program 73 (ABC) = gm_flute (Strudel)
- ABC tempo: Q:1/4=120  |  Strudel tempo: setcps(0.5) = 120 BPM

## Drum Pattern Ideas
Rock:     s("bd [~ sd] bd [sd ~]")
Shuffle:  s("[bd ~] [~ bd] [~ sd] [bd ~]")
Funk:     s("[bd ~ bd ~] [~ sd ~ sd]")
Latin:    s("[bd ~ ~ bd] [~ ~ bd ~]")
Halftime: s("bd ~ ~ ~ [~ sd] ~ ~ ~")
Fills:    .every(8, s("bd sd [sd sd] [sd sd sd sd]"))`,

  advanced: `# Strudel Advanced Features

## Visualization
Add to any pattern to see it visually.

.pianoroll()           scrolling piano roll (best for melodies)
.pianoroll({cycles:4}) show 4 cycles
.scope()               oscilloscope (time-domain waveform)
.fscope()              frequency spectrum
.spiral()              circular spiral display

Example:
note("c3 e3 g3 c4").s("sawtooth").lpf(2000).pianoroll()

**Note:** Visualization works in browser mode (--render-mode browser) and
standalone Strudel.cc. In ext-apps (Claude Desktop inline widget), the
visualization canvas is hidden for layout reasons — the code editor takes
priority. Audio and the editable REPL still work; only the visual display
is suppressed. If you want visualization, suggest the user open in browser.

## Loading Extra Samples
Load additional sample packs at runtime:

### From GitHub
samples('github:tidalcycles/dirt-samples')

### From Freesound.org (Shabda)
samples('shabda:bass:4,hihat:4')     search freesound
samples('shabda/speech:hello,world') text-to-speech

### Custom URL
samples({
  kick: 'kick/kick01.wav',
  snare: 'snare/snare01.wav'
}, 'https://example.com/samples/')

### From a strudel.json manifest
samples('https://example.com/strudel.json')

## Song Arrangement
Structure multi-section compositions:

arrange(
  [4, stack(drums, bass)],           // 4 cycles: intro
  [8, stack(drums, bass, melody)],   // 8 cycles: verse
  [4, stack(drums, bass, lead)],     // 4 cycles: chorus
  [4, bass.slow(2)]                  // 4 cycles: outro
)

## Wavetable Synthesis
1000+ wavetables from AKWF library. Use wt_ prefix:
note("c3 e3 g3").s("wt_flute")
note("c2 ~ c2 ~").s("wt_saw")
note("c4 e4").s("wt_square").lpf(1000)

## ZZFX Retro Sounds
Chip-tune / game sound engine. Use z_ prefix:
note("c4 e4 g4").s("z_sawtooth")
  .attack(0.01).decay(0.1).sustain(0)   // blippy
note("c2").s("z_noise").crush(4)         // 8-bit explosion

ZZFX parameters: .slide(), .deltaSlide(), .zmod() (FM),
  .zcrush() (bit crush), .zdelay(), .tremolo(), .lfo()

## Advanced Effects

### Vowel Filter (formant synthesis)
.vowel("a")           single vowel
.vowel("a e i o u")   cycle through vowels

### Sidechain Ducking
.duckorbit(0)         duck when orbit 0 plays (kick usually)
.duckattack(0.01)     duck attack time
.duckdepth(0.5)       duck depth (0-1)

### Tremolo
.tremolo(8)           tremolo at 8 Hz
.tremolodepth(0.5)    depth (0-1)
.tremoloshape("sine") shape: sine, square, saw, tri, ramp

### Pitch Envelope
.pattack(0.01)        pitch envelope attack
.pdecay(0.2)          pitch envelope decay
.penv(12)             pitch sweep range in semitones
.pcurve(2)            envelope curve shape

### Compressor
.compressor("threshold:ratio:knee:attack:release")
Example: .compressor("-20:4:10:0.003:0.1")

### Convolution Reverb
.iresponse("ir:hall")   impulse response reverb (loads IR sample)

## Continuous Signals (modulation sources)
Use these to animate any parameter over time:
sine                  smooth oscillation (0-1)
cosine                cosine wave
saw                   ramp up
tri                   triangle
square                on/off
rand                  random per event
irand(n)              random integer 0 to n-1
perlin                smooth noise (Perlin)

### Using .range() and .slow()
sine.range(200, 4000)        map 0-1 to 200-4000
sine.range(200, 4000).slow(8) complete one cycle over 8 pattern cycles
perlin.range(0.1, 0.9)       smooth random between 0.1 and 0.9

### Example: Animated Everything
note("c3 e3 g3 c4").s("sawtooth")
  .lpf(sine.range(200, 4000).slow(4))  // filter sweep
  .gain(sine.range(0.3, 0.8).slow(8))  // volume swell
  .pan(sine.range(0, 1).slow(2))       // stereo movement
  .room(perlin.range(0, 0.5))          // random reverb
  .delay(saw.range(0, 0.4).slow(16))   // rising delay

## Scales (100+ via tonaljs)
Beyond the basics (major, minor, dorian, etc.), Strudel has:
- bebop, bebopMajor, bebopMinor, bebopDominant
- wholetone, augmented, diminished
- persian, arabian, japanese, chinese, egyptian
- prometheus, enigmatic, neapolitan
- hirajoshi, iwato, kumoi, pelog
- And many more. Use: .scale("C:scaleName")

For exotic scales, n() with scale degrees is easier than note() with note names:
n("0 2 4 6 7").scale("C4:hirajoshi")   // much easier than spelling out C D# E G G#

## Chord Voicings
voicing("Cmaj7")              auto voice-led chord
voicing("<Cmaj7 Dm7 G7 Cmaj7>")  chord progression with voice leading

Config: .anchor("c4") .mode("below") .dict("ipianoroll")`,
};
