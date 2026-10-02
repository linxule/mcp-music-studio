// =============================================================================
// The widget's side of a live session (src/shared/session.ts)
//
// Joins the session the tool result named, then:
//   - long-polls GET /session/<id>/next — each poll carries the player's
//     clock, so it doubles as the heartbeat get-session reports from;
//   - applies a pattern the model queued (the widget does the quantized swap),
//     and answers "applied" with the outcome, which update-session waits for;
//   - posts events (reports, taps, the human's edits, "pass") in small batches.
//
// Everything browser-specific comes in through SessionClientEnv, so
// tests/session-client.test.ts drives it with a fake fetch and fake timers.
// =============================================================================

import type { NewEvent, QueuedPattern } from "./shared/session.js";

export interface PlayerClock {
  cycle: number | null;
  cps: number | null;
  state: string;
}

export interface ApplyOutcome {
  ok: boolean;
  cycle: number | null;
  error?: string;
  report?: string;
}

export interface SessionClientEnv {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  clock(): PlayerClock;
  apply(pattern: QueuedPattern): Promise<ApplyOutcome>;
  /** The session is gone (expired or never existed). */
  onGone?(): void;
  /** Connection state, for a status badge. */
  onStatus?(status: "connecting" | "live" | "retrying" | "gone"): void;
}

/** Batch window for ordinary events (taps); reports and answers go at once. */
export const FLUSH_DELAY_MS = 1500;
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];

export class SessionClient {
  private queue: NewEvent[] = [];
  private flushTimer: unknown = null;
  private stopped = false;
  private rev = 0;
  private poll: AbortController | null = null;
  private failures = 0;

  constructor(
    readonly origin: string,
    readonly id: string,
    private readonly env: SessionClientEnv,
  ) {}

  private get base(): string {
    return `${this.origin}/session/${this.id}`;
  }

  start(join: Omit<Extract<NewEvent, { t: "joined" }>, "t">): void {
    this.log({ t: "joined", ...join }, true);
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.poll?.abort();
    if (this.flushTimer !== null) this.env.clearTimeout(this.flushTimer);
    this.flushTimer = null;
    void this.flush();
  }

  /** Re-poll now, so the server hears a state change (stop/play) promptly. */
  nudge(): void {
    this.poll?.abort();
  }

  log(event: NewEvent, now = false): void {
    if (this.stopped && event.t !== "pass") return;
    this.queue.push(event);
    if (now) {
      void this.flush();
    } else if (this.flushTimer === null) {
      this.flushTimer = this.env.setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, FLUSH_DELAY_MS);
    }
  }

  async flush(): Promise<void> {
    if (this.flushTimer !== null) {
      this.env.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.queue.length) return;
    const events = this.queue.splice(0, this.queue.length);
    try {
      const res = await this.env.fetch(`${this.base}/events`, {
        method: "POST",
        // text/plain keeps it a "simple" request: no CORS preflight.
        headers: { "content-type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({ events }),
        keepalive: true,
      });
      if (res.status === 404) this.gone();
      else if (res.ok && !this.stopped) this.env.onStatus?.("live");
    } catch {
      // Dropped: a report or tap is not worth a retry storm.
    }
  }

  private gone(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.poll?.abort();
    this.env.onStatus?.("gone");
    this.env.onGone?.();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.env.setTimeout(resolve, ms));
  }

  private async loop(): Promise<void> {
    this.env.onStatus?.("connecting");
    while (!this.stopped) {
      const clock = this.env.clock();
      const q = new URLSearchParams({ after: String(this.rev), state: clock.state });
      if (clock.cycle !== null) q.set("cycle", String(Math.round(clock.cycle * 1000) / 1000));
      if (clock.cps !== null) q.set("cps", String(clock.cps));
      this.poll = new AbortController();
      let res: Response;
      try {
        res = await this.env.fetch(`${this.base}/next?${q}`, { signal: this.poll.signal, cache: "no-store" });
      } catch {
        if (this.stopped) return;
        if (this.poll.signal.aborted) continue; // nudged: poll again at once
        await this.backoff();
        continue;
      }
      if (res.status === 404) return this.gone();
      if (res.status === 204) {
        this.failures = 0;
        this.env.onStatus?.("live");
        continue;
      }
      if (!res.ok) {
        await this.backoff();
        continue;
      }
      this.failures = 0;
      this.env.onStatus?.("live");
      let pattern: QueuedPattern;
      try {
        pattern = (await res.json()) as QueuedPattern;
      } catch {
        await this.backoff();
        continue;
      }
      if (typeof pattern?.rev !== "number" || pattern.rev <= this.rev) continue;
      this.rev = pattern.rev;
      let outcome: ApplyOutcome;
      try {
        outcome = await this.env.apply(pattern);
      } catch (err) {
        outcome = { ok: false, cycle: null, error: (err as Error)?.message ?? String(err) };
      }
      this.log({ t: "applied", rev: pattern.rev, ...outcome }, true);
    }
  }

  private async backoff(): Promise<void> {
    this.env.onStatus?.("retrying");
    const ms = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)];
    this.failures++;
    await this.sleep(ms);
  }
}
