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
  /** Whether the model is listening (get-session with wait) right now. */
  onListening?(listening: boolean): void;
}

/** Batch window for ordinary events (taps); reports and answers go at once. */
export const FLUSH_DELAY_MS = 1500;
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];
/** Comfortably under the 64 KiB keepalive body cap (UTF-8 can be 3 bytes/char). */
const KEEPALIVE_MAX_CHARS = 20_000;
/** How often the player's state is compared with what the server last heard. */
export const STATE_WATCH_MS = 1000;

export class SessionClient {
  private queue: NewEvent[] = [];
  private flushTimer: unknown = null;
  private stopped = false;
  private rev = 0;
  private poll: AbortController | null = null;
  private failures = 0;
  /** The play state the current poll told the server. */
  private sentState: string | null = null;

  constructor(
    readonly origin: string,
    readonly id: string,
    private readonly env: SessionClientEnv,
    /** The rev the player already shows (a joined page): don't re-apply it or older. */
    startRev = 0,
  ) {
    this.rev = Math.max(0, Math.floor(startRev) || 0);
  }

  private get base(): string {
    return `${this.origin}/session/${this.id}`;
  }

  start(join: Omit<Extract<NewEvent, { t: "joined" }>, "t">): void {
    this.log({ t: "joined", ...join }, true);
    void this.loop();
    this.watchState();
  }

  /**
   * The heartbeat rides on the poll, which can hang for 20 s. Whenever the
   * player's state differs from what the current poll reported (a start, a
   * stop, audio unblocked — whichever code path caused it), poll again now.
   */
  private watchState(): void {
    if (this.stopped) return;
    this.env.setTimeout(() => {
      if (this.stopped) return;
      if (this.sentState !== null && this.env.clock().state !== this.sentState) this.nudge();
      this.watchState();
    }, STATE_WATCH_MS);
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

  /** Send a Pass now; resolves whether a listening model will read it (no chat message needed). */
  async pass(cycle: number | null): Promise<boolean> {
    this.log({ t: "pass", cycle });
    const body = await this.flush();
    return body?.listening === true;
  }

  private noteListening(value: unknown): void {
    if (value === "1" || value === true) this.env.onListening?.(true);
    else if (value === "0" || value === false) this.env.onListening?.(false);
  }

  async flush(): Promise<{ listening?: boolean } | null> {
    if (this.flushTimer !== null) {
      this.env.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.queue.length) return null;
    const events = this.queue.splice(0, this.queue.length);
    const body = JSON.stringify({ events });
    try {
      const res = await this.env.fetch(`${this.base}/events`, {
        method: "POST",
        // text/plain keeps it a "simple" request: no CORS preflight.
        headers: { "content-type": "text/plain;charset=UTF-8" },
        body,
        // keepalive lets a batch outlive the frame, but the Fetch spec caps
        // keepalive bodies at 64 KiB and THROWS above it — a large code edit
        // would be lost (Kimi review). Only small batches ride it.
        keepalive: body.length < KEEPALIVE_MAX_CHARS,
      });
      if (res.status === 404) {
        this.gone();
        return null;
      }
      if (!res.ok) return null;
      if (!this.stopped) this.env.onStatus?.("live");
      const reply = (await res.json().catch(() => null)) as { listening?: boolean } | null;
      this.noteListening(reply?.listening);
      return reply;
    } catch {
      // Dropped: a report or tap is not worth a retry storm.
      return null;
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
      this.sentState = clock.state;
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
      this.noteListening(res.headers?.get?.("x-session-listening"));
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
      // Applied OFF the poll loop: a quantized swap can wait many bars for its
      // boundary, and the loop must keep polling meanwhile — it is the
      // heartbeat, and a newer update must reach apply() so the older one
      // can stand down (Kimi review).
      void this.applyAndAnswer(pattern);
    }
  }

  private async applyAndAnswer(pattern: QueuedPattern): Promise<void> {
    let outcome: ApplyOutcome;
    try {
      outcome = await this.env.apply(pattern);
    } catch (err) {
      outcome = { ok: false, cycle: null, error: (err as Error)?.message ?? String(err) };
    }
    this.log({ t: "applied", rev: pattern.rev, ...outcome }, true);
  }

  private async backoff(): Promise<void> {
    this.env.onStatus?.("retrying");
    const ms = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)];
    this.failures++;
    await this.sleep(ms);
  }
}
