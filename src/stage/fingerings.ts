/**
 * @file Fingering charts for the keyed woodwinds the Stage draws — the Boehm
 * concert flute and the B♭ clarinet: which keys are closed or pressed for each
 * note. A learner may copy what the figure shows, so only verified entries are
 * here; a note with no entry shows no fingering (the mouthpiece still lights).
 *
 * Provenance (2026-10-19). Researched against three sources per instrument —
 * the Woodwind Fingering Guide's basic charts (wfg.woodwind.org, cl_bas_1/2,
 * fl_bas_1/2/3), Yamaha's fingering-chart PDFs (2021) and UNSW Music
 * Acoustics' per-note pages — keeping only fingerings at least two agree on.
 * Re-checked by hand against WFG's own text: flute C4–C6 and clarinet written
 * E3–C6, every row, including which hand's little finger plays each pinky key
 * (WFG writes a left-pinky key before the "|", a right-pinky key after it).
 * The flute's third octave (D6–C7) rests on the research pass alone; B♭6 and
 * B6 on two of the three sources.
 *
 * Judgement calls: B♭4/B♭5 use the one-and-one fingering (thumb B, L1, R1,
 * E♭), which WFG lists as basic beside the thumb-B♭ lever; for clarinet E3/B4
 * and F♯3/C♯5 the right pinky holds F/C while the left plays E or F♯
 * (Yamaha's primary; WFG lists it for "use in combination with F3 or C5").
 */
export interface FingeringChart {
  instrument: string;
  /** Semitones added to the SOUNDING pitch to get the WRITTEN pitch the chart is keyed by (flute 0, B♭ clarinet 2). */
  writtenOffset: number;
  /** Every key name the chart uses, mouthpiece end first. */
  keys: readonly string[];
  /** The main holes/plates, top to bottom: pressing one plays the note with it and every one above it closed. */
  sequence: readonly string[];
  /** Keys held down with most notes (the flute's E♭), allowed alongside a sequence fingering. */
  held: readonly string[];
  /** Written MIDI pitch → the keys closed or pressed ([] = nothing pressed, e.g. the clarinet's open G). */
  chart: Readonly<Record<number, readonly string[]>>;
}

/**
 * Boehm concert flute in C (GM program 73), C foot, closed G#. Range C4 (60) to C7 (96).
 *
 * Key names:
 * - thumbB: left-thumb B-natural lever (the "T" of most charts).
 * - L1, L2, L3: left index, middle, ring plates.
 * - Gs: left-pinky G# key.
 * - R1, R2, R3: right index, middle, ring plates.
 * - trill1: right-hand D trill key (between R1 and R2), used only for Bb6.
 * - trill2: right-hand D# trill key (between R2 and R3), used only for B6.
 * - Eb: right-pinky D#/Eb key. It is held down for most notes. It is UP for C4, C#4,
 *   D4, D5, Bb6, B6 and C7. With Eb pressed, the low-D fingering plays D#4.
 * - Cs, C: foot-joint C# and C rollers. Pressing C also closes the C# pad mechanically,
 *   but the player presses only the C roller.
 *
 * Bb4 and Bb5 use the "one-and-one" fingering (thumbB L1 R1 Eb). The thumb Bb
 * (Briccialdi) lever is a common alternate and is not used here; see SOURCES.md.
 */
export const FLUTE: FingeringChart = {
  instrument: "flute",
  writtenOffset: 0,
  sequence: ["thumbB", "L1", "L2", "L3", "R1", "R2", "R3"],
  held: ["Eb"],
  keys: ["thumbB", "L1", "L2", "L3", "Gs", "R1", "trill1", "R2", "trill2", "R3", "Eb", "Cs", "C"],
  chart: {
    // First octave
    60: ["thumbB", "L1", "L2", "L3", "R1", "R2", "R3", "C"], // C4
    61: ["thumbB", "L1", "L2", "L3", "R1", "R2", "R3", "Cs"], // C#4
    62: ["thumbB", "L1", "L2", "L3", "R1", "R2", "R3"], // D4 (Eb key UP)
    63: ["thumbB", "L1", "L2", "L3", "R1", "R2", "R3", "Eb"], // D#4/Eb4
    64: ["thumbB", "L1", "L2", "L3", "R1", "R2", "Eb"], // E4
    65: ["thumbB", "L1", "L2", "L3", "R1", "Eb"], // F4
    66: ["thumbB", "L1", "L2", "L3", "R3", "Eb"], // F#4 (ring finger)
    67: ["thumbB", "L1", "L2", "L3", "Eb"], // G4
    68: ["thumbB", "L1", "L2", "L3", "Gs", "Eb"], // G#4
    69: ["thumbB", "L1", "L2", "Eb"], // A4
    70: ["thumbB", "L1", "R1", "Eb"], // A#4/Bb4 (one-and-one)
    71: ["thumbB", "L1", "Eb"], // B4
    72: ["L1", "Eb"], // C5
    73: ["Eb"], // C#5
    // Second octave
    74: ["thumbB", "L2", "L3", "R1", "R2", "R3"], // D5 (L1 up, Eb UP)
    75: ["thumbB", "L2", "L3", "R1", "R2", "R3", "Eb"], // D#5/Eb5
    76: ["thumbB", "L1", "L2", "L3", "R1", "R2", "Eb"], // E5
    77: ["thumbB", "L1", "L2", "L3", "R1", "Eb"], // F5
    78: ["thumbB", "L1", "L2", "L3", "R3", "Eb"], // F#5
    79: ["thumbB", "L1", "L2", "L3", "Eb"], // G5
    80: ["thumbB", "L1", "L2", "L3", "Gs", "Eb"], // G#5
    81: ["thumbB", "L1", "L2", "Eb"], // A5
    82: ["thumbB", "L1", "R1", "Eb"], // A#5/Bb5 (one-and-one)
    83: ["thumbB", "L1", "Eb"], // B5
    84: ["L1", "Eb"], // C6
    85: ["Eb"], // C#6
    // Third octave
    86: ["thumbB", "L2", "L3", "Eb"], // D6
    87: ["thumbB", "L1", "L2", "L3", "Gs", "R1", "R2", "R3", "Eb"], // D#6/Eb6
    88: ["thumbB", "L1", "L2", "R1", "R2", "Eb"], // E6
    89: ["thumbB", "L1", "L3", "R1", "Eb"], // F6
    90: ["thumbB", "L1", "L3", "R3", "Eb"], // F#6
    91: ["L1", "L2", "L3", "Eb"], // G6 (no thumb)
    92: ["L2", "L3", "Gs", "Eb"], // G#6 (no thumb)
    93: ["thumbB", "L2", "R1", "Eb"], // A6
    94: ["thumbB", "R1", "trill1"], // A#6/Bb6 (2 of 3 sources; see SOURCES.md)
    95: ["thumbB", "L1", "L3", "trill2"], // B6 (2 of 3 sources; see SOURCES.md)
    96: ["L1", "L2", "L3", "Gs", "R1"], // C7 (C foot, no gizmo)
  },
};

/**
 * B-flat soprano clarinet (GM program 71), Boehm 17-key/6-ring system.
 * Keyed by WRITTEN pitch, E3 (52) to C6 (84). It sounds a major second lower, so
 * written = sounding + 2.
 *
 * Key names:
 * - Reg: register (speaker) key, left thumb. T: left thumb hole.
 * - A, Gs: throat A key and throat G# key (left index finger).
 * - L1, L2, L3 / R1, R2, R3: left- and right-hand ring/hole fingers.
 * - side4: lowest right-hand side key (the Eb/Bb side key). Used for D#4 and Bb5 only.
 *   side1-3 and the left-hand Eb_Bb sliver key are not used by any first-choice fingering.
 * - Pinky keys are named by their chalumeau (low-register) note:
 *     LP_E  = left E/B key      LP_Fs = left F#/C# key
 *     LP_Cs = left C#/G# key (ADDED NAME: needed for C#4 and G#5. No vocabulary name fits:
 *             under the low-register-note rule, LP_Gs would mean a left G#/D# key.)
 *     RP_F  = right F/C key     RP_Gs = right G#/D# (Ab/Eb) key
 *   LP_F, RP_E and RP_Fs are acoustically identical alternates and are not used here.
 * - Where the left or right pinky is a free choice (E3/B4, F3/C5, F#3/C#5), this chart
 *   follows Yamaha's marked primary fingering, which the other two sources also list:
 *   E3/B4 = LP_E + RP_F, F3/C5 = RP_F, F#3/C#5 = LP_Fs + RP_F. See SOURCES.md.
 * - Clarion notes B4 to C6 are the chalumeau fingering a twelfth lower plus Reg.
 */
export const CLARINET: FingeringChart = {
  instrument: "clarinet",
  writtenOffset: 2,
  sequence: ["T", "L1", "L2", "L3", "R1", "R2", "R3"],
  held: [],
  keys: [
    "Reg", "T", "A", "Gs", "L1", "L2", "L3",
    "LP_Cs", "LP_E", "LP_Fs", "side4",
    "R1", "R2", "R3", "RP_Gs", "RP_F",
  ],
  chart: {
    // Chalumeau
    52: ["T", "L1", "L2", "L3", "R1", "R2", "R3", "LP_E", "RP_F"], // E3
    53: ["T", "L1", "L2", "L3", "R1", "R2", "R3", "RP_F"], // F3
    54: ["T", "L1", "L2", "L3", "R1", "R2", "R3", "LP_Fs", "RP_F"], // F#3
    55: ["T", "L1", "L2", "L3", "R1", "R2", "R3"], // G3 (no pinky keys)
    56: ["T", "L1", "L2", "L3", "R1", "R2", "R3", "RP_Gs"], // G#3
    57: ["T", "L1", "L2", "L3", "R1", "R2"], // A3
    58: ["T", "L1", "L2", "L3", "R1"], // A#3/Bb3
    59: ["T", "L1", "L2", "L3", "R2"], // B3 (fork: R2 only)
    60: ["T", "L1", "L2", "L3"], // C4
    61: ["T", "L1", "L2", "L3", "LP_Cs"], // C#4
    62: ["T", "L1", "L2"], // D4
    63: ["T", "L1", "L2", "side4"], // D#4/Eb4
    64: ["T", "L1"], // E4
    65: ["T"], // F4
    66: ["L1"], // F#4 (thumb off)
    // Throat
    67: [], // G4 (open G: nothing pressed)
    68: ["Gs"], // G#4
    69: ["A"], // A4
    70: ["Reg", "A"], // A#4/Bb4 (thumb on register key, thumb hole open)
    // Clarion = chalumeau + Reg (a twelfth higher)
    71: ["Reg", "T", "L1", "L2", "L3", "R1", "R2", "R3", "LP_E", "RP_F"], // B4
    72: ["Reg", "T", "L1", "L2", "L3", "R1", "R2", "R3", "RP_F"], // C5
    73: ["Reg", "T", "L1", "L2", "L3", "R1", "R2", "R3", "LP_Fs", "RP_F"], // C#5
    74: ["Reg", "T", "L1", "L2", "L3", "R1", "R2", "R3"], // D5
    75: ["Reg", "T", "L1", "L2", "L3", "R1", "R2", "R3", "RP_Gs"], // D#5
    76: ["Reg", "T", "L1", "L2", "L3", "R1", "R2"], // E5
    77: ["Reg", "T", "L1", "L2", "L3", "R1"], // F5
    78: ["Reg", "T", "L1", "L2", "L3", "R2"], // F#5
    79: ["Reg", "T", "L1", "L2", "L3"], // G5
    80: ["Reg", "T", "L1", "L2", "L3", "LP_Cs"], // G#5
    81: ["Reg", "T", "L1", "L2"], // A5
    82: ["Reg", "T", "L1", "L2", "side4"], // A#5/Bb5
    83: ["Reg", "T", "L1"], // B5
    84: ["Reg", "T"], // C6
  },
};

/** The keys for a sounding pitch (possibly none: open G), or null when the chart has no verified fingering for it. */
export function fingeringFor(chart: FingeringChart, sounding: number): readonly string[] | null {
  return chart.chart[sounding + chart.writtenOffset] ?? null;
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((k) => b.includes(k));

/**
 * What pressing one key plays (a sounding pitch), the way a learner thinks of it:
 * a main hole closes itself and every one above it ("three fingers down: G");
 * any other key plays the lowest charted note that uses it (the flute's G♯ key →
 * G♯4, not the G♯6 that needs fewer fingers; the clarinet's register key → B♭4).
 * The mouthpiece (`""`) plays the note with the fewest keys pressed.
 */
export function pitchForKey(chart: FingeringChart, key: string): number | null {
  const entries = Object.entries(chart.chart)
    .map(([w, keys]) => ({ pitch: Number(w) - chart.writtenOffset, keys }))
    .sort((a, b) => a.pitch - b.pitch);
  if (!key) return entries.reduce<(typeof entries)[number] | null>((best, e) => (!best || e.keys.length < best.keys.length ? e : best), null)?.pitch ?? null;
  const i = chart.sequence.indexOf(key);
  if (i >= 0) {
    const closed = chart.sequence.slice(0, i + 1);
    const match = entries.find((e) => sameSet(e.keys, closed) || sameSet(e.keys.filter((k) => !chart.held.includes(k)), closed));
    if (match) return match.pitch;
  }
  // Off the main sequence: the lowest fingering that uses the key, with any OTHER extra
  // key let go — what this key alone adds. The clarinet's right-pinky F/C key first
  // appears in E3 (with the left-pinky E key); alone it gives F3.
  const lowest = entries.find((e) => e.keys.includes(key));
  if (!lowest) return null;
  const own = lowest.keys.filter((k) => k === key || chart.sequence.includes(k));
  const alone = entries.find((e) => e.keys.includes(key) && sameSet(e.keys.filter((k) => !chart.held.includes(k)), own.filter((k) => !chart.held.includes(k))));
  return (alone ?? lowest).pitch;
}
