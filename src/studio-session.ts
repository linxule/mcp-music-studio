import { z } from "zod";
import { playLiveInputSchema, playSheetInputSchema } from "./shared/tool-defs";
import { checkPassage, passageSchema, proposedArgs, samePassage, type Passage, type SharedReview } from "./studio-review";

/** Each mounted widget owns one live document, revision, and undo history. */
export type StudioMode = "live" | "score";
export const studioScoreSettingsSchema = z.object({
  soundFont: z.enum(["default", "musyngkite", "dry"]).optional(),
  room: z.boolean().optional(), instrumentOverride: z.boolean().optional(),
  warp: z.number().min(1).max(1000).optional(), loop: z.boolean().optional(),
}).strict();
export const studioLiveSettingsSchema = z.object({}).strict();
export const studioPatternArgsSchema = playLiveInputSchema.omit({ autoplay: true }).strict();
export const studioScoreArgsSchema = playSheetInputSchema.extend({
  abcNotation: playSheetInputSchema.shape.abcNotation.removeDefault(),
}).strict();
const commandSchema = z.object({
  action: z.enum(["get", "set", "swap", "play", "stop", "undo", "review-start", "review-stage", "review-clear", "review-apply"]),
  instanceId: z.string().min(1).optional(),
  mode: z.enum(["live", "score"]).optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  replace: z.boolean().optional(),
  quantize: z.number().int().min(0).max(32).optional(),
  requestId: z.string().min(1).optional(),
  question: z.string().max(6000).optional(),
  passage: passageSchema.optional(),
  explanation: z.string().min(1).max(6000).optional(),
  replacement: z.string().max(65536).optional(),
}).strict();
export interface StudioSnapshot {
  args: Record<string, unknown>;
  playback: string;
  status: string;
  error: string | null;
  settings?: Record<string, unknown>;
  selection?: { from: number; to: number; text: string };
}

/** What a quantized swap did: the cycle the new code took over at, or why it didn't. */
export interface StudioSwapOutcome {
  ok: boolean;
  cycle: number | null;
  error?: string;
  report?: string;
}

/** Default phrase for swap-pattern: one 4-cycle phrase (quantize = phrase length). */
export const STUDIO_SWAP_DEFAULT_QUANTIZE = 4;

export interface StudioAdapter {
  read(): StudioSnapshot;
  /**
   * Live widgets: replace a PLAYING pattern on the next `quantize`-cycle
   * boundary (old until the bar, new from it). Rejects, changing nothing, when
   * the player is stopped. Resolves when the new code took over or failed.
   */
  swap?(code: string, quantize: number, isCancelled: () => boolean): Promise<StudioSwapOutcome>;
  apply(args: Record<string, unknown>, settings?: Record<string, unknown>, isCancelled?: () => boolean, onCommit?: () => void): Promise<void>;
  play(isCancelled: () => boolean): Promise<void>;
  stop(): void;
}

export type StudioCommand = {
  action: "get" | "set" | "swap" | "play" | "stop" | "undo" | "review-start" | "review-stage" | "review-clear" | "review-apply";
  instanceId?: string;
  mode?: StudioMode;
  expectedRevision?: number;
  args?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  replace?: boolean;
  quantize?: number;
  requestId?: string;
  question?: string;
  passage?: Passage;
  explanation?: string;
  replacement?: string;
};

export interface StudioState extends StudioSnapshot {
  instanceId: string;
  mode: StudioMode;
  revision: number;
  busy: boolean;
  canUndo: boolean;
  sharedReview: SharedReview | null;
  /** Present on a swap's answer. */
  swap?: StudioSwapOutcome & { quantize: number };
}
export interface StudioSession {
  (command: StudioCommand): Promise<StudioState>;
  readonly instanceId: string;
  readonly mode: StudioMode;
  onDispose(cleanup: () => void): void;
  onReviewChange(listener: (review: SharedReview | null) => void): () => void;
  dispose(): void;
}

export function createStudioSession(adapter: StudioAdapter, options: { mode: StudioMode }): StudioSession {
  const { mode } = options;
  const instanceId = crypto.randomUUID();
  let disposed = false;
  const cleanups = new Set<() => void>();
  const reviewListeners = new Set<(review: SharedReview | null) => void>();
  let sharedReview: SharedReview | null = null;
  let reviewNotifications = 0;
  const cloneReview = () => sharedReview ? structuredClone(sharedReview) : null;
  const notifyReview = () => {
    reviewNotifications++;
    for (const listener of reviewListeners) {
      try { listener(cloneReview()); } catch { /* One UI subscriber must not prevent other listeners. */ }
    }
  };
  let revision = 0;
  const fingerprint = (s: StudioSnapshot) => JSON.stringify([s.args, s.settings]);
  let signature = fingerprint(adapter.read());
  let busy = false;
  let playbackIntent = 0;
  const history: StudioSnapshot[] = [];
  function read() {
    const snapshot = adapter.read();
    const next = fingerprint(snapshot);
    if (next !== signature) {
      signature = next; revision++;
      if (sharedReview && !sharedReview.stale) { sharedReview.stale = true; notifyReview(); }
    }
    return { ...snapshot, instanceId, mode, revision, busy, canUndo: history.length > 0, sharedReview: cloneReview() };
  }
  const requireReview = (requestId: string | undefined, current: StudioState, allowStale = false) => {
    if (!requestId || !sharedReview || sharedReview.requestId !== requestId) throw new Error("Review request superseded or cleared. Request a fresh review of the passage.");
    if (!allowStale) {
      if (sharedReview.stale) throw new Error("The review is stale. Request a fresh review of the current draft.");
      checkPassage(sharedReview.passage, current);
    }
    return sharedReview;
  };
  const dispatch = async (raw: StudioCommand): Promise<StudioState> => {
    if (disposed) throw new Error("Studio session has been disposed. Read the mounted widget's current session.");
    const command = commandSchema.parse(raw);
    if ((command.instanceId !== undefined && command.instanceId !== instanceId)
      || (command.action !== "get" && command.instanceId !== instanceId)) {
      throw new Error("Studio instance conflict. Read the target widget's current session before sending a command.");
    }
    if (command.mode !== undefined && command.mode !== mode) throw new Error("Studio mode conflict. Use this widget's current mode.");
    if (command.action !== "set" && command.action !== "swap" && command.args !== undefined) throw new Error("Only set and swap accept music arguments.");
    if (command.action !== "set" && (command.settings !== undefined || command.replace !== undefined)) throw new Error("Only set accepts settings or replace.");
    if (command.action !== "swap" && command.quantize !== undefined) throw new Error("Only swap accepts quantize.");
    const reviewKeys = [command.requestId, command.question, command.passage, command.explanation, command.replacement];
    if (!command.action.startsWith("review-") && reviewKeys.some(value => value !== undefined)) throw new Error("Review fields require a review action.");
    const before = read();
    if (command.action === "get") return before;
    // Stop must always work, even while another request is loading sounds.
    if (command.action === "stop") {
      playbackIntent++; adapter.stop();
      const notifications = reviewNotifications;
      const stopped = read();
      if (notifications === reviewNotifications) notifyReview();
      return stopped;
    }
    if (command.action === "review-clear") {
      requireReview(command.requestId, before, true);
      sharedReview = null; notifyReview(); return read();
    }
    if (busy) throw new Error("Studio is busy. Read its state before retrying.");
    if (command.action === "review-stage") {
      const review = requireReview(command.requestId, before);
      if (!command.passage || !samePassage(command.passage, review.passage)) throw new Error("Review passage does not match the frozen request.");
      checkPassage(command.passage, before);
      if (!command.explanation) throw new Error("Missing review explanation.");
      sharedReview = { ...review, explanation: command.explanation,
        ...(command.replacement !== undefined ? { replacement: command.replacement } : { replacement: undefined }) };
      notifyReview(); return read();
    }
    if (command.expectedRevision !== before.revision) {
      throw new Error(`Revision conflict: expected ${command.expectedRevision}, current ${before.revision}. Read the current session before editing.`);
    }
    if (command.action === "swap") {
      // A swap waits for its bar without holding `busy`: a newer swap (or a
      // stop) must be able to supersede it, and it answers then.
      if (mode !== "live" || !adapter.swap) throw new Error("swap-pattern is only available in a live (Strudel) widget.");
      const code = command.args?.code;
      if (typeof code !== "string" || !code.trim()) throw new Error("swap needs non-empty code.");
      studioPatternArgsSchema.shape.code.parse(code);
      const quantize = command.quantize ?? STUDIO_SWAP_DEFAULT_QUANTIZE;
      const intent = ++playbackIntent;
      const draft = fingerprint(adapter.read());
      let outcome: StudioSwapOutcome;
      try {
        outcome = await adapter.swap(code, quantize, () => disposed || intent !== playbackIntent);
      } finally {
        // Undo restores the source before the swap whenever the editor changed,
        // even if the new code then failed to play.
        if (!disposed && fingerprint(adapter.read()) !== draft) {
          history.push(structuredClone(before));
          if (history.length > 10) history.shift();
        }
      }
      if (disposed) throw new Error("Studio session has been disposed.");
      const notifications = reviewNotifications;
      const after = read();
      if (notifications === reviewNotifications) notifyReview();
      return { ...after, ...(outcome.ok ? {} : { error: outcome.error ?? "The swap did not play." }), swap: { ...outcome, quantize } };
    }
    if (command.action === "review-start") {
      if (!command.passage || command.question === undefined) throw new Error("A review needs the exact passage and a question.");
      checkPassage(command.passage, read());
      sharedReview = { requestId: crypto.randomUUID(), question: command.question, passage: structuredClone(command.passage), explanation: "", stale: false };
      notifyReview(); return read();
    }
    busy = true;
    try {
      if (command.action === "review-apply") {
        const current = read();
        const review = requireReview(command.requestId, current);
        const args: Record<string, unknown> = (mode === "live" ? studioPatternArgsSchema : studioScoreArgsSchema).parse(proposedArgs(review, current));
        const draftSignature = signature;
        let committed = false;
        const isCancelled = () => disposed || sharedReview?.requestId !== review.requestId
          || sharedReview.stale || fingerprint(adapter.read()) !== draftSignature;
        const recordRecovery = () => {
          history.push(structuredClone(current));
          if (history.length > 10) history.shift();
        };
        try {
          await adapter.apply(args, current.settings, isCancelled, () => { committed = true; });
        } catch (error) {
          if (!disposed) {
            const outcome = adapter.read();
            if (committed && fingerprint(outcome) !== draftSignature) recordRecovery();
          }
          throw error;
        }
        if (disposed) throw new Error("Studio session has been disposed.");
        const outcome = adapter.read();
        if (committed && fingerprint(outcome) !== draftSignature) recordRecovery();
        const rendered = read();
        if (!committed) throw new Error(`The proposed edit was not applied. ${rendered.error ?? "It was cancelled or the draft changed while rendering."} Read the current session before trying again.`);
        if (!rendered.error && sharedReview?.requestId === review.requestId && committed) {
          sharedReview = null; notifyReview();
        }
      } else if (command.action === "set") {
        if (!command.args) throw new Error("Missing music arguments.");
        const args = (mode === "live" ? studioPatternArgsSchema : studioScoreArgsSchema).parse(command.args);
        const parsedSettings = command.settings === undefined ? undefined
          : (mode === "live" ? studioLiveSettingsSchema : studioScoreSettingsSchema).parse(command.settings);
        const settings = parsedSettings === undefined ? before.settings
          : command.replace ? mode === "score" ? {
            soundFont: "default", room: true, instrumentOverride: false, warp: 100, loop: false,
            ...parsedSettings,
          } : parsedSettings : { ...before.settings, ...parsedSettings };
        // A measured runtime tempo is feedback, not an override for new source.
        const retained: Record<string, unknown> = command.replace ? {} : { ...before.args };
        if (mode === "live") delete retained.bpm;
        if (before.revision > 0 || before.args.code || before.args.abcNotation) history.push(structuredClone(before));
        if (history.length > 10) history.shift();
        await adapter.apply({ ...retained, ...args }, settings);
      } else if (command.action === "undo") {
        const previous = history.at(-1);
        if (!previous) throw new Error("No agent edit to undo.");
        await adapter.apply(previous.args, previous.settings);
        // Widget renderers may report failures in their status instead of
        // rejecting. Keep the recovery target until it actually renders.
        const error = adapter.read().error;
        if (error) throw new Error(error);
        history.pop();
      } else if (command.action === "play") {
        const intent = ++playbackIntent;
        await adapter.play(() => disposed || intent !== playbackIntent);
      } else throw new Error("Unknown studio action.");
    } catch (error) {
      busy = false;
      if (!disposed) { read(); notifyReview(); }
      throw error;
    } finally { busy = false; }
    if (disposed) throw new Error("Studio session has been disposed.");
    const notifications = reviewNotifications;
    const after = read();
    // Also refresh controls such as Undo after native source mutations, even
    // when no passage review is open. Reading unchanged state never emits.
    if (notifications === reviewNotifications) notifyReview();
    return after;
  };
  return Object.assign(dispatch, {
    instanceId, mode,
    onDispose(cleanup: () => void) {
      if (disposed) cleanup();
      else cleanups.add(cleanup);
    },
    onReviewChange(listener: (review: SharedReview | null) => void) {
      if (disposed) throw new Error("Studio session has been disposed.");
      reviewListeners.add(listener);
      listener(cloneReview());
      return () => { reviewListeners.delete(listener); };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      playbackIntent++;
      history.length = 0;
      sharedReview = null;
      notifyReview(); reviewListeners.clear();
      try { adapter.stop(); }
      finally {
        for (const cleanup of cleanups) {
          try { cleanup(); } catch { /* Continue releasing this widget's listeners. */ }
        }
        cleanups.clear();
      }
    },
  });
}

/** Explicit local opt-in; no extra listener in ordinary MCP app instances.
 * Uses postMessage so the host can retain an opaque sandboxed iframe.
 */
export function installStudioBridge(dispatch: StudioSession): void {
  if (new URLSearchParams(location.search).get("studio") !== "1" || parent === window) return;
  let host: URL;
  try { host = new URL(document.referrer); } catch { return; }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host.hostname)) return;
  const controller = new AbortController();
  const signal = controller.signal;
  document.documentElement.dataset.studio = "true";
  const audition = new URLSearchParams(location.search).get("audition") === "1";
  if (audition) document.documentElement.dataset.audition = "true";
  else {
    const unsubscribe = dispatch.onReviewChange(() => {
      if (!signal.aborted) parent.postMessage({ channel: "music-studio-review-changed" }, host.origin);
    });
    dispatch.onDispose(unsubscribe);
    // Any interaction with the draft ends the isolated suggestion preview.
    const notify = () => parent.postMessage({ channel: "music-studio-interaction" }, host.origin);
    document.addEventListener("pointerdown", notify, { capture: true, signal });
    document.addEventListener("keydown", notify, { capture: true, signal });
    const changed = () => parent.postMessage({ channel: "music-studio-changed" }, host.origin);
    document.addEventListener("input", changed, { capture: true, signal });
    document.addEventListener("change", changed, { capture: true, signal });
    document.addEventListener("music-studio-draft-changed", changed, { signal });
    // Button-based settings (room/loop) do not dispatch input/change.
    document.addEventListener("click", () => setTimeout(() => { if (!signal.aborted) changed(); }, 0), { capture: true, signal });
  }
  const surface = document.createElement("link");
  surface.rel = "stylesheet";
  surface.href = new URL("/studio-widget.css", host.origin).href;
  document.head.append(surface);
  dispatch.onDispose(() => { controller.abort(); surface.remove(); });
  window.addEventListener("message", async (event) => {
    if (event.source !== parent || event.origin !== host.origin) return;
    const request = event.data;
    if (request?.channel !== "music-studio-local" || typeof request.id !== "string") return;
    try {
      const state = await dispatch(request.command);
      parent.postMessage({ channel: "music-studio-local-result", id: request.id, state }, host.origin);
    } catch (error) {
      parent.postMessage({ channel: "music-studio-local-result", id: request.id, error: String(error) }, host.origin);
    }
  }, { signal });
}
