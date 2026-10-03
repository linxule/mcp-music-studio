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

const halves = new WeakMap<object, { before: PatternLike; after: PatternLike; boundary: number; fire?: () => void }>();

/**
 * What `pattern` plays from `cycle` on, without spliced halves that are
 * already over. Nothing at or after `cycle` changes.
 */
export function settle<P extends PatternLike>(pattern: P, cycle: number): P {
  let p: PatternLike = pattern;
  for (let guard = 0; guard < 64; guard++) {
    const h = halves.get(p as object);
    if (!h || cycle < h.boundary) return p as P;
    // Dropping a wrapper whose bar hook never fired (no query crossed the bar
    // yet) would lose its remember() state: fire it first (Codex, round 3).
    h.fire?.();
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
  onBoundary?: () => void,
): P {
  const before = settle(previous, now);
  let spliced = stack(
    before.filterHaps((hap) => hapStart(hap) < boundary),
    next.filterHaps((hap) => hapStart(hap) >= boundary),
  );
  let fire: (() => void) | undefined;
  if (onBoundary) ({ pattern: spliced, fire } = withBoundaryHook(spliced, boundary, onBoundary));
  halves.set(spliced as object, { before, after: next, boundary, fire });
  return spliced;
}

/**
 * Call `hook` once, AT the bar: the first query whose span reaches past
 * `boundary` is split there — [begin, boundary) is computed first (the old
 * half's last notes hear the old remember() state), then the hook runs (the
 * new state is stored), then [boundary, end) (the new half's first notes hear
 * it). Every later query passes straight through.
 *
 * Splitting a query changes no onset: an event that starts before the bar and
 * rings across it comes back as two fragments of the same event, and only the
 * one holding its start is triggered — as before.
 */
function withBoundaryHook<P extends PatternLike>(pattern: P, boundary: number, hook: () => void): { pattern: P; fire: () => void } {
  let hooked = false;
  const fire = () => {
    if (hooked) return;
    hooked = true;
    try {
      hook();
    } catch {
      /* the hook never breaks the music */
    }
  };
  const Ctor = (pattern as unknown as { constructor?: new (q: (state: any) => unknown) => P }).constructor;
  const query = (pattern as unknown as { query?: (state: any) => unknown[] }).query;
  if (typeof Ctor !== "function" || typeof query !== "function") {
    fire(); // not a Strudel pattern we can wrap: apply now rather than never
    return { pattern, fire };
  }
  const steps = (pattern as unknown as { _steps?: unknown })._steps;
  const wrapped = new (Ctor as unknown as new (q: (state: any) => unknown, steps?: unknown) => P)((state: any) => {
    const span = state?.span;
    if (hooked || !(Number(span?.end) > boundary)) return query.call(pattern, state);
    if (!(Number(span.begin) < boundary)) {
      fire();
      return query.call(pattern, state);
    }
    let beforeSpan: unknown;
    let afterSpan: unknown;
    try {
      const TimeSpan = span.constructor as new (b: unknown, e: unknown) => unknown;
      // The bar as a Fraction of the same library (fraction.js refuses `new
      // Fraction(n)` here): arithmetic on the span's own begin.
      const bar = span.begin.sub(span.begin).add(boundary);
      beforeSpan = new TimeSpan(span.begin, bar);
      afterSpan = new TimeSpan(bar, span.end);
    } catch {
      // Could not split this query: apply at the bar's query instead.
      fire();
      return query.call(pattern, state);
    }
    // A pattern error in the old half propagates with the hook unfired: the
    // next crossing query splits again. One in the new half propagates too —
    // never a retry of the whole arc after the hook, which would hand the old
    // half's last notes the new state (Codex review, round 3).
    const before = query.call(pattern, state.setSpan(beforeSpan));
    fire();
    return before.concat(query.call(pattern, state.setSpan(afterSpan)));
  }, steps);
  return { pattern: wrapped, fire };
}

export interface SwapOutcome {
  ok: boolean;
  cycle: number | null;
  error?: string;
  report?: string;
}

/**
 * How a quantized swap ended, once its evaluation settled. Order matters: a
 * swap that was refused, never ran, or ran but was stopped before it could
 * take over (a cancel stops what the evaluation started) did NOT play, even
 * though its evaluation "finished" without an error (Codex review, 0.10).
 */
export function swapOutcome(o: {
  refused: boolean;
  ran: boolean;
  started: boolean;
  error: string | null;
  cancelled: string | null;
  cycle: number | null;
  report?: string;
  replaced: SwapOutcome;
}): SwapOutcome {
  if (o.refused) return o.replaced;
  if (!o.ran) return { ok: false, cycle: null, error: "the player was taken over by a newer run before this one started" };
  if (o.error) return { ok: false, cycle: null, error: o.error };
  if (!o.started) return { ok: false, cycle: null, error: o.cancelled ?? "the player was stopped before this swap took over" };
  return { ok: true, cycle: o.cycle, report: o.report };
}
