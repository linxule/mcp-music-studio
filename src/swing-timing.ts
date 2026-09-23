/**
 * @file Put abcjs's note highlight on the same swung timeline as its audio
 *       (#34). Pure: no DOM, no abcjs import.
 *
 * abcjs swings only the audio. `addSwing()` in synth/create-synth.js runs
 * during `prime()` on the flattened note map. The highlight timer
 * (`TimingCallbacks`, built by `SynthController.go()` from `tune.setTiming()`)
 * stays on the straight grid, so a swung off-beat lit up early: by 16% of a
 * beat at swing 66, about 80 ms at ♩=120.
 *
 * This module does NOT copy `addSwing`. The widget passes abcjs's public
 * `sequenceCallback` synth option. `prime()` calls it with the note map right
 * after `addSwing` has moved the notes, so the widget holds abcjs's own
 * answer, quirks included: chords and notes next to shorter ones are never
 * swung, X/8 meters swing sixteenths, swing clamps at 75, and pickups are
 * offset. Comparing that with the straight flattened sequence
 * (`midiBuffer.flattened`) gives each note's swing delay. The delays are then
 * applied to the timer's events.
 *
 * ## How notes are matched to timer events
 *
 * Both sides carry the ABC `startChar` of the element that produced them.
 * Occurrences are paired per `startChar` in time order, so repeats work
 * without converting between the two timelines. The i-th time a character
 * sounds pairs with the i-th timer event that lists it. A character whose
 * counts disagree is skipped rather than guessed. That covers a rest (no
 * notes) and the second half of a tie (merged into the first note). A trill's
 * pieces carry no `startChar` from abcjs, so they have nothing to apply.
 * Skipped events keep abcjs's straight timing, so the worst case is the old
 * behaviour.
 *
 * ## The approximation
 *
 * A timer event merges every voice that starts at that instant, but swing is
 * decided per track. When one voice's note at an instant is swung and
 * another's is not, the event moves by the swung delay: the highlight follows
 * the note that moved. The per-track rule makes this rare. Two voices on the
 * same off-beat with the same rhythm either both swing or both do not.
 */

/** The fields of a flattened (`tune.setUpAudio()`) track event this reads. */
export interface FlatEvent {
  cmd: string;
  start?: number;
  duration?: number;
  startChar?: number;
}

/** The fields of an abcjs note-map entry (`sequenceCallback`) this reads. */
export interface NoteMapNote {
  start: number;
  startChar?: number;
}

/** The fields of a `TimingCallbacks.noteTimings` entry this reads and moves. */
export interface TimingEventLike {
  milliseconds: number;
  type?: string;
  startCharArray?: ReadonlyArray<number | null | undefined>;
}

/** Below this (in whole notes) a start did not move. */
const EPSILON = 1e-9;

/**
 * Swing delay, in whole notes, for each sounding occurrence of each
 * `startChar`, in time order.
 *
 * `createNoteMap` (abcjs synth/create-note-map.js) builds the note map from the
 * flattened tracks one-for-one, skipping only zero-length notes and rounding
 * starts to 1e-6. So the k-th sounding note of a flattened track is the k-th
 * entry of the same track in the note map. A track whose counts disagree
 * (a future abcjs changing that) is skipped entirely.
 */
export function swingDelaysByChar(
  flattenedTracks: ReadonlyArray<ReadonlyArray<FlatEvent>>,
  swungTracks: ReadonlyArray<ReadonlyArray<NoteMapNote>>,
): Map<number, number[]> {
  // char -> (straight start -> largest delay among the notes starting there)
  const byChar = new Map<number, Map<number, number>>();
  const trackCount = Math.min(flattenedTracks.length, swungTracks.length);
  for (let t = 0; t < trackCount; t++) {
    const straight = flattenedTracks[t]!.filter(
      (event) => event.cmd === "note" && (event.duration ?? 0) > 0,
    );
    const swung = swungTracks[t]!;
    if (straight.length !== swung.length) continue;
    for (let k = 0; k < straight.length; k++) {
      const char = straight[k]!.startChar;
      if (typeof char !== "number") continue;
      const start = Math.round((straight[k]!.start ?? 0) * 1e6) / 1e6;
      const delay = Math.max(0, swung[k]!.start - start);
      let starts = byChar.get(char);
      if (!starts) byChar.set(char, (starts = new Map()));
      starts.set(start, Math.max(starts.get(start) ?? 0, delay));
    }
  }
  const delays = new Map<number, number[]>();
  for (const [char, starts] of byChar) {
    delays.set(
      char,
      [...starts.entries()].sort((a, b) => a[0] - b[0]).map(([, delay]) => delay),
    );
  }
  return delays;
}

/**
 * Move every timer event whose notes abcjs swung, in place, and keep the array
 * sorted the way `TimingCallbacks` needs it. Returns how many events moved.
 *
 * Only `milliseconds` changes. Nothing else the timer derives needs to follow:
 *  - `lastMoment` is the closing `end` event's time, and that event never
 *    swings. A swung note still starts before its own end.
 *  - `beatStarts` come from `millisecondsPerBeat`, not from events.
 *  - `lineEndTimings` hold the straight time of each line's first event, and
 *    only reach `cursorControl.onLineEnd`, which this widget doesn't use. A
 *    line normally opens on a downbeat anyway.
 * `noteTimings` is the same array object as `tune.noteTimings`, and each
 * `go()` rebuilds it straight through `setTiming()`, so a shift never
 * compounds across re-primes.
 */
export function applySwingToTimings(
  timings: TimingEventLike[],
  delaysByChar: ReadonlyMap<number, readonly number[]>,
  msPerWholeNote: number,
): number {
  if (!(msPerWholeNote > 0) || delaysByChar.size === 0) return 0;

  // Characters whose sounding occurrences don't line up with their timer
  // occurrences are not guessed at.
  const occurrences = new Map<number, number>();
  for (const event of timings) {
    if (event.type !== "event") continue;
    for (const char of event.startCharArray ?? []) {
      if (typeof char === "number") occurrences.set(char, (occurrences.get(char) ?? 0) + 1);
    }
  }

  const cursor = new Map<number, number>();
  let moved = 0;
  for (const event of timings) {
    if (event.type !== "event") continue;
    let delay = 0;
    for (const char of event.startCharArray ?? []) {
      if (typeof char !== "number") continue;
      const index = cursor.get(char) ?? 0;
      cursor.set(char, index + 1);
      const list = delaysByChar.get(char);
      if (!list || list.length !== occurrences.get(char)) continue;
      delay = Math.max(delay, list[index] ?? 0);
    }
    if (delay > EPSILON) {
      event.milliseconds += delay * msPerWholeNote;
      moved++;
    }
  }

  if (moved > 0) {
    // Same order abcjs's setupEvents produces: by time, a bar before a note
    // at the same instant. Array.prototype.sort is stable.
    timings.sort((a, b) => {
      const diff = a.milliseconds - b.milliseconds;
      if (diff !== 0) return diff;
      if (a.type === b.type) return 0;
      return a.type === "bar" ? -1 : b.type === "bar" ? 1 : 0;
    });
  }
  return moved;
}

/** Everything `alignTimerWithSwing` needs from a primed SynthController. */
export interface PrimedSwingState {
  timings: TimingEventLike[];
  flattenedTracks: ReadonlyArray<ReadonlyArray<FlatEvent>>;
  swungTracks: ReadonlyArray<ReadonlyArray<NoteMapNote>>;
  /** CreateSynth's `millisecondsPerMeasure` (already warped). */
  millisecondsPerMeasure: number;
  /** CreateSynth's `meterSize` (meter num / den): measures to whole notes. */
  meterSize: number;
}

/**
 * Shift the timer onto the swung timeline, converting whole notes to
 * milliseconds exactly as `prime()` places audio:
 * `tempoMultiplier = millisecondsPerMeasure / 1000 / meterSize` seconds per
 * whole note (create-synth.js). The warp is already in
 * `millisecondsPerMeasure`, and a drum intro or pickup sits in both the
 * flattened and the swung starts, so neither needs separate handling.
 */
export function alignTimerWithSwing(state: PrimedSwingState): number {
  if (!(state.meterSize > 0)) return 0;
  return applySwingToTimings(
    state.timings,
    swingDelaysByChar(state.flattenedTracks, state.swungTracks),
    state.millisecondsPerMeasure / state.meterSize,
  );
}
