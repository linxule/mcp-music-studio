// =============================================================================
// ABC Guide — comprehensive reference for AI systems
// Extracted from server.ts for shared use by local server + Cloudflare Worker.
// =============================================================================

export const ABC_GUIDE_TOPICS = [
  "instruments",
  "drums",
  "abc-syntax",
  "arrangements",
  "genres",
  "styles",
  "midi-directives",
] as const;

export type AbcGuideTopic = (typeof ABC_GUIDE_TOPICS)[number];

export const ABC_GUIDES: Record<AbcGuideTopic, string> = {
  instruments: `# General MIDI Instruments

Use %%MIDI program N in ABC notation to set the instrument for a voice.
The instrument parameter on play-sheet-music sets the default for the main voice.

## Piano & Chromatic Percussion (0-15)
0 Acoustic Grand Piano | 1 Bright Acoustic Piano | 4 Electric Piano 1 | 6 Harpsichord
8 Celesta | 9 Glockenspiel | 10 Music Box | 11 Vibraphone | 12 Marimba | 13 Xylophone

## Organ (16-23)
16 Hammond Organ | 19 Church Organ | 20 Reed Organ | 21 Accordion | 22 Harmonica

## Guitar (24-31)
24 Acoustic Guitar (Nylon) | 25 Acoustic Guitar (Steel) | 26 Electric Guitar (Jazz)
27 Electric Guitar (Clean) | 29 Overdriven Guitar | 30 Distortion Guitar

## Bass (32-39)
32 Acoustic Bass | 33 Electric Bass (Finger) | 34 Electric Bass (Pick) | 36 Slap Bass

## Strings (40-49)
40 Violin | 41 Viola | 42 Cello | 43 Contrabass | 44 Tremolo Strings
45 Pizzicato Strings | 46 Orchestral Harp | 48 String Ensemble 1

## Brass (56-63)
56 Trumpet | 57 Trombone | 58 Tuba | 59 Muted Trumpet | 60 French Horn
61 Brass Section

## Reed (64-71)
64 Soprano Sax | 65 Alto Sax | 66 Tenor Sax | 67 Baritone Sax
68 Oboe | 69 English Horn | 70 Bassoon | 71 Clarinet

## Pipe (72-79)
73 Flute | 74 Recorder | 75 Pan Flute | 76 Blown Bottle | 78 Whistle | 79 Ocarina

## Synth (80-103)
80 Square Lead | 81 Sawtooth Lead | 88 New Age Pad | 89 Warm Pad | 94 Halo Pad

## Ethnic (104-111)
104 Sitar | 105 Banjo | 106 Shamisen | 107 Koto | 108 Kalimba
109 Bagpipe | 110 Fiddle | 111 Shanai

## Percussive (112-119)
114 Steel Drums | 115 Woodblock | 116 Taiko Drum

## Instrument Combos That Work Well
- Jazz combo: Piano(0) + Acoustic Bass(32) + Drums
- Rock band: Electric Guitar(27) + Electric Bass(33) + Drums
- Classical: Violin(40) + Cello(42) + Piano(0)
- Folk: Acoustic Guitar(25) + Flute(73) + Violin(40)
- Latin: Acoustic Guitar(24) + Acoustic Bass(32) + Flute(73)
- Brass ensemble: Trumpet(56) + Trombone(57) + French Horn(60) + Tuba(58)
- String quartet: Violin(40) + Violin(40) + Viola(41) + Cello(42)`,

  drums: `# Drum Patterns

## Adding Drums to ABC
Use %%MIDI drum in your ABC notation. Syntax:
  %%MIDI drum <pattern> <notes...> <velocities...>

Pattern characters: d=drum hit, z=rest
Notes: MIDI percussion numbers (see below)
Velocities: 0-127 (volume for each hit)

Also set: %%MIDI drumon (enable) and optionally %%MIDI drumoff (disable)

## Key Percussion Notes
35 Acoustic Bass Drum | 36 Bass Drum 1 | 38 Acoustic Snare | 40 Electric Snare
42 Closed Hi-Hat | 44 Pedal Hi-Hat | 46 Open Hi-Hat | 49 Crash Cymbal 1
51 Ride Cymbal | 53 Ride Bell | 54 Tambourine | 56 Cowbell
75 Claves | 76 Hi Wood Block

## Ready-to-Use Patterns

### Rock (4/4)
%%MIDI drumon
%%MIDI drum dddd 36 42 38 42 90 70 100 70

### Jazz Swing (4/4)
%%MIDI drumon
%%MIDI drum dzddzd 51 0 51 51 0 42 80 0 60 80 0 50

### Bossa Nova (4/4)
%%MIDI drumon
%%MIDI drum dddddddd 36 76 38 76 36 76 38 76 80 50 70 50 80 50 70 50

### Waltz (3/4)
%%MIDI drumon
%%MIDI drum dzz 36 0 0 90 0 0

### Shuffle (4/4)
%%MIDI drumon
%%MIDI drum ddddzd 42 42 38 42 0 42 60 60 100 60 0 60

### Reggae (4/4)
%%MIDI drumon
%%MIDI drum zdzd 0 42 0 38 0 60 0 90

### March (4/4)
%%MIDI drumon
%%MIDI drum dddd 38 38 38 38 100 60 80 60

### Latin (4/4)
%%MIDI drumon
%%MIDI drum dddddddd 36 75 42 75 36 75 38 75 90 60 50 60 90 60 100 60

## Tips
- Use %%MIDI drumoff to stop drums at a specific point
- %%MIDI drumbars 1 means the pattern repeats every bar
- %%MIDI drumintro 2 adds 2 bars of drums before the melody starts
- Pattern can be any length — ABCJS automatically scales it to fit the bar
- Longer patterns allow more rhythmic detail (e.g., 8 chars for 4/4 = eighth-note resolution)`,

  "abc-syntax": `# ABC Notation Quick Reference

## Header (required)
X:1            % tune number
T:Title        % title
M:4/4          % time signature (also 3/4, 6/8, C for common time)
L:1/4          % default note length (1/4=quarter, 1/8=eighth)
Q:1/4=120      % tempo in BPM
K:C            % key signature (C, G, D, Am, Em, Bb, etc.)

## Notes
C D E F G A B  % octave below middle C to B
c d e f g a b  % middle C octave and up
C, D, E,       % octave below (comma = down)
c' d' e'       % octave above (apostrophe = up)

## Accidentals
^C = C sharp | _C = C flat | =C = C natural

## Note Lengths (relative to L: value)
C    = 1 unit     C2  = 2 units    C4  = 4 units
C/2  = half unit  C/4 = quarter    C3/2 = dotted

## Rests
z = rest (same length rules: z2, z/2, etc.)

## Bars and Structure
|     bar line           |: :| repeat
|1    first ending       |2   second ending
||    double bar         |]   final bar

## Chords and Harmony
[CEG]   simultaneous notes (chord voicing)
"C"     guitar chord symbol (placed above staff, plays with gchord)
"Am7"   jazz chord (renders above, plays accompaniment)

## Ties and Slurs
C-C    tie (same pitch)
(CDE)  slur (different pitches)

## Tuplets
(3CDE  triplet    (5CDEFG  quintuplet

## Dynamics and Articulations
!p! !pp! !f! !ff! !mf! !mp! !sfz!    dynamics
!trill! !fermata! !accent! !tenuto!   ornaments
.C = staccato

## Lyrics
w: Twin-kle twin-kle lit-tle star

## Multi-Voice
V:1 name="Melody" clef=treble
%%MIDI program 73
C D E F | G A B c |
V:2 name="Bass" clef=bass
%%MIDI program 32
C,2 G,2 | C,2 G,2 |

## Repeats and Navigation
|: ... :|       simple repeat
|1 ... :|2 ...  first/second endings
!D.C.!          da capo (repeat from start)
!D.S.!          dal segno (repeat from segno)
!coda!          coda mark
!fine!          end mark`,

  arrangements: `# Arrangement Patterns

## Two-Voice: Melody + Bass
X:1
T:Two Voice Example
M:4/4
L:1/4
K:C
V:1 name="Melody" clef=treble
%%MIDI program 73
E G A G | E C D2 |
V:2 name="Bass" clef=bass
%%MIDI program 32
C,2 G,2 | A,2 G,2 |

## Melody + Chord Symbols (auto-accompaniment)
When you include "chord" symbols like "C", "Am", "G7" above notes,
ABCJS can auto-generate bass and chord accompaniment.

Use these MIDI directives to control accompaniment:
%%MIDI gchord fzcz     % chord pattern (f=bass, z=rest, c=chord)
%%MIDI chordprog 0     % instrument for chords (0=piano)
%%MIDI bassprog 32     % instrument for bass (32=acoustic bass)
%%MIDI chordvol 70     % chord volume (0-127)
%%MIDI bassvol 80      % bass volume (0-127)

Example:
X:1
T:With Accompaniment
M:4/4
L:1/4
K:C
%%MIDI gchord fzcz
%%MIDI chordprog 24
%%MIDI bassprog 32
%%MIDI chordvol 70
%%MIDI bassvol 80
"C"E G c G | "Am"A c e c | "F"F A c A | "G"G B d B |

## Volume Balancing Guidelines
- Melody: 100-127 (loudest)
- Chords: 60-80 (supporting)
- Bass: 70-90 (foundational)
- Drums: controlled by velocity in drum pattern

## Directive Placement
Global directives (drums, gchord, bassprog, chordprog) go BEFORE any V: lines,
right after the K: line. They apply to the whole tune. Per-voice directives
(program, channel) go inside each voice block.

## Per-Voice Instrument Assignment
V:1
%%MIDI program 73
%%MIDI channel 1
V:2
%%MIDI program 42
%%MIDI channel 2
V:3
%%MIDI program 32
%%MIDI channel 3

## Panning (stereo positioning)
Panning is set via the synth options (pan parameter), not in ABC notation.
The play-sheet-music tool applies panning automatically for multi-voice pieces.`,

  genres: `# Genre Templates

Complete, working ABC examples. Use as starting points for composition.

## Jazz Standard
X:1
T:Blue Afternoon
M:4/4
L:1/8
Q:1/4=140
K:Bb
%%MIDI program 0
%%MIDI gchord fzcz
%%MIDI chordprog 0
%%MIDI bassprog 32
%%MIDI bassvol 80
%%MIDI chordvol 65
"Bbmaj7"d2 f2 d2 Bc | "Eb7"_e2 g2 e2 cB | "Dm7"d2 f2 a2 fd | "G7"g2 f2 e2 dc |
"Cm7"c2 e2 g2 ec | "F7"f2 e2 d2 cB | "Bbmaj7"d4 f4 | "Bbmaj7"d6 z2 |]

## 12-Bar Blues
X:1
T:Easy Blues
M:4/4
L:1/8
Q:1/4=100
K:G
%%MIDI program 27
%%MIDI gchord fzfz
%%MIDI chordprog 27
%%MIDI bassprog 33
"G7"G2 B2 d2 B2 | "G7"G2 B2 d2 f2 | "G7"g2 f2 d2 B2 | "G7"G4 z4 |
"C7"c2 e2 g2 e2 | "C7"c2 e2 g2 e2 | "G7"G2 B2 d2 B2 | "G7"G2 B2 d2 f2 |
"D7"d2 f2 a2 f2 | "C7"c2 e2 g2 e2 | "G7"G2 B2 d2 B2 | "D7"d4 z4 |]

## Folk Song
X:1
T:Morning Meadow
M:3/4
L:1/8
Q:1/4=108
K:D
%%MIDI program 25
"D"D2 F2 A2 | "G"B4 A2 | "A"c2 B2 A2 | "D"F4 D2 |
"Bm"B,2 D2 F2 | "G"G4 F2 | "A"E2 F2 E2 | "D"D6 |]

## Classical Minuet
X:1
T:Minuet in G
M:3/4
L:1/4
Q:1/4=120
K:G
V:1 clef=treble
%%MIDI program 40
d | "G"G A B | "C"A G F | "G"G B d | "D"A2
d | "G"B G B | "Am"A F A | "D7"G F E | "G"D2 |]
V:2 clef=bass
%%MIDI program 42
z | G,2 z | C,2 z | G,2 z | D,2
z | G,2 z | A,2 z | D,2 z | G,,2 |]

## Rock
X:1
T:Power Drive
M:4/4
L:1/8
Q:1/4=130
K:Em
%%MIDI program 29
"Em"e2 e2 e2 fg | "Em"e2 d2 B2 A2 | "C"c2 c2 c2 de | "D"d2 c2 B2 A2 |
"Em"e2 e2 g2 e2 | "Am"a2 g2 e2 d2 | "B7"B2 d2 f2 d2 | "Em"e4 z4 |]

## Bossa Nova
X:1
T:Gentle Wave
M:4/4
L:1/8
Q:1/4=130
K:C
%%MIDI program 24
%%MIDI gchord fzcfzc
%%MIDI chordprog 24
%%MIDI bassprog 32
%%MIDI bassvol 85
%%MIDI chordvol 65
"Cmaj7"e2 g2 c'2 ge | "Dm7"f2 a2 d'2 af | "G7"d2 g2 b2 gd | "Cmaj7"e4 c4 |
"Am7"c2 e2 a2 ec | "Dm7"d2 f2 a2 fd | "G7"B2 d2 g2 dB | "Cmaj7"c6 z2 |]

## Lullaby
X:1
T:Starlight Dreams
M:3/4
L:1/4
Q:1/4=72
K:F
%%MIDI program 10
"F"C F A | "Bb"B2 A | "C7"G E C | "F"F3 |
"Dm"D F A | "Bb"B2 G | "C7"E G c | "F"F3 |]`,

  styles: `# Style Presets

Set the style parameter to automatically add drums, bass, and chord accompaniment.
Your ABC notation needs guitar chord symbols ("C", "Am7", etc.) above the melody for
accompaniment to work. The style adds MIDI directives BEFORE your notation — your own
%%MIDI directives override the style defaults.

## Available Styles

### rock
- Drums: kick-snare-hihat 4/4 pattern
- Bass: Electric Bass (33), volume 85
- Chords: Electric Guitar Clean (27), volume 70
- Chord pattern: bass-chord-bass-chord
- Best for: driving rhythms, power chords, energetic pieces

### jazz
- Drums: ride cymbal swing pattern
- Bass: Acoustic Bass (32), volume 80
- Chords: Piano (0), volume 65
- Chord pattern: bass-rest-chord-rest
- Best for: standards, improvisation feel, sophisticated harmony

### bossa
- Drums: bossa nova rhythm with rim clicks
- Bass: Acoustic Bass (32), volume 85
- Chords: Nylon Guitar (24), volume 65
- Chord pattern: bass-rest-chord-bass-rest-chord
- Best for: relaxed Latin feel, smooth melodies

### waltz
- Drums: gentle bass drum on beat 1
- Bass: Acoustic Bass (32), volume 80
- Chords: Piano (0), volume 70
- Chord pattern: bass-chord-chord (oom-pah-pah)
- Best for: 3/4 time, elegant dances, lullabies

### march
- Drums: snare march pattern
- Bass: Acoustic Bass (32), volume 85
- Chords: Trumpet (56), volume 75
- Chord pattern: bass-chord-bass-chord
- Best for: 4/4 marches, ceremonial, military feel

### reggae
- Drums: offbeat emphasis
- Bass: Electric Bass (33), volume 90
- Chords: Electric Guitar Clean (27), volume 65
- Chord pattern: rest-chord-rest-chord (offbeat skank)
- Best for: laid-back grooves, syncopated rhythms

### folk
- Drums: light pattern (optional feel)
- Bass: Acoustic Bass (32), volume 75
- Chords: Steel Guitar (25), volume 70
- Chord pattern: bass-rest-chord-rest
- Best for: traditional tunes, sing-alongs, storytelling

### classical
- Drums: none
- Bass: Cello (42), volume 75
- Chords: String Ensemble (48), volume 65
- Chord pattern: bass-rest-chord-rest
- Best for: formal pieces, orchestral feel, minuets`,

  "midi-directives": `# MIDI Directives Reference

Place these in your ABC notation to control playback. Each directive starts with %%MIDI.

## Instrument
%%MIDI program <0-127>          Set instrument for current voice
%%MIDI channel <0-15>           Set MIDI channel (10 = percussion)

## Accompaniment (requires chord symbols in notation)
%%MIDI gchord <pattern>         Chord pattern: f=bass, c=chord, z=rest
%%MIDI chordprog <0-127>        Instrument for chord accompaniment
%%MIDI bassprog <0-127>         Instrument for bass line
%%MIDI chordvol <0-127>         Chord volume
%%MIDI bassvol <0-127>          Bass volume
%%MIDI gchordon                 Enable chord accompaniment
%%MIDI gchordoff                Disable chord accompaniment

Common gchord patterns:
  fzcz       = bass-rest-chord-rest (4/4 standard)
  fzczfzcz   = bass-rest-chord-rest x2 (4/4 busy)
  fzfz       = bass-rest-bass-rest (4/4 minimal)
  fzz        = bass-rest-rest (3/4 waltz)
  fcc        = bass-chord-chord (3/4 oom-pah-pah)
  zcfz       = rest-chord-bass-rest (reggae)
  fzcfzc     = bass-rest-chord-bass-rest-chord (bossa)

## Drums
%%MIDI drumon                   Enable drums
%%MIDI drumoff                  Disable drums
%%MIDI drum <pattern> <notes...> <velocities...>
%%MIDI drumbars <n>             Pattern length in bars (default 1)
%%MIDI drumintro <n>            Bars of drums before melody

## Transpose
%%MIDI transpose <n>            Transpose MIDI output by n semitones

## Dynamics
%%MIDI beat <a> <b> <c>         Accent pattern: strong, medium, weak (0-127)
%%MIDI beatmod <n>              Modify beat emphasis

## Example: Full Setup
%%MIDI program 73
%%MIDI drumon
%%MIDI drum dddd 36 42 38 42 90 70 100 70
%%MIDI gchord fzcz
%%MIDI chordprog 0
%%MIDI bassprog 32
%%MIDI chordvol 70
%%MIDI bassvol 80`,
};

export const DEFAULT_ABC_NOTATION = `X:1
T:Twinkle, Twinkle Little Star
M:4/4
L:1/4
K:C
C C G G | A A G2 | F F E E | D D C2 |
G G F F | E E D2 | G G F F | E E D2 |
C C G G | A A G2 | F F E E | D D C2 |`;
