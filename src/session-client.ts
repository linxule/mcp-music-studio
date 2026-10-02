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

import { isHumanEvent, type NewEvent, type QueuedPattern } from "./shared/session.js";

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

export type SessionStatus = "connecting" | "live" | "retrying" | "parked" | "gone";

export interface SessionClientEnv {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Wall clock (ms); Date.now when absent. */
  now?(): number;
  clock(): PlayerClock;
  apply(pattern: QueuedPattern): Promise<ApplyOutcome>;
  /** The session is gone (expired or never existed). */
  onGone?(): void;
  /** Connection state, for a status badge. */
  onStatus?(status: SessionStatus): void;
  /** Whether the model is listening (get-session with wait) right now. */
  onListening?(listening: boolean): void;
  /**
   * A Pass a listening model "heard" got no answer on the player (no update,
   * no new listen) within PASS_ANSWER_MS: its read may never have reached the
   * model. The next Pass goes to the chat (the model is not listening).
   */
  onPassUnanswered?(): void;
}

/** Batch window for ordinary events (taps); reports and answers go at once. */
export const FLUSH_DELAY_MS = 1500;
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];
/** Comfortably under the 64 KiB keepalive body cap (UTF-8 can be 3 bytes/char). */
const KEEPALIVE_MAX_CHARS = 20_000;
/** How often the player's state is compared with what the server last heard. */
export const STATE_WATCH_MS = 1000;
/** How long a heard Pass may go without any answer on the player. */
export const PASS_ANSWER_MS = 90_000;
/**
 * A player that has not played and has not been touched for this long stops
 * polling. Every held poll keeps the session's Durable Object awake (billed
 * wall-clock), and the heartbeat kept a forgotten tab's session alive forever.
 * Play, or any edit/tap/control/Pass, rejoins.
 */
export const IDLE_PARK_MS = 30 * 60_000;

export class SessionClient {
  private queue: NewEvent[] = [];
  private flushTimer: unknown = null;
  private stopped = false;
  private rev = 0;
  private poll: AbortController | null = null;
  private failures = 0;
  /** The play state the current poll told the server. */
  private sentState: string | null = null;
  /** A heard Pass awaiting an answer: the rev it was sent at, and what listening did since. */
  private passWatch: { timer: unknown; rev: number; quiet: boolean; relistened: boolean } | null = null;
  /** Last time the player was playing or the human did something. */
  private lastLively: number;
  private parked = false;
  /** Bumped per poll loop, so a loop left over from before a park exits. */
  private loopGen = 0;

  constructor(
    readonly origin: string,
    readonly id: string,
    private readonly env: SessionClientEnv,
    /** The rev the player already shows (a joined page): don't re-apply it or older. */
    startRev = 0,
  ) {
    this.rev = Math.max(0, Math.floor(startRev) || 0);
    this.lastLively = this.now();
  }

  private now(): number {
    return this.env.now?.() ?? Date.now();
  }

  /** Whether the client stopped polling because the player sat idle. */
  get isParked(): boolean {
    return this.parked;
  }

  private get base(): string {
    return `${this.origin}/session/${this.id}`;
  }

  start(join: Omit<Extract<NewEvent, { t: "joined" }>, "t">): void {
    this.log({ t: "joined", ...join }, true);
    void this.loop(++this.loopGen);
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
      const state = this.env.clock().state;
      if (state === "playing") this.lastLively = this.now();
      if (this.parked) {
        if (state === "playing") this.unpark();
      } else if (this.now() - this.lastLively >= IDLE_PARK_MS) {
        this.park();
      } else if (this.sentState !== null && state !== this.sentState) {
        this.nudge();
      }
      this.watchState();
    }, STATE_WATCH_MS);
  }

  stop(): void {
    this.stopped = true;
    this.poll?.abort();
    if (this.flushTimer !== null) this.env.clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.clearPassWatch();
    void this.flush();
  }

  /** Re-poll now, so the server hears a state change (stop/play) promptly. */
  nudge(): void {
    this.poll?.abort();
  }

  log(event: NewEvent, now = false): void {
    if (this.stopped && event.t !== "pass") return;
    if (isHumanEvent(event)) {
      this.lastLively = this.now();
      if (this.parked) this.unpark();
    }
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
    const heard = body?.listening === true;
    if (heard) this.watchPassAnswer();
    return heard;
  }

  /**
   * "Heard" only means a get-session(wait) was holding when the Pass landed;
   * its reply can still be lost on the way to the model (a host timeout, a
   * dropped turn). An answer shows up here as a new rev or as the model
   * listening again after the listen ended — watch for one (Kimi review).
   */
  private watchPassAnswer(): void {
    this.clearPassWatch();
    const watch = { timer: null as unknown, rev: this.rev, quiet: false, relistened: false };
    watch.timer = this.env.setTimeout(() => {
      if (this.passWatch !== watch) return;
      this.passWatch = null;
      if (this.stopped || this.rev > watch.rev || watch.relistened) return;
      this.env.onPassUnanswered?.();
    }, PASS_ANSWER_MS);
    this.passWatch = watch;
  }

  private clearPassWatch(): void {
    if (this.passWatch) this.env.clearTimeout(this.passWatch.timer);
    this.passWatch = null;
  }

  private noteListening(value: unknown): void {
    const listening = value === "1" || value === true ? true : value === "0" || value === false ? false : null;
    if (listening === null) return;
    // A "1" from a reply that left before the Pass woke the listener is not
    // a new listen: count one only after a "0".
    if (this.passWatch) {
      if (!listening) this.passWatch.quiet = true;
      else if (this.passWatch.quiet) this.passWatch.relistened = true;
    }
    this.env.onListening?.(listening);
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
      if (!this.stopped && !this.parked) this.env.onStatus?.("live");
      const reply = (await res.json().catch(() => null)) as { listening?: boolean } | null;
      this.noteListening(reply?.listening);
      return reply;
    } catch {
      // Dropped: a report or tap is not worth a retry storm.
      return null;
    }
  }

  private park(): void {
    if (this.parked || this.stopped) return;
    this.parked = true;
    this.log(
      {
        t: "report",
        text:
          `Player idle for ${Math.round(IDLE_PARK_MS / 60_000)} min (stopped, untouched): it stopped polling. ` +
          "It rejoins when the human presses Play or edits; an update-session queued now plays then.",
      },
      true,
    );
    this.poll?.abort();
    this.env.onStatus?.("parked");
  }

  private unpark(): void {
    if (!this.parked || this.stopped) return;
    this.parked = false;
    this.lastLively = this.now();
    void this.loop(++this.loopGen);
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

  private async loop(gen: number): Promise<void> {
    this.env.onStatus?.("connecting");
    while (!this.stopped && !this.parked && gen === this.loopGen) {
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
      // Parked (or replaced) while the reply was on its way: a queued pattern
      // stays on the server and arrives on rejoin.
      if (this.parked || gen !== this.loopGen) return;
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
