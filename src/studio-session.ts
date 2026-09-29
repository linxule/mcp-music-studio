/** Local studio control surface. The widget remains the authority on live state. */
export interface StudioSnapshot {
  args: Record<string, unknown>;
  playback: string;
  status: string;
  error: string | null;
  settings?: Record<string, unknown>;
  selection?: { from: number; to: number; text: string };
}

export interface StudioAdapter {
  read(): StudioSnapshot;
  apply(args: Record<string, unknown>, settings?: Record<string, unknown>): Promise<void>;
  play(isCancelled: () => boolean): Promise<void>;
  stop(): void;
}

export type StudioCommand = {
  action: "get" | "set" | "play" | "stop" | "undo";
  expectedRevision?: number;
  args?: Record<string, unknown>;
  settings?: Record<string, unknown>;
};

export function createStudioSession(adapter: StudioAdapter) {
  let revision = 0;
  const fingerprint = (s: StudioSnapshot) => JSON.stringify([s.args, s.settings]);
  let signature = fingerprint(adapter.read());
  let busy = false;
  let playbackIntent = 0;
  const history: StudioSnapshot[] = [];
  function read() {
    const snapshot = adapter.read();
    const next = fingerprint(snapshot);
    if (next !== signature) { signature = next; revision++; }
    return { ...snapshot, revision, busy, canUndo: history.length > 0 };
  }
  return async (command: StudioCommand) => {
    const before = read();
    if (command.action === "get") return before;
    // Stop must always work, even while another request is loading sounds.
    if (command.action === "stop") { playbackIntent++; adapter.stop(); return read(); }
    if (busy) throw new Error("Studio is busy. Read its state before retrying.");
    if (command.expectedRevision !== before.revision) {
      throw new Error(`Revision conflict: expected ${command.expectedRevision}, current ${before.revision}. Read the current session before editing.`);
    }
    busy = true;
    try {
      if (command.action === "set") {
        if (!command.args) throw new Error("Missing music arguments.");
        if (before.revision > 0 || before.args.code || before.args.abcNotation) history.push(structuredClone(before));
        if (history.length > 10) history.shift();
        await adapter.apply(command.args, command.settings ?? before.settings);
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
        await adapter.play(() => intent !== playbackIntent);
      } else throw new Error("Unknown studio action.");
    } finally { busy = false; }
    return read();
  };
}

/** Explicit local opt-in; no extra listener in ordinary MCP app instances.
 * Uses postMessage so the host can retain an opaque sandboxed iframe.
 */
export function installStudioBridge(adapter: StudioAdapter): void {
  if (new URLSearchParams(location.search).get("studio") !== "1" || parent === window) return;
  let host: URL;
  try { host = new URL(document.referrer); } catch { return; }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host.hostname)) return;
  document.documentElement.dataset.studio = "true";
  const audition = new URLSearchParams(location.search).get("audition") === "1";
  if (audition) document.documentElement.dataset.audition = "true";
  else {
    // Any interaction with the draft ends the isolated suggestion preview.
    const notify = () => parent.postMessage({ channel: "music-studio-interaction" }, host.origin);
    document.addEventListener("pointerdown", notify, { capture: true });
    document.addEventListener("keydown", notify, { capture: true });
    const changed = () => parent.postMessage({ channel: "music-studio-changed" }, host.origin);
    document.addEventListener("input", changed, { capture: true });
    document.addEventListener("change", changed, { capture: true });
    document.addEventListener("music-studio-draft-changed", changed);
    // Button-based settings (room/loop) do not dispatch input/change.
    document.addEventListener("click", () => setTimeout(changed, 0), { capture: true });
  }
  const surface = document.createElement("link");
  surface.rel = "stylesheet";
  surface.href = new URL("/studio-widget.css", host.origin).href;
  document.head.append(surface);
  const dispatch = createStudioSession(adapter);
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
  });
}
