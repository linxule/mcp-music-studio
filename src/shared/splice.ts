// =============================================================================
// Splice two patterns at a cycle — the live session's quantized swap
//
// Strudel patterns are pure functions of time, so "the old pattern until cycle
// B, the new one from B" is exact: take the old one's events that START before
// B and the new one's that start at or after it. An event already sounding at
// B rings out; nothing is cut or doubled. The widget hands this to the
// scheduler for one evaluation (src/strudel-app.ts, installSplice), so the swap
// lands on the bar even though the code was evaluated a moment earlier.
// =============================================================================

interface HapLike {
  whole?: { begin: unknown } | null;
  part: { begin: unknown };
}
interface PatternLike {
  filterHaps(keep: (hap: HapLike) => boolean): PatternLike;
}

/** Where an event starts, as a number (Strudel times are Fractions). */
export function hapStart(hap: HapLike): number {
  return Number((hap.whole ?? hap.part).begin);
}

export function spliceAt<P extends PatternLike>(
  previous: P,
  next: P,
  boundary: number,
  stack: (...patterns: PatternLike[]) => P,
): P {
  return stack(
    previous.filterHaps((hap) => hapStart(hap) < boundary),
    next.filterHaps((hap) => hapStart(hap) >= boundary),
  );
}
