/**
 * @file Practice mode for the sheet-music widget: which voice a note belongs
 * to, which voices are muted, and which stretch of the timeline a selection
 * covers. Pure: no DOM, no abcjs import; the shapes below are the parts of
 * abcjs 6.7.1's parsed tune and TimingCallbacks events these functions read.
 */

/** The slice of a parsed tune's `lines` read here (abcjs `TuneLine`). */
export interface TuneLineLike {
  staff?: Array<{
    clef?: { type?: string };
    title?: string[];
    voices?: Array<Array<{ el_type?: string; startChar?: number }>>;
  }>;
}

export interface TuneVoices {
  /** Sequencer voice index of every note, keyed by its `startChar`. */
  voiceOf: Map<number, number>;
  /** One label per voice, in `voicesOff` order. */
  names: string[];
}

/**
 * Number the voices the way abcjs's sequencer does (abc_midi_sequencer.js):
 * per line, every voice of every staff in order, skipping TAB staves. That
 * number is what the `voicesOff` synth option takes.
 */
export function tuneVoices(lines: readonly TuneLineLike[]): TuneVoices {
  const voiceOf = new Map<number, number>();
  const names: string[] = [];
  for (const line of lines) {
    if (!line.staff) continue;
    let voice = 0;
    for (const staff of line.staff) {
      if (staff.clef?.type === "TAB") continue;
      (staff.voices ?? []).forEach((elements, k) => {
        names[voice] ??= staff.title?.[k]?.trim() || `Voice ${voice + 1}`;
        for (const el of elements) {
          if (el.el_type === "note" && typeof el.startChar === "number") voiceOf.set(el.startChar, voice);
        }
        voice++;
      });
    }
  }
  return { voiceOf, names };
}

/**
 * Which voices the listener has muted. The voice count belongs to the score:
 * a new score with a different count starts with every voice on.
 */
export class VoiceMutes {
  private off = new Set<number>();
  private count = 0;

  /** Adopt a score's voice count; keeps the mutes only if the count is unchanged. */
  setVoiceCount(count: number): void {
    if (count !== this.count) this.off.clear();
    this.count = count;
  }

  get voiceCount(): number {
    return this.count;
  }

  isMuted(voice: number): boolean {
    return this.off.has(voice);
  }

  toggle(voice: number): void {
    if (voice < 0 || voice >= this.count) return;
    if (!this.off.delete(voice)) this.off.add(voice);
  }

  /** The `voicesOff` synth option, or undefined when every voice plays. */
  voicesOff(): number[] | undefined {
    const off = [...this.off].filter((v) => v < this.count).sort((a, b) => a - b);
    return off.length > 0 ? off : undefined;
  }
}

/** The parts of an abcjs timing event (`timer.noteTimings`) read here. */
export interface TimingEventLike {
  type?: string;
  milliseconds: number;
  startCharArray?: number[];
  endCharArray?: number[];
}

export interface LoopRange {
  startMs: number;
  endMs: number;
}

/**
 * The stretch of the timeline a text selection covers: from the first
 * selected note's onset to the end of the last one, in the timer's
 * milliseconds (so it already includes a drum intro, the tempo field and
 * swing — recompute it from each new timer).
 *
 * `from`/`to` are offsets into the ABC abcjs parsed. A note is selected when
 * its source characters overlap the selection.
 *
 * A note ends where the next note or rest of ITS voice begins (or the tune
 * ends), not at the next event: in two voices the next event may be the other
 * voice moving under a held note. Inside a repeat a selected note comes round
 * again; the range is the FIRST pass, ending before the first note heard twice.
 */
export function loopRange(
  events: readonly TimingEventLike[],
  selection: { from: number; to: number },
  voiceOf: ReadonlyMap<number, number>,
): LoopRange | null {
  const { from, to } = selection;
  if (!(to > from)) return null;
  const selectedChars = (ev: TimingEventLike): number[] => {
    if (ev.type !== "event") return [];
    const starts = ev.startCharArray ?? [];
    const ends = ev.endCharArray ?? [];
    return starts.filter((start, i) => start < to && (ends[i] ?? start + 1) > from);
  };
  const first = events.findIndex((ev) => selectedChars(ev).length > 0);
  if (first < 0) return null;

  const seen = new Set<number>();
  /** Voice (or -1, unknown) → index of its last selected event. */
  const lastIndex = new Map<number, number>();
  for (let i = first; i < events.length; i++) {
    const chars = selectedChars(events[i]);
    if (chars.some((c) => seen.has(c))) break; // the repeat comes round
    for (const c of chars) {
      seen.add(c);
      lastIndex.set(voiceOf.get(c) ?? -1, i);
    }
  }

  const voiceAt = (ev: TimingEventLike) =>
    new Set((ev.startCharArray ?? []).map((c) => voiceOf.get(c) ?? -1));
  let endMs = events[first].milliseconds;
  for (const [voice, index] of lastIndex) {
    const at = events[index].milliseconds;
    let end: number | null = null;
    for (let i = index + 1; i < events.length; i++) {
      const ev = events[i];
      if (!(ev.milliseconds > at)) continue;
      if (ev.type === "end" || voice === -1 || voiceAt(ev).has(voice)) {
        end = ev.milliseconds;
        break;
      }
    }
    endMs = Math.max(endMs, end ?? events[events.length - 1].milliseconds);
  }
  const startMs = events[first].milliseconds;
  return endMs > startMs ? { startMs, endMs } : null;
}

/**
 * Where a looping playhead belongs once the timer reaches `atMs`: back at the
 * start when it has run past the end, or got ahead of the start (the progress
 * bar, a restart from 0) — otherwise nowhere.
 */
export function loopWrapTarget(range: LoopRange, atMs: number): number | null {
  return atMs < range.startMs || atMs >= range.endMs ? range.startMs : null;
}
