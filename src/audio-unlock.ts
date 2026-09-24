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
