// =============================================================================
// Audio unlock — the DOM-free half of the Strudel widget's #30 fix
//
// A pattern that autoplays arrives with no user gesture inside the frame. Unless
// the host delegated autoplay, the browser then creates the AudioContext
// "suspended": the scheduler runs, currentTime sits at 0, and nothing sounds.
// Measured in the dev harness: WebKit always; Chromium under its default
// `document-user-activation-required` policy, or in a cross-origin (sandboxed)
// frame. Nothing upstream recovers from it — superdough 1.3.0's initAudio() has
//
//     if(!b instanceof OfflineAudioContext && await b.resume(), …)
//
// where `!b` binds first, so resume() is dead code, and its
// initAudioOnFirstClick() listens for `mousedown` only (no touch).
//
// Also measured: without activation, resume() neither resolves nor rejects in
// either engine — it stays pending until something unlocks audio. Every caller
// therefore races it against a timeout.
// =============================================================================

/** The slice of AudioContext this module touches. */
export interface ResumableAudioContext {
  readonly state: string;
  resume(): Promise<void>;
}

/**
 * Resume `ctx` unless it is already running, resolving to whether it is running
 * afterwards. Never waits longer than `timeoutMs`.
 *
 * resume() is called SYNCHRONOUSLY, before this returns: WebKit honours it only
 * inside the task of the gesture that allowed it, so a caller that awaited
 * anything first would lose the gesture.
 */
export function resumeAudioContext(
  ctx: ResumableAudioContext | null | undefined,
  timeoutMs: number,
): Promise<boolean> {
  if (!ctx || ctx.state === "closed") return Promise.resolve(false);
  if (ctx.state === "running") return Promise.resolve(true);
  let resuming: Promise<unknown>;
  try {
    resuming = ctx.resume();
  } catch (err) {
    resuming = Promise.reject(err);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  return Promise.race([resuming.catch(() => undefined), timeout]).then(() => {
    clearTimeout(timer);
    return ctx.state === "running";
  });
}

/**
 * What the widget is actually doing, as far as a listener can tell.
 * "audio-blocked": the scheduler runs, but the context is not running, so
 * nothing is audible until a gesture resumes it.
 */
export type PlaybackState = "playing" | "stopped" | "audio-blocked";

export function playbackState(
  schedulerStarted: boolean,
  audioState: string | null | undefined,
): PlaybackState {
  if (!schedulerStarted) return "stopped";
  return audioState === "running" ? "playing" : "audio-blocked";
}

/**
 * What a tap on Play means. Over a blocked context it is "let me hear it", not
 * "stop" — stopping the pattern the user has not heard yet was the bug.
 */
export type PlayTapAction = "resume-audio" | "stop" | "play";

export function playTapAction(isPlaying: boolean, audioWasBlocked: boolean): PlayTapAction {
  if (!isPlaying) return "play";
  return audioWasBlocked ? "resume-audio" : "stop";
}

/**
 * Remembers whether the gesture now in progress BEGAN over blocked audio.
 *
 * The widget resumes audio from capture-phase gesture listeners, which run
 * before the Play button's click handler. If that resume lands first, the click
 * would see "playing and audible" and stop the pattern it had just unlocked. So
 * the click asks the latch instead of the live state.
 *
 * On touch the gesture is pointerdown → pointerup/touchend → click, and only
 * pointerup/touchend carry activation (HTML's activation-triggering events), so
 * the end events can only ADD to what the start event saw.
 */
export class GestureAudioLatch {
  private blocked = false;

  /** pointerdown / keydown: a new gesture replaces whatever the last one saw. */
  begin(blockedNow: boolean): void {
    this.blocked = blockedNow;
  }

  /** pointerup / touchend: part of the same gesture. */
  extend(blockedNow: boolean): void {
    if (blockedNow) this.blocked = true;
  }

  /** Read once by the click the gesture produced. */
  consume(): boolean {
    const value = this.blocked;
    this.blocked = false;
    return value;
  }
}

// =============================================================================
// Taps, not scrolls
//
// Both widgets resume audio from ANY gesture inside the frame, because a
// settings change or a tap anywhere has to be able to release audio that
// autoplay left parked. On a phone that included the finger that scrolls the
// conversation: a pan that starts on the widget still ends in a `touchend`
// inside the frame, `touchend` is an activation-triggering event, and the
// resume() it made started a parked tune the user was only scrolling past.
// Only a touch that stays put counts now. Pointer events announce a pan with
// `pointercancel`; touch events don't cancel, so the distance moved decides.
// =============================================================================

/** How far a touch may travel and still be a tap, in CSS px. */
export const TAP_SLOP_PX = 10;

/** Follows one touch from start to end and says whether it was a tap. */
export class TapTracker {
  private origin: { x: number; y: number } | null = null;
  private panned = false;

  start(x: number, y: number): void {
    this.origin = { x, y };
    this.panned = false;
  }

  move(x: number, y: number): void {
    if (!this.origin) return;
    if (Math.hypot(x - this.origin.x, y - this.origin.y) > TAP_SLOP_PX) this.panned = true;
  }

  /** The browser took the touch over (a pan or zoom began). */
  cancel(): void {
    this.panned = true;
  }

  /** A touch is being followed. */
  get active(): boolean {
    return this.origin !== null;
  }

  /** Is the touch in progress (or just lifted) a tap so far? */
  isTap(): boolean {
    return this.origin !== null && !this.panned;
  }

  /** The touch is over. */
  reset(): void {
    this.origin = null;
    this.panned = false;
  }
}

export type GesturePress = "key" | "mouse" | "touch";

export interface AudioGestureHandlers {
  /**
   * A gesture began: keydown or any pointerdown. `kind` "touch" carries no
   * activation yet and may still turn into a scroll, so don't resume on it.
   */
  press?(kind: GesturePress): void;
  /** A gesture that carries user activation and is not a scroll: resume now. */
  activate(): void;
}

type Point = { clientX: number; clientY: number };

/**
 * Install capture-phase listeners that call `activate` for key presses, mouse
 * presses and touch TAPS — never for a touch that panned. Returns an uninstaller.
 *
 * Capture phase so no control's own handler can swallow the event. On touch,
 * activation arrives with pointerup/touchend (HTML's activation-triggering
 * events), so a tap calls `activate` from both; resume() is idempotent.
 */
export function listenForAudioGestures(
  target: EventTarget,
  handlers: AudioGestureHandlers,
): () => void {
  const tracker = new TapTracker();
  const firstTouch = (event: Event): Point | undefined =>
    (event as TouchEvent).changedTouches?.[0] ?? (event as TouchEvent).touches?.[0];
  const isMouse = (event: Event) => (event as PointerEvent).pointerType === "mouse";

  const listeners: [string, (event: Event) => void][] = [
    ["keydown", () => {
      handlers.press?.("key");
      handlers.activate();
    }],
    ["pointerdown", (event) => {
      if (isMouse(event)) {
        handlers.press?.("mouse");
        handlers.activate();
        return;
      }
      const p = event as PointerEvent;
      tracker.start(p.clientX, p.clientY);
      handlers.press?.("touch");
    }],
    ["pointermove", (event) => {
      if (!isMouse(event)) tracker.move((event as PointerEvent).clientX, (event as PointerEvent).clientY);
    }],
    ["pointercancel", () => tracker.cancel()],
    ["pointerup", (event) => {
      if (!isMouse(event) && tracker.isTap()) handlers.activate();
    }],
    // touchstart starts a touch only where pointer events didn't (older
    // WebKit): restarting one pointerdown began would forget a pointercancel
    // in between, and a second finger must not restart the first one's touch.
    ["touchstart", (event) => {
      const t = firstTouch(event);
      if (t && !tracker.active) tracker.start(t.clientX, t.clientY);
    }],
    ["touchmove", (event) => {
      const t = firstTouch(event);
      if (t) tracker.move(t.clientX, t.clientY);
    }],
    // No touchend follows a touchcancel: the touch is over, and not a tap.
    ["touchcancel", () => tracker.reset()],
    ["touchend", () => {
      if (tracker.isTap()) handlers.activate();
      tracker.reset();
    }],
  ];
  for (const [type, listener] of listeners) {
    target.addEventListener(type, listener, { capture: true, passive: true });
  }
  return () => {
    for (const [type, listener] of listeners) {
      target.removeEventListener(type, listener, { capture: true });
    }
  };
}
