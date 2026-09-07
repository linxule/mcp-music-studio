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
  "visuals",
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

### CHORDS need commas, not spaces
This is the single most common mistake with note names. Inside brackets,
SPACES subdivide time and COMMAS stack voices:
note("[c4 e4 g4]")   three notes ONE AFTER ANOTHER — an arpeggio, not a chord
note("[c4,e4,g4]")   three notes AT THE SAME TIME — a chord
note("<[c4,e4,g4] [f4,a4,c5]>")   one chord per cycle
Write a chord with commas whenever you mean simultaneity; use spaces only
when you actually want the notes to arpeggiate.

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
- "sine"        pure sine wave            (alias "sin")
- "sawtooth"    sawtooth wave, buzzy      (alias "saw")
- "square"      square wave, hollow       (alias "sqr")
- "triangle"    triangle wave, soft       (alias "tri")
- "supersaw"    detuned saw stack (use .unison(), .detune(), .spread())
- "pulse"       pulse wave (use .pw() for pulse width)
- "sbd"         synthesized bass drum (use .decay(), .penv())
- "bytebeat"    algorithmic bit-math oscillator
- "white"       white noise
- "pink"        pink noise (softer)
- "brown"       brown noise (very soft, rumble)
- "crackle"     noise crackles (use .density())

## ZZFX Retro Synths
Chip-tune / game sound engine. Six oscillator flavours plus the raw engine:
- "z_sine", "z_sawtooth", "z_triangle", "z_square", "z_tan", "z_noise", "zzfx"

## Wavetable Oscillator
Strudel 1.3 has a wavetable oscillator, but NO wavetable pack is preloaded in
this widget, so there is no wt_* sound you can just play. See the "advanced"
topic for the parameters (.wt(), .warp(), .warpmode()) and how to load a pack.

## Sample Libraries Loaded by Default
prebake() loads exactly six manifests. Anything outside these lists must be
loaded first with samples() (see the "advanced" topic) or it will not sound —
superdough throws "sound not found" and that layer goes SILENT with no error
visible to you.

### Default drum kit (uzu-drumkit) — what bare s("bd sd hh") plays
  bd, brk, cb, cp, cr, hh, ht, lt, misc, mt, oh, rd, rim, sd, sh, tb

### Dirt-Samples (the 9-entry subset that dough-samples actually ships)
  casio, crow, east, insect, jazz, metal, numbers, space, wind

The famous full Dirt library (arpy, bass, jungle, tabla, gabba, ...) is NOT
preloaded. Pull it in first if you want it — one line, and CSP-safe:
samples('github:tidalcycles/dirt-samples')

### Piano
  piano

### Mridangam (South Indian hand drum)
  ardha, chaapu, dhi, dhin, dhum, gumki, ka, ki, na, nam, ta, tha, thom

### VCSL — 128 orchestral, world, and percussion instruments
Pitched keys and organs:
  clavisynth, fmpiano, kawai, piano1, steinway, organ_4inch, organ_8inch,
  organ_full, pipeorgan_loud, pipeorgan_loud_pedal, pipeorgan_quiet,
  pipeorgan_quiet_pedal
Strings, harps, plucked:
  harp, folkharp, strumstick, dantranh, dantranh_tremolo, dantranh_vibrato,
  psaltery_pluck, psaltery_spiccato, psaltery_bow
Winds and reeds:
  sax, sax_stacc, sax_vib, saxello, saxello_stacc, saxello_vib, harmonica,
  harmonica_soft, harmonica_vib, super64, super64_acc, super64_vib, ocarina,
  ocarina_vib, ocarina_small, ocarina_small_stacc, recorder_soprano_stacc,
  recorder_soprano_sus, recorder_alto_stacc, recorder_alto_sus,
  recorder_alto_vib, recorder_tenor_stacc, recorder_tenor_sus,
  recorder_tenor_vib, recorder_bass_stacc, recorder_bass_sus,
  recorder_bass_vib, didgeridoo, ballwhistle, trainwhistle, siren
Mallets and tuned percussion:
  marimba, balafon, balafon_hard, balafon_soft, kalimba, kalimba2, kalimba3,
  kalimba4, kalimba5, glockenspiel, vibraphone, vibraphone_soft,
  vibraphone_bowed, xylophone_soft_pp, xylophone_soft_ff, xylophone_medium_pp,
  xylophone_medium_ff, xylophone_hard_pp, xylophone_hard_ff, tubularbells,
  tubularbells2, handbells, handchimes, belltree, marktrees, fingercymbal,
  triangles, gong, gong2, wineglass, wineglass_slow, woodblock, slitdrum
Drums:
  bassdrum1, bassdrum2, timpani, timpani2, timpani_roll, snare_modern,
  snare_hi, snare_low, snare_rim, tom_mallet, tom_stick, tom_rim, tom2_mallet,
  tom2_stick, tom2_rim, bongo, conga, darbuka, framedrum, cajon, oceandrum,
  hihat, sus_cymbal, sus_cymbal2, clash, clash2
Hand and effect percussion:
  clap, clave, cowbell, cabasa, agogo, anvil, brakedrum, guiro, ratchet,
  shaker_large, shaker_small, sleighbells, slapstick, tambourine, tambourine2,
  vibraslap, flexatone

These are ordinary sounds — play them like any other:
note("c4 e4 g4").s("marimba")
s("gong").room(0.8)
note("<c3 g3>").s("steinway").gain(0.5)
Many are multi-sample: pick a variant with s("kalimba:2"), or let the index
cycle with s("kalimba:<0 1 2>").

Sample variants: s("bd:0"), s("bd:1"), s("bd:2")

## Drum Machine Banks (71 machines via tidal-drum-machines)
Use with .bank("MachineName"):
s("bd sd hh oh").bank("RolandTR808")
s("bd sd hh oh").bank("RolandTR909")

### Popular Banks
RolandTR808, RolandTR909, RolandTR707, RolandTR606, RolandTR505, RolandTR626,
RolandTR727, RolandCompurhythm78, RolandCompurhythm1000
LinnDrum, LinnLM1, LinnLM2, Linn9000
AkaiMPC60, AkaiXR10, AkaiLinn, MPC1000
KorgKR55, KorgKPR77, KorgMinipops, KorgM1, KorgDDM110, KorgPoly800
BossDR110, BossDR220, BossDR55, BossDR550
EmuDrumulator, EmuSP12, EmuModular
OberheimDMX, AlesisSR16, AlesisHR16
SequentialCircuitsDrumtracks, SequentialCircuitsTom, MFB512
SimmonsSDS5, SimmonsSDS400
CasioRZ1, CasioSK1, CasioVL1
YamahaRX5, YamahaRX21, YamahaRY30, YamahaRM50
(The full 71 also includes short aliases — .bank("Linn") works as well as
.bank("AkaiLinn").)

### Standard Drum Abbreviations (work across banks)
bd=kick, sd=snare, hh=closed hi-hat, oh=open hi-hat
rim=rimshot, cp=clap, cr=crash, rd=ride
ht=high tom, mt=mid tom, lt=low tom
sh=shaker, cb=cowbell, tb=tambourine, brk=break, misc=miscellaneous
perc and fx exist in the drum-machine banks but NOT in the default kit, so
they only sound after a .bank(); on the bare default kit they are silent.

## General MIDI Soundfonts (128 instruments)
Use with .s("gm_instrument_name"):
note("c3 e3 g3").s("gm_piano")
note("c2 e2 g2").s("gm_electric_bass_finger")

### Common GM Instruments (name → GM program number for ABC crossover)
Piano: gm_piano(0), gm_epiano1(4), gm_harpsichord(6)
Organ: gm_drawbar_organ(16), gm_church_organ(19), gm_accordion(21)
Guitar: gm_acoustic_guitar_nylon(24), gm_acoustic_guitar_steel(25), gm_electric_guitar_clean(27), gm_electric_guitar_jazz(26)
Bass: gm_acoustic_bass(32), gm_electric_bass_finger(33), gm_electric_bass_pick(34), gm_slap_bass_1(36)
Strings: gm_violin(40), gm_viola(41), gm_cello(42), gm_string_ensemble_1(48), gm_pizzicato_strings(45)
Brass: gm_trumpet(56), gm_trombone(57), gm_french_horn(60), gm_brass_section(61)
Reed: gm_alto_sax(65), gm_tenor_sax(66), gm_clarinet(71), gm_oboe(68)
Pipe: gm_flute(73), gm_recorder(74), gm_pan_flute(75)
Synth Lead: gm_lead_1_square(80), gm_lead_2_sawtooth(81)
Synth Pad: gm_pad_new_age(88), gm_pad_warm(89)
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

### Envelope shorthands take ONE colon-joined string
.ad(".a:.d")      shorthand: attack + decay (no sustain)
.ar(".a:.r")      shorthand: attack + release
.adsr(".a:.d:.s:.r")  full ADSR

These are COMPOSITE controls, not multi-argument functions. Commas do not
work: .adsr(.1,.2,.3,.4) patterns the ATTACK over four values, producing four
stacked notes with no decay, sustain or release at all. Same trap for .ad and
.ar. Write the values as one string joined by colons:
note("c3 e3 g3").s("sawtooth").adsr(".01:.2:.3:.5")
note("c3 e3 g3").s("sawtooth").ad(".01:.15")
Or set .attack()/.decay()/.sustain()/.release() individually — those DO take a
single number each.

## Gain & Dynamics
.gain(0-1)        volume (default 0.8)
.velocity(0-1)    per-note velocity — a SEPARATE control from .gain(), not an
                  alias; the two multiply, so .gain(0.8).velocity(0.5) is
                  quieter than either alone
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

Every one of these takes a FUNCTION, never a pattern. .sometimes(gain(0.7))
looks plausible and is fatal: gain(0.7) is a Pattern, the query then throws
"e is not a function", and the ENTIRE stack — not just that layer — falls
silent. Write .sometimes(x => x.gain(0.7)), or pass a control function that is
still curried, like .sometimes(fast(2)).

### Random sources are GLOBALS, not methods
choose("bd","sd")       random pick:  s(choose("bd","sd","hh"))
wchoose(["bd",3],["sd",1])  weighted pick: s(wchoose(["bd",3],["sd",1]))
rand                    random float 0-1 — a VALUE, not a call: .gain(rand)
irand(n)                random integer 0..n-1: n(irand(12)).scale("C4:minor")
perlin                  smooth random: .lpf(perlin.range(400, 3000))

These are continuous signals: they have no events of their own, so they take
their structure from whatever they feed (s("bd*4").gain(rand) gives one value
per kick), or you give them structure with .segment(n):
s(wchoose(["bd",3],["sd",1])).segment(4)
There is NO .choose() / .wchoose() / .rand() / .irand() Pattern method.
Writing s("bd*4").choose("bd","sd") raises no error — it just plays nothing.

## Repetition & Alternation
.every(n, fn)     alias for .firstOf — applies fn on the FIRST cycle of each
                  group of n, i.e. cycles 0, n, 2n ... (not the last)
  Example: .every(4, fast(2))   double speed on cycles 0, 4, 8 ...
.firstOf(n, fn)   same thing, named honestly
.lastOf(n, fn)    apply on the LAST cycle of every n — this is the one you
                  want for an end-of-phrase fill
  Example: .lastOf(8, x => x.fast(2))   double-time on cycles 7, 15, 23 ...
.when(fn, fn2)    conditional transformation

fn is a function here too. .every(8, s("bd*8")) passes a Pattern and silences
the layer; to swap in a different pattern for one cycle use a callback that
ignores its argument: .lastOf(8, () => s("bd*8")).

## Euclidean
.euclid(hits, steps)           distribute hits evenly — exactly TWO arguments
.euclidRot(hits, steps, rot)   the rotated variant. A third argument to
                               .euclid() throws "expects 2 inputs but got 3"
                               (mini-notation "bd(3,8,1)" does take three)
.euclidLegato(hits, steps)     same placement, but each hit is held until
                               the next one (no gaps)
  Example: s("bd").euclid(3,8)       tresillo
  Example: s("bd").euclidRot(3,8,1)  tresillo rotated one step

## Combination
stack(pat1, pat2)     layer patterns simultaneously
cat(pat1, pat2)       ONE pattern per cycle (alias slowcat): bd on cycle 0,
                      sd on cycle 1, bd again on cycle 2 ...
seq(pat1, pat2)       all of them INSIDE one cycle (alias fastcat) — the
                      code equivalent of the mini-notation "bd sd"
sequence(pat1, pat2)  same as seq
  seq is NOT an alias for cat: seq(s("bd"), s("sd")) fires twice per cycle,
  cat(s("bd"), s("sd")) fires once and alternates.

## Pitch & Scale
.transpose(n)         transpose by n semitones
.scale("C:minor")     quantize to scale
.scaleTranspose(n)    transpose within scale degrees

### n() — Scale-Degree Notation
n("0 2 4 6")                    scale degrees (0-indexed)
n("0 2 4 6").scale("C4:minor")  play C minor scale degrees
n("0 1 2 3 4 5 6 7").scale("C4:hirajoshi")  exotic scale
n("<0 2 4> <1 3 5>").scale("C4:melodic:minor")  two notes per cycle
n("[0,2,4]").scale("C4:minor")  a CHORD — commas stack, spaces arpeggiate

In "<0 2 4> <1 3 5>" each slot steps through its own list, one degree per
cycle — that is alternation, not a chord.

Use n() for scale degrees (numbers) and note() for note names. Degrees are
much more natural for exotic scales — you don't have to spell out every note.
Combine with .scale() to set key + mode.

Scale names go through tonal.js, which replaces ":" with a space and then
looks the name up. So a MULTI-WORD scale is spelled with a colon between the
words — "C4:melodic:minor", not "C4:melodicMinor". A name tonal does not know
throws and the layer produces NO notes.

Single-word scales: major, minor, ionian, dorian, phrygian, lydian,
mixolydian, aeolian, locrian, chromatic, pentatonic, blues, augmented,
diminished, altered, dominant, bebop, arabian, balinese, chinese, egyptian,
enigmatic, flamenco, gypsy, hindu, hirajoshi, indian, in-sen, iwato, kumoi,
kumoijoshi, overtone, pelog, persian, piongio, prometheus, ritusen, scriabin,
spanish, ultralocrian

Multi-word scales (mind the colon): major:pentatonic, minor:pentatonic,
major:blues, minor:blues, harmonic:minor, harmonic:major, melodic:minor,
whole:tone, whole:tone:pentatonic, half-whole:diminished,
whole-half:diminished, bebop:major, bebop:minor, bebop:locrian, minor:bebop,
lydian:dominant, lydian:augmented, lydian:minor, lydian:pentatonic,
phrygian:dominant, mixolydian:pentatonic, double:harmonic:major,
double:harmonic:lydian, hungarian:major, hungarian:minor, romanian:minor,
ukrainian:dorian, spanish:heptatonic, six:tone:symmetric, composite:blues,
locrian:pentatonic, ionian:pentatonic, minor:hexatonic, super:locrian,
leading:whole:tone, altered:dorian, minor:six:pentatonic, purvi:raga,
todi:raga, kafi:raga, malkos:raga

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
  note("<[c4,eb4] [g4,bb4] [c4,f4] [eb4,g4]>")
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
  note("<[c4,eb4,g4] [bb3,d4,f4] [ab3,c4,eb4] [g3,bb3,d4]>")
    .s("triangle").attack(1).release(3).gain(0.15)
    .delay(0.4).delaytime(0.75).delayfeedback(0.6),
  note("c2").s("sine").gain(0.4).lpf(200).slow(2)
)

## Jazz
// Features: GM instruments (gm_acoustic_bass, gm_epiano1), swing feel, walking bass
setcps(0.4583)
stack(
  s("[~ hh] [hh ~ hh] [~ hh] [hh ~ hh]").gain(0.35),
  s("~ [~ bd] ~ bd").gain(0.6),
  note("[c2 ~ g2 ~] [a2 ~ e2 ~] [d2 ~ a2 ~] [g1 ~ d2 ~]")
    .s("gm_acoustic_bass").gain(0.5),
  note("<[c4,e4,g4,bb4] [a3,c4,e4,g4] [d4,f4,a4,c5] [g3,b3,d4,f4]>")
    .s("gm_epiano1").gain(0.3).room(0.4)
)

## Lo-fi Hip Hop
// Features: .crush() bit-crushing, GM piano + bass, random panning
setcps(0.3541)
stack(
  s("[bd ~ ~ bd] [~ sd ~ ~]").gain(0.8),
  s("hh*4").gain(0.2).pan(rand),
  note("[c3 ~ e3 ~] [g3 ~ e3 c3]").s("gm_epiano1")
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
  note("<[c4,eb4,g4]!2 [bb3,d4,f4]!2>")
    .s("square").gain(0.15).room(0.3).lpf(2000)
)

## Minimal Techno
// Features: .sometimes(), .degradeBy() probability, sine modulation on filter
setcps(0.5416)
stack(
  s("bd*4"),
  s("~ [~ cp]").sometimes(x => x.gain(0.7)),
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
let chords = note("<[c4,eb4,g4] [ab3,c4,eb4] [bb3,d4,f4] [g3,bb3,d4]>")
  .s("gm_pad_warm").gain(0.2).room(0.5)
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

## Reference
Docs and the interactive REPL: strudel.cc (tutorial at strudel.cc/learn).
Source: codeberg.org/uzu/strudel — the project moved off GitHub, so any
github.com/tidalcycles/strudel link you may have memorised is stale.

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
   Give the mix headroom: kick 0.8, hh 0.3, bass 0.5, melody 0.3 — the kick
   is loudest, everything else sits under it. Gain sums alone don't guarantee
   no clipping (peaks add); if it distorts, pull the loudest layer down first.

9. Balanced brackets and parentheses
   WRONG:  s("[bd [sd hh]")    // missing closing ]
   RIGHT:  s("[bd [sd hh]]")

10. Choose a timbre with .s() — bare note() plays the default triangle synth
    OK:     note("c3 e3 g3")              // plays, but a plain triangle wave
    BETTER: note("c3 e3 g3").s("sawtooth")
    Each layer picks its own: stack(note("c3").s("sine"), note("e3").s("gm_piano"))

11. Plain strings use SINGLE quotes — double quotes mean mini-notation
    Strudel's transpiler rewrites every "..." into a pattern, so an ordinary
    JS string written with " fails at eval with \`[mini] parse error\`.
    WRONG:  await initHydra({ src: "https://unpkg.com/hydra-synth@1.4.0" })
    RIGHT:  await initHydra({ src: 'https://unpkg.com/hydra-synth@1.4.0' })
    WRONG:  samples("github:tidalcycles/dirt-samples")
    RIGHT:  samples('github:tidalcycles/dirt-samples')
    Keep " for real patterns: s("bd sd"), note("c3 e3"), H("1 0 0.6 0").

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
Fills:    .lastOf(8, () => s("bd sd [sd sd] [sd sd sd sd]"))   // a FUNCTION — every/lastOf take x => ...`,

  visuals: `# Strudel Visuals (draw methods + Hydra shaders)

Two visual layers render BEHIND the code in the widget (native strudel.cc
look), plus one audio-reactive input that can drive either. The layers appear
automatically when your pattern uses them — the user can also toggle them with
the "Visuals" button, and hide the code entirely with "Stage". Encourage
visuals: they make the pattern legible and the widget feel alive.

  Layer 1 — Strudel draw methods (2D canvas): .pianoroll(), .scope(), ...
  Layer 2 — Hydra (WebGL shaders): await initHydra() then hydra code.
  Input   — \`a\`, the live level of Strudel's OWN audio (never the microphone),
            for making a shader move with the music.

Use them together: Hydra paints a moving background, the pianoroll draws the
notes on top of it.

No hand-written visual? Set the \`visuals\` parameter to a preset instead — and
\`theme\` to a colour scheme that fits the mood. Both are documented at the
bottom of this topic.

## Layer 1: Strudel draw methods
Add ONE draw method to a pattern (all of them share the same 2D canvas, so two
at once fight over it).

.pianoroll()              scrolling piano roll (best for melodies/chords)
.pianoroll({ cycles: 4 }) show 4 cycles at once
.punchcard()              grid of note blocks (good for drums/rhythm)
.scope()                  oscilloscope — time-domain waveform (needs audio playing)
.spectrum()               frequency-spectrum analyzer (needs audio playing)
.pitchwheel()             notes arranged around a color wheel
.spiral()                 spiral display

Example:
note("c3 e3 g3 c4").s("sawtooth").lpf(2000).pianoroll()

### pianoroll options
.pianoroll({ cycles: 8, labels: 1, vertical: 1 })   // override what you need
  cycles    how many cycles are visible at once   (default 4)
  playhead  position of the now-line, 0–1         (default 0.5)
  vertical  1 = scroll vertically, not horizontally (default 0)
  labels    1 = draw note-name labels             (default false)
  fold      1 = collapse unused pitch rows        (default 1 — already on;
            pass fold: 0 to show the full pitch range instead)
  minMidi / maxMidi   pitch range when fold is 0  (defaults 10 / 90)
  autorange 1 = fit the range to the notes present (default 0)
  smear     1 = do not clear the canvas — leaves trails (default 0)
  flipTime  1 = reverse the time axis             (default 0)
  hideInactive  1 = only draw the note under the playhead (default 0)
  background  canvas background colour            (default "transparent")

### Per-pattern colors
.color("cyan") / .color("#ff7aa2") tints that pattern's notes in the pianoroll
and its highlight in the code. Pattern it for movement: .color("<cyan magenta>").

To draw ALL running patterns in one roll: all(pianoroll) on its own line.
.scope()/.spectrum() animate only while audio plays; .pianoroll()/.punchcard()
animate from the note schedule, so they update live as the user edits (Ctrl+Enter).

## Layer 2: Hydra shader backgrounds
Hydra (hydra.ojack.xyz) is a live-coding video synth. It is bundled with the
REPL: put \`await initHydra()\` on the FIRST line, write hydra code, then your
Strudel patterns. Hydra runs its own render loop, so it keeps animating between
pattern re-evaluations.

Rules:
- \`await initHydra()\` must come first (it loads the engine; keep the await).
- Exactly one output chain ending in .out(o0) is enough. No render() needed.
- Keep it darkish / mid-contrast: the code is drawn over it with a scrim.
- Hydra code is plain JavaScript — no mini-notation quotes around numbers.
- Two ways to move with the music: H() (a pattern's current value, below) and
  \`a\` (the live audio level, "Audio-reactive" below). Do NOT pass
  detectAudio: true — that is hydra's own microphone capture, and it prompts.
- Quote plain strings with ' not " (see "Single quotes" below).
- The hydra-synth version is pinned for you, so a bare await initHydra() is
  reproducible; pass \`src\` only to override it.
- Hydra + one Strudel draw method is fine; the roll draws on top of the shader.

### Recipe: minimal moving background
await initHydra()
osc(8, 0.05, 0.9).rotate(0.3).kaleid(5).color(0.5, 0.35, 1).out(o0)

s("bd*2 [~ sd] hh*4").bank("RolandTR909")

### Recipe: pattern drives the shader with H()
H(pattern) turns a Strudel pattern into a live value Hydra reads every frame,
so the visual follows the SAME sequence the music plays.

AVOID ~ RESTS IN AN H() PATTERN. H is
  o => () => reify(o).queryArc(getTime(), getTime())[0].value
— a zero-width query lands on a rest, returns [], and [0].value throws inside
Hydra's per-frame uniform evaluation. Use a low number where you would have
used a rest ("1 0 0.6 0" rather than "1 ~ 0.6 ~"). The widget also guards
H() so a rest yields 0 instead of throwing; on strudel.cc itself you would
need a try/catch around the call (a "?? 0" does NOT catch a throw).

await initHydra()
const seq = "<3 4 5 [6 7]>*2"
shape(H(seq), 0.4, 0.05)
  .rotate(() => time * 0.2)
  .scale(1.4)
  .color(0.9, 0.5, 1)
  .out(o0)

n(seq).scale("A:minor").s("piano").room(0.6)

### Recipe: kick pulse
Drive a parameter from a rhythm pattern (values 0–1). Wrap H() in an arrow
function when you want to remap it.

await initHydra()
const pulse = "1 0 0.6 0 1 0 0.3 0.3"
shape(6, () => 0.15 + 0.35 * H(pulse)(), 0.3)
  .repeat(3, 3)
  .modulateRotate(osc(4, 0.1), 0.4)
  .color(0.2, 0.8, 1)
  .out(o0)

stack(
  s("bd*2 [~ bd] bd*2 [~ bd]").bank("RolandTR808"),
  s("~ cp").bank("RolandTR808"),
  s("hh*8").gain(0.5)
)

### Recipe: post-process the pianoroll (feedStrudel)
feedStrudel pipes the Strudel draw canvas into Hydra source s0, so you can
warp, mirror, and trail the piano roll itself.

await initHydra({ feedStrudel: true })
src(s0)
  .kaleid(4)
  .modulate(noise(3, 0.2), 0.06)
  .colorama(0.01)
  .blend(o0, 0.65)   // feedback = trails
  .out(o0)

note("<[c3,e3,g3,b3] [a2,c3,e3,g3]>*2").s("sawtooth").lpf(1400).pianoroll({ cycles: 2 })

### Recipe: slow ambient wash
await initHydra()
noise(2, 0.08)
  .color(0.15, 0.25, 0.6)
  .modulate(voronoi(3, 0.2), 0.3)
  .blend(o0, 0.9)
  .out(o0)

note("<c3 e3 g3 b3>").s("gm_pad_warm").room(0.9).size(0.9).slow(2)

## Audio-reactive: \`a\` (Strudel's output, never the microphone)
The widget publishes hydra's audio object \`a\`, wired to the same master bus
the speakers get. No getUserMedia, no permission prompt — it reacts to the
pattern that is playing. It is live once Hydra is up; before that the bands
simply read 0, so a shader never crashes on it.

  a.fft[0..3]      band levels, low → high. fft[0] is the kick band.
                   ~0 in silence, ~1 on a loud hit (can go past 1).
  a.bins           the smoothed band values fft is derived from
  a.vol            mean of bins — overall loudness
  a0(scale, off)   … a3(scale, off): shorthand for
                   () => a.fft[i] * scale + off  (already a function)
  a.setSmooth(x)   frame-to-frame inertia, 0–1     (default 0.4)
  a.setCutoff(x)   noise floor subtracted first    (default 2)
  a.setScale(x)    divisor applied after cutoff    (default 10)
  a.setBins(n)     how many bands                  (default 4)
  a.show()/a.hide()  small debug meter of the live band levels

  fft[i] = max(0, (bins[i] - cutoff) / scale)

Same formula and defaults as hydra-synth, so hydra tutorials that read a.fft[0]
or a0() work here verbatim. Barely moving? Lower setCutoff or setScale.
Twitchy? Raise setSmooth toward 0.8.

PASS IT AS A FUNCTION. \`osc(10, 0, a.fft[0])\` reads the value once, at
evaluation time, and freezes; \`osc(10, 0, () => a.fft[0])\` is re-read every
frame. (a0(4) already returns such a function — no extra arrow needed.)

### Recipe: kick-driven kaleidoscope
await initHydra()
osc(10, 0, () => a.fft[0] * 4)
  .kaleid(3)
  .color(1, 0.45, 0.85)
  .out(o0)

stack(
  s("bd*4").bank("RolandTR808").gain(0.9),
  s("~ cp ~ cp").bank("RolandTR808"),
  s("hh*8").bank("RolandTR808").gain(0.35)
)

Variation — let a higher band warp the geometry instead of the colour (swap in
this chain; a.fft[1] is the low-mid band, so the shape breathes with the bass):

osc(10, 0, () => a.fft[0] * 4)
  .kaleid(3)
  .modulateScale(osc(2), () => a.fft[1])
  .out(o0)

## Single quotes: plain strings in code, double quotes only for patterns
Strudel's transpiler rewrites DOUBLE-quoted strings into mini-notation, so an
ordinary JS string written with " dies at eval with \`[mini] parse error\`.
Use ' for URLs, option strings, and labels:

  WRONG:  await initHydra({ src: "https://unpkg.com/hydra-synth@1.4.0" })
  RIGHT:  await initHydra({ src: 'https://unpkg.com/hydra-synth@1.4.0' })

Keep " for actual patterns: s("bd sd"), note("c3 e3"), H("1 0 0.6 0").

## The \`visuals\` parameter (a floor, not a ceiling)
Ready-made visual for code that has none of its own:
  none | pianoroll | punchcard | scope | spectrum — appends
  all(p => p.<method>()) after your code, drawing every running pattern.
  hydra-kaleid | hydra-pulse | hydra-wash | hydra-feed — prepends a pinned
  await initHydra() shader before it (hydra-feed also adds a piano roll for
  the shader to mirror, when your code has no draw method).
Skipped when the code already has a draw method or calls initHydra(), and the
hydra presets are skipped entirely under prefers-reduced-motion. Writing your
own visual, as above, is still the better result.

## The \`theme\` parameter (editor colour scheme)
Sets the CodeMirror theme, and the widget derives the visuals stage and scrim
from it — so the theme also decides whether the animation sits on a dark or a
light ground. One of:

  strudelTheme algoboy archBtw androidstudio atomone aura bbedit blackscreen
  bluescreen bluescreenlight CutiePi darcula dracula duotoneDark eclipse
  fruitDaw githubDark githubLight greenText gruvboxDark gruvboxLight sonicPink
  materialDark materialLight monokai noctisLilac nord redText solarizedDark
  solarizedLight sublime teletext tokyoNight tokyoNightDay tokyoNightStorm
  vscodeDark vscodeLight whitescreen xcodeLight

Mood pairings that work:
  teletext            chiptune / 8-bit / breakcore
  sonicPink           synthwave / vaporwave / italo
  nord, tokyoNight    ambient / downtempo / drone
  gruvboxDark         lofi / jazz-hop / dusty boom-bap
The light themes (githubLight, solarizedLight, xcodeLight, tokyoNightDay) suit
a bright room, but a light ground flattens a shader — the scrim compensates by
going heavier, which mutes the visual further. Prefer a dark theme when the
visual is the point.

## Stage mode
The user can press "Stage" to hide the code completely and ⛶ to go fullscreen,
leaving only the animation — so make the visual worth watching on its own, not
just as a backdrop for text.

### Hydra cheat-sheet (the parts that matter here)
Sources:  osc(freq, sync, offset) noise(scale, speed) voronoi(scale, speed)
          shape(sides, radius, smoothing) gradient(speed) solid(r, g, b) src(s0|o0)
Color:    .color(r, g, b) .colorama(amt) .saturate(x) .hue(x) .invert() .luma(th)
Geometry: .rotate(angle, speed) .scale(x) .kaleid(n) .repeat(x, y) .pixelate(x, y)
          .scroll(x, y) .scrollX(x, speed)
Combine:  .add(src, amt) .blend(src, amt) .mult(src) .diff(src) .mask(src)
Modulate: .modulate(src, amt) .modulateRotate(src, amt) .modulateScale(src, amt)
          .modulateKaleid(src, n) .modulateScrollX(src, amt)
Live:     any number can be a function: () => time, () => Math.sin(time),
          H("<0 1 2>") (pattern value), () => a.fft[0] (live audio level)
Output:   .out(o0)

### Troubleshooting
- "initHydra is not defined": the engine failed to load; ask the user to re-run.
- "osc is not defined" (or shape/noise/voronoi/src/o0 is not defined): Hydra
  never finished initialising — either await initHydra() is missing, is not on
  the first line, or the load failed. Hydra's drawing functions only exist
  AFTER initHydra() resolves. Re-run with await initHydra() at the top.
- "Cannot read properties of undefined (reading 'value')" from a frame
  callback: an H() pattern hit a ~ rest. See the H() recipe above.
- Nothing visible: you probably forgot .out(o0), or the colors are too dark.
- Choppy audio: simplify the shader (fewer modulate/kaleid stages).
- The pattern used Hydra before but not now: the widget stops the old shader
  automatically; add initHydra() again to bring it back.`,
  advanced: `# Strudel Advanced Features

## Visualization
See the dedicated "visuals" topic for Strudel draw methods (.pianoroll(),
.scope(), .spectrum() ...) and Hydra shader backgrounds (await initHydra()).
Quick reminder: one Strudel draw method per pattern; Hydra can be layered
underneath it.

## Loading Extra Samples
Load additional sample packs at runtime. IMPORTANT: inside the inline widget a
host Content-Security-Policy is in force, and only these sources can load —

  github:  ->  raw.githubusercontent.com   ALLOWED
  shabda:  ->  shabda.ndre.gr + cdn.freesound.org   ALLOWED
  any other https:// URL                    BLOCKED (the fetch fails silently
                                            and the sound is never registered)

The browser-mode fallback (--render-mode browser) has no such CSP, so arbitrary
URLs work there. Prefer github:/shabda: so the same code works in both.

### From GitHub
samples('github:tidalcycles/dirt-samples')

### From Freesound.org (Shabda)
samples('shabda:bass:4,hihat:4')     search freesound
samples('shabda/speech:hello,world') text-to-speech

### Custom URL — browser mode only (blocked by the inline widget's CSP)
samples({
  kick: 'kick/kick01.wav',
  snare: 'snare/snare01.wav'
}, 'https://example.com/samples/')

### From a strudel.json manifest — browser mode only
samples('https://example.com/strudel.json')

Whatever the source: a sample name that was never registered makes superdough
throw "sound not found" and that layer is SILENT. Only name sounds you loaded
or that the "sounds" topic lists as preloaded.

## Song Arrangement
Structure multi-section compositions:

arrange(
  [4, stack(drums, bass)],           // 4 cycles: intro
  [8, stack(drums, bass, melody)],   // 8 cycles: verse
  [4, stack(drums, bass, lead)],     // 4 cycles: chorus
  [4, bass.slow(2)]                  // 4 cycles: outro
)

## Wavetable Oscillator
Strudel 1.3 has a real wavetable oscillator, but NO wavetable pack is prebaked
in this widget, so there is no wt_* sound you can just play. The old wt_flute /
wt_saw / wt_piano names are silent: they were never registered.

"wt_" is what the BANK contributes, not something you type as a sound name.
The oscillator switches on when the registered sound key starts with "wt_",
and the bank is what builds that key: bank + sound name -> the registered
"wt_<bank>_<sound>" entry. So you must load a wavetable pack first, then
select it as a bank. Upstream's own example, for reference:

samples('github:<owner>/<wavetable-pack>')                 // needs samples()
s("squelch").bank("wt_digital").seg(8).note("F1")          // needs samples()
  .wt("0 0.25 0.5 0.75 1")                                 // needs samples()

Wavetable parameters (they only do something once a wt_ bank is loaded):
.wt(0-1)          position in the wavetable (synonym .wavetablePosition)
.wtenv(0-1)       amount of the position envelope
.wtattack/.wtdecay/.wtsustain/.wtrelease   position envelope
.wtrate/.wtdepth/.wtskew/.wtdc            position LFO
.warp(0-1)        waveform warp amount
.warpmode("...")  none, asym, bendp, bendm, bendmp, sync, quant, fold, pwm,
                  orbit, spin, chaos, primes, binary, brownian, reciprocal,
                  wormhole, logistic, sigmoid, fractal, flip
.wtphaserand(0-1) randomise the starting phase

For out-of-the-box gritty/retro timbres without loading anything, use the ZZFX
z_* sounds below, or "supersaw"/"pulse"/"bytebeat".

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
.pcurve(0)            envelope curve: 0 = linear (default), 1 = exponential.
                      Only those two values are defined — anything else falls
                      back to linear. Pattern it: .pcurve("<0 1>")

### Compressor
.compressor("threshold:ratio:knee:attack:release")
Example: .compressor("-20:4:10:0.003:0.1")

### Convolution Reverb
.iresponse(sample)      use a LOADED sample as the reverb impulse response
                        (synonym .ir()). Needs .room() on as well, and the
                        name must be a sound that is actually registered —
                        "ir:hall" is not one: the colon is read as a sample
                        INDEX, so it asks for sample "hall" of a sound called
                        "ir" that does not exist, and you get no reverb.
  Example: s("bd sd [~ bd] sd").room(.8).ir("<shaker_large:0 shaker_large:2>")
.irspeed(n) / .irbegin(0-1)   resample / trim the impulse response

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
Strudel hands the scale name to tonal.js after replacing ":" with " ", so a
multi-word scale name uses colons between the WORDS. Camel-case names such as
"bebopMajor" or "wholetone" are not scales tonal knows — they throw and the
layer plays NOTHING.

- bebop, bebop:major, bebop:minor, bebop:locrian, minor:bebop
- whole:tone, augmented, diminished, half-whole:diminished
- persian, arabian, chinese, indian, egyptian, balinese
- prometheus, enigmatic, scriabin, flamenco, gypsy, oriental
- hirajoshi, iwato, kumoi, kumoijoshi, in-sen, pelog, ritusen
- purvi:raga, todi:raga, kafi:raga, malkos:raga
- major:pentatonic, minor:pentatonic (NOT "minPent"), major:blues, minor:blues
- harmonic:minor, harmonic:major, melodic:minor, lydian:dominant,
  phrygian:dominant, hungarian:minor, ukrainian:dorian
- And many more. Write the tonic, a colon, then the scale words joined by
  colons.

For exotic scales, n() with scale degrees is easier than note() with note names:
n("0 2 4 6 7").scale("C4:hirajoshi")
// C4:hirajoshi is C D Eb G Ab, so degrees 0 2 4 6 7 sound C4 Eb4 Ab4 D5 Eb5
// — much easier than spelling those out by name

If a pattern with .scale() plays nothing at all, the scale name is wrong —
@strudel/tonal throws "Invalid scale name" and the whole layer is dropped.

## Chord Voicings
voicing("C^7")                auto voice-led chord
voicing("<C^7 D-7 G7 C^7>")   chord progression with voice leading

USE iREAL SYMBOLS. The default dictionary is "ireal", whose keys are iReal Pro
chord suffixes. A symbol it does not know voices to NOTHING — silently, and
only for that chord, so a progression can half-disappear while still making
sound. "Cmaj7" is the classic casualty: it yields zero notes. Spell it "C^7"
or "CM7".

  major 7th     C^7   CM7        (NOT "Cmaj7")
  minor 7th     C-7   Cm7
  dominant 7th  C7
  half-dim      Ch7   Cm7b5
  diminished    Co7
  major triad   C           minor triad   C-   Cm
  6th           C6    sixth-ninth  C69     add9   Cadd9
  altered/ext   C7b9  C7#9  C7#11  C13  C^9  C-9  C-11

Check every chord in a progression, not just the first. If a section sounds
thin, one symbol in it probably voiced to silence.

Config: .anchor("c4") .mode("below") .dict("lefthand")

Voicing dictionaries: "ireal" (default), "ireal-ext", "lefthand", "triads",
"guidetones", "legacy". Add your own with addVoicings(name, { ... }).`,
};
