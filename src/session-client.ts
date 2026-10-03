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

import { isHumanEvent, type NewEvent, type QueuedPattern, type RememberedEntry, type WidgetPost } from "./shared/session.js";

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

/** "gone": expired or unknown (404); "ended": the listener closed it (End session, here or on another screen). */
export type SessionStatus = "connecting" | "live" | "retrying" | "parked" | "gone" | "ended";

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
/** Changes to one remembered name by one author within this window go as one event. */
export const REMEMBER_COALESCE_MS = 400;
/** The remembered state is sent at most this often (latest wins). */
export const REMEMBER_STATE_MIN_MS = 2000;

/** A remembered value changed (the stage runtime reports it; see remember() in the guide). */
export interface RememberChange {
  name: string;
  by: "listener" | "ai";
  text: string;
  cycle: number | null;
}

type RememberEvent = Extract<NewEvent, { t: "remember" }>;

export class SessionClient {
  private queue: WidgetPost[] = [];
  /** Coalescing windows for remember events, per name + author. */
  private rememberPending = new Map<string, { event: RememberEvent; timer: unknown }>();
  /** The newest remembered state not yet acknowledged by the server. */
  private statePending: RememberedEntry[] | null = null;
  private stateTimer: unknown = null;
  private stateSentAt = -Infinity;
  private stateInFlight = false;
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
    this.drainRemembered();
    this.stopped = true;
    this.poll?.abort();
    if (this.flushTimer !== null) this.env.clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.clearStateTimer();
    this.statePending = null;
    this.clearPassWatch();
    void this.flush();
  }

  /**
   * A remembered value changed. A listener's change is human activity (it
   * wakes a model listening for activity, and keeps the player from parking);
   * the model's own merge is logged so it reads its edits too. Changes to one
   * name by one author within REMEMBER_COALESCE_MS go as one event (`count`,
   * last label wins), so a hammered grid doesn't flood the 400-event log.
   */
  remembered(change: RememberChange): void {
    if (this.stopped) return;
    if (change.by === "listener") {
      this.lastLively = this.now();
      if (this.parked) this.unpark();
    }
    const key = `${change.by}\u0000${change.name}`;
    const open = this.rememberPending.get(key);
    if (open) {
      open.event.count = (open.event.count ?? 1) + 1;
      open.event.text = change.text;
      open.event.cycle = change.cycle;
      return;
    }
    const event: RememberEvent = { t: "remember", name: change.name, by: change.by, text: change.text, cycle: change.cycle };
    const timer = this.env.setTimeout(() => {
      if (this.rememberPending.get(key)?.event !== event) return;
      this.rememberPending.delete(key);
      this.log(event);
    }, REMEMBER_COALESCE_MS);
    this.rememberPending.set(key, { event, timer });
  }

  /** Close every coalescing window now (before a Pass, an end, a stop). */
  private drainRemembered(): void {
    for (const [key, { event, timer }] of [...this.rememberPending]) {
      this.env.clearTimeout(timer);
      this.rememberPending.delete(key);
      if (!this.stopped) this.queue.push(event);
    }
  }

  /**
   * The piece's remembered state as it stands. Sent at most every
   * REMEMBER_STATE_MIN_MS, the latest replacing anything unsent, and retried
   * until the server takes it. Held while the player is parked: a piece that
   * animates its state must not keep an idle session's Durable Object awake.
   */
  rememberedState(list: RememberedEntry[]): void {
    if (this.stopped) return;
    this.statePending = list;
    this.scheduleState();
  }

  private clearStateTimer(): void {
    if (this.stateTimer !== null) this.env.clearTimeout(this.stateTimer);
    this.stateTimer = null;
  }

  private scheduleState(delay?: number): void {
    if (this.stopped || this.parked || !this.statePending || this.stateTimer !== null || this.stateInFlight) return;
    const wait = delay ?? Math.max(0, this.stateSentAt + REMEMBER_STATE_MIN_MS - this.now());
    this.stateTimer = this.env.setTimeout(() => {
      this.stateTimer = null;
      void this.sendState();
    }, wait);
  }

  private async sendState(): Promise<void> {
    const list = this.statePending;
    if (!list || this.stopped || this.parked || this.stateInFlight) return;
    this.stateInFlight = true;
    this.stateSentAt = this.now();
    const ok = await this.post([{ t: "rememberState", list }]);
    this.stateInFlight = false;
    if (ok !== null && this.statePending === list) this.statePending = null;
    // Unsent (failed, or newer state arrived meanwhile): try again after the window.
    this.scheduleState(ok === null ? REMEMBER_STATE_MIN_MS : undefined);
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
    // What the listener just did to the piece's state goes in the same batch,
    // ahead of the Pass, so the model's read after it is current.
    this.drainRemembered();
    const state = this.statePending;
    if (state && !this.stopped) {
      this.clearStateTimer();
      this.queue.push({ t: "rememberState", list: state });
    }
    this.log({ t: "pass", cycle });
    const body = await this.flush();
    if (state) {
      if (body !== null && this.statePending === state) this.statePending = null;
      this.stateSentAt = this.now();
      this.scheduleState();
    }
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
    return this.post(this.queue.splice(0, this.queue.length));
  }

  /** POST a batch. Resolves the server's reply, or null if it was not taken. */
  private async post(events: WidgetPost[]): Promise<{ listening?: boolean } | null> {
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
      if (res.status === 404 || res.status === 410) {
        this.gone(res.status === 410 ? "ended" : "gone");
        return null;
      }
      if (!res.ok) return null;
      if (!this.stopped && !this.parked) this.env.onStatus?.("live");
      const reply = ((await res.json().catch(() => null)) ?? {}) as { listening?: boolean };
      this.noteListening(reply.listening);
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
    this.scheduleState();
  }

  private gone(status: "gone" | "ended" = "gone"): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const { timer } of this.rememberPending.values()) this.env.clearTimeout(timer);
    this.rememberPending.clear();
    this.clearStateTimer();
    this.statePending = null;
    this.poll?.abort();
    this.clearPassWatch();
    this.env.onStatus?.(status);
    this.env.onGone?.();
  }

  /**
   * The listener closes the session (End session). Sends what is still
   * queued, then the end, then stops: no more polls or events. Resolves
   * whether the service confirmed it (an already-closed session counts).
   */
  async end(cycle: number | null): Promise<boolean> {
    if (this.stopped) return false;
    this.drainRemembered();
    this.clearStateTimer();
    this.statePending = null;
    await this.flush();
    this.stopped = true;
    this.poll?.abort();
    if (this.flushTimer !== null) this.env.clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.queue = [];
    this.clearPassWatch();
    let ok = false;
    try {
      const res = await this.env.fetch(`${this.base}/end`, {
        method: "POST",
        headers: { "content-type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({ cycle }),
        keepalive: true,
      });
      ok = res.ok || res.status === 404 || res.status === 410;
    } catch {
      ok = false;
    }
    this.env.onStatus?.("ended");
    return ok;
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
      if (res.status === 404 || res.status === 410) return this.gone(res.status === 410 ? "ended" : "gone");
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
