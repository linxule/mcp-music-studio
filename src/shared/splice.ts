// =============================================================================
// Splice two patterns at a cycle — the live session's quantized swap
//
// Strudel patterns are pure functions of time, so "the old pattern until cycle
// B, the new one from B" is exact: take the old one's events that START before
// B and the new one's that start at or after it. An event already sounding at
// B rings out; nothing is cut or doubled.
//
// A spliced pattern remembers its halves, so once the clock is past B the old
// half can be dropped (settle) — and a splice taken over a splice never keeps
// a chain of every pattern the session ever played (Codex review: depth 12
// after 12 swaps).
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

const halves = new WeakMap<object, { before: PatternLike; after: PatternLike; boundary: number }>();

/**
 * What `pattern` plays from `cycle` on, without spliced halves that are
 * already over. Nothing at or after `cycle` changes.
 */
export function settle<P extends PatternLike>(pattern: P, cycle: number): P {
  let p: PatternLike = pattern;
  for (let guard = 0; guard < 64; guard++) {
    const h = halves.get(p as object);
    if (!h || cycle < h.boundary) return p as P;
    p = h.after;
  }
  return p as P;
}

export function isSpliced(pattern: unknown): boolean {
  return !!pattern && typeof pattern === "object" && halves.has(pattern);
}

export function spliceAt<P extends PatternLike>(
  previous: P,
  next: P,
  boundary: number,
  stack: (...patterns: PatternLike[]) => P,
  now = -Infinity,
): P {
  const before = settle(previous, now);
  const spliced = stack(
    before.filterHaps((hap) => hapStart(hap) < boundary),
    next.filterHaps((hap) => hapStart(hap) >= boundary),
  );
  halves.set(spliced as object, { before, after: next, boundary });
  return spliced;
}
