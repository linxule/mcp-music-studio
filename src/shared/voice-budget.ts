// =============================================================================
// The voice budget — one dollar number for everything say() may cost
//
// A new spoken line (a /tts cache MISS) is the only thing in this service that
// spends money per request. Aura-2 is priced per character, so the cost of a
// line is known exactly before it is rendered: reserve it against the month's
// budget, render, and give it back if the render fails. Cached lines cost
// nothing and never touch the budget.
//
// The month is the knob (VOICE_BUDGET_USD_PER_MONTH). No single UTC day may
// spend more than a tenth of it, so a stranger scripting /tts can at worst use
// up one day's share, not the month, and voices come back the next day.
//
// Amounts are integer micro-dollars: no float drift over thousands of lines.
// Pure: the VoiceBudget Durable Object holds the ledger; tests drive this.
// =============================================================================

/** Aura-2: $0.030 per 1,000 characters = 30 micro-dollars per character. */
export const AURA2_MICRO_USD_PER_CHAR = 30;
/** When the variable is missing or unreadable. */
export const DEFAULT_VOICE_BUDGET_USD_PER_MONTH = 10;
/** The most of the month one UTC day may spend. */
export const VOICE_DAY_SHARE = 0.1;

export interface VoiceLedger {
  /** "2026-10" (UTC). */
  month: string;
  monthMicro: number;
  /** "2026-10-04" (UTC). */
  day: string;
  dayMicro: number;
}

export type ReserveResult =
  | { ok: true; ledger: VoiceLedger }
  | { ok: false; ledger: VoiceLedger; reason: "month" | "day" };

/**
 * Characters as UTF-16 code units — the unit TTS_MAX_CHARS limits, and never
 * fewer than code points (an emoji is 2), so the charge can't undercount
 * whichever way the provider counts (Codex review).
 */
export const lineChars = (text: string): number => text.length;
export const lineCostMicro = (text: string): number => lineChars(text) * AURA2_MICRO_USD_PER_CHAR;

/** The configured monthly budget in micro-dollars. 0 turns new lines off. */
export function budgetMicro(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  const usd = Number.isFinite(n) && n >= 0 ? n : DEFAULT_VOICE_BUDGET_USD_PER_MONTH;
  return Math.round(usd * 1_000_000);
}

export function dayCapMicro(monthBudgetMicro: number): number {
  return Math.floor(monthBudgetMicro * VOICE_DAY_SHARE);
}

/** The ledger as of `now`: a new month or day starts from zero. */
export function current(ledger: VoiceLedger | undefined, now: Date): VoiceLedger {
  const iso = now.toISOString();
  const month = iso.slice(0, 7);
  const day = iso.slice(0, 10);
  const base = ledger && ledger.month === month ? ledger : { month, monthMicro: 0, day, dayMicro: 0 };
  return base.day === day ? { ...base } : { ...base, day, dayMicro: 0 };
}

export function reserve(
  ledger: VoiceLedger | undefined,
  costMicro: number,
  monthBudgetMicro: number,
  now: Date,
): ReserveResult {
  const l = current(ledger, now);
  if (l.monthMicro + costMicro > monthBudgetMicro) return { ok: false, ledger: l, reason: "month" };
  if (l.dayMicro + costMicro > dayCapMicro(monthBudgetMicro)) return { ok: false, ledger: l, reason: "day" };
  return { ok: true, ledger: { ...l, monthMicro: l.monthMicro + costMicro, dayMicro: l.dayMicro + costMicro } };
}

/**
 * Give a reservation back (the model refused the render). Only from the period
 * it was charged to: a late refund for yesterday must not free today's share,
 * nor last month's free this month's (Codex review). Never below zero.
 */
export function refund(
  ledger: VoiceLedger | undefined,
  costMicro: number,
  chargedIn: { month: string; day: string },
  now: Date,
): VoiceLedger {
  const l = current(ledger, now);
  const sameMonth = chargedIn.month === l.month;
  const sameDay = sameMonth && chargedIn.day === l.day;
  return {
    ...l,
    monthMicro: sameMonth ? Math.max(0, l.monthMicro - costMicro) : l.monthMicro,
    dayMicro: sameDay ? Math.max(0, l.dayMicro - costMicro) : l.dayMicro,
  };
}

/** Dollars to a hundredth of a cent: one line costs well under a cent. */
export const usd = (micro: number): number => Math.round(micro / 100) / 10_000;
