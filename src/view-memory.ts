// =============================================================================
// Autoplay once per tool call
//
// A host may tear a widget down when it scrolls out of view and build a fresh
// one when it scrolls back, replaying the same tool input and result (the
// ext-apps docs' "Persisting view state" pattern exists for exactly this). A
// fresh widget knows nothing of the one before it, so every rebuild autoplayed
// again — reported from Claude iOS after 0.5.8: tunes restarting while the user
// scrolled a conversation, even ones they had paused.
//
// The server stamps each play result with `_meta.viewUUID` (SDK pattern); the
// widget remembers the views it has autoplayed in localStorage and renders a
// replay stopped. The host's `toolInfo.id`, when it sends one, is the fallback
// for a result that carries no viewUUID. It is only a JSON-RPC id, which may
// repeat across connections, so it is paired with a digest of the input.
//
// Storage can be missing or throw (an opaque-origin sandbox, a private
// window). Then nothing is remembered and every mount autoplays, as before.
// =============================================================================

export const AUTOPLAY_MEMORY_KEY = "music-studio:autoplayed";
/** Oldest entries go first beyond this. */
export const AUTOPLAY_MEMORY_MAX = 300;
/**
 * How long a tool input waits for its result's viewUUID before deciding. A
 * fresh call's result follows its input within a server round trip; a replay
 * delivers both together.
 */
export const VIEW_ID_WAIT_MS = 4000;

/** The slice of Storage used here. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** localStorage, or null where touching it throws. */
export function browserStorage(): KeyValueStore | null {
  try {
    const storage = globalThis.localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

export class AutoplayMemory {
  constructor(private readonly store: () => KeyValueStore | null) {}

  private read(): Record<string, number> {
    try {
      const raw = this.store()?.getItem(AUTOPLAY_MEMORY_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, number>)
        : {};
    } catch {
      return {};
    }
  }

  has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.read(), key);
  }

  remember(keys: readonly string[], now = Date.now()): void {
    if (keys.length === 0) return;
    try {
      const store = this.store();
      if (!store) return;
      const entries = { ...this.read() };
      for (const key of keys) entries[key] = now;
      const kept = Object.entries(entries)
        .sort((a, b) => b[1] - a[1])
        .slice(0, AUTOPLAY_MEMORY_MAX);
      store.setItem(AUTOPLAY_MEMORY_KEY, JSON.stringify(Object.fromEntries(kept)));
    } catch {
      /* quota or a throwing store: forget, and autoplay as before */
    }
  }
}

/** FNV-1a (32-bit) of a string, as 8 hex digits. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Key for the host's tool-call id paired with the input it carried, or null. */
export function toolCallKey(id: unknown, args: unknown): string | null {
  if (typeof id !== "string" && typeof id !== "number") return null;
  let digest: string;
  try {
    digest = fnv1a(JSON.stringify(args) ?? "");
  } catch {
    return null;
  }
  return `tool:${String(id)}:${digest}`;
}

/** The viewUUID a tool result carries in `_meta`, if any. */
export function viewIdOf(result: unknown): string | undefined {
  const id = (result as { _meta?: { viewUUID?: unknown } } | null)?._meta?.viewUUID;
  return typeof id === "string" && id.length > 0 ? `view:${id}` : undefined;
}

/**
 * Pairs each tool input with the viewUUID of ITS result, whichever of the two
 * the host delivers first (first in, first out).
 */
export class ViewIdChannel {
  private arrived: (string | undefined)[] = [];
  private waiting: ((id: string | undefined) => void)[] = [];

  /** A tool result arrived. */
  put(id: string | undefined): void {
    const taker = this.waiting.shift();
    if (taker) taker(id);
    else this.arrived.push(id);
  }

  /** The result for the tool input being decided. */
  take(): Promise<string | undefined> {
    if (this.arrived.length > 0) return Promise.resolve(this.arrived.shift());
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /**
   * The inputs still waiting will get no result (a cancel): let them go, so
   * the next call's result pairs with the next call.
   */
  abandon(): void {
    for (const taker of this.waiting.splice(0)) taker(undefined);
  }
}

/**
 * May this tool input autoplay? False when this view has autoplayed before;
 * otherwise remembers it and says yes. Waits at most `waitMs` for the result.
 *
 * The result's viewUUID decides whenever there is one: it is unique per call,
 * while the host's tool-call id is only a JSON-RPC id that another connection
 * may reuse with the same arguments. The tool key decides only when no
 * viewUUID came in time; a viewUUID that arrives after the timeout is still
 * remembered, so the view's later rebuilds stay stopped.
 */
export async function claimAutoplay(
  memory: AutoplayMemory,
  toolKey: string | null,
  viewId: Promise<string | undefined>,
  waitMs = VIEW_ID_WAIT_MS,
): Promise<boolean> {
  const TIMED_OUT = Symbol("timed out");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const id = await Promise.race([
    viewId,
    new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), waitMs);
    }),
  ]);
  clearTimeout(timer);
  if (id === TIMED_OUT) {
    void viewId.then((late) => {
      if (late) memory.remember([late]);
    });
  }
  const view = id === TIMED_OUT ? undefined : id;
  if (view) {
    if (memory.has(view)) return false;
  } else if (toolKey && memory.has(toolKey)) {
    return false;
  }
  memory.remember([toolKey, view].filter((key): key is string => Boolean(key)));
  return true;
}
