// =============================================================================
// The share page as an ext-apps HOST — the real widget, on a page we control
//
// Share links used to open a separate standalone page (src/strudel-browser-
// fallback.ts) with play controls and little else: no stage, no Hydra layer,
// no code view, no controls strip, no live session. The 2026-10-02 field test
// also found that tilt and the microphone are blocked inside the chat's widget
// frame but work on a top-level page.
//
// So this page hosts the SAME widget the MCP app renders (dist/strudel-app.html,
// served by the Worker at /widget/strudel) through the SDK's own host side —
// AppBridge + PostMessageTransport, as dev/host.ts does — and grants its frame
// what a chat host can't: autoplay, microphone, motion sensors, MIDI,
// fullscreen, and real file downloads.
//
// The pattern arrives with autoplay OFF: a shared page plays on a deliberate
// press (CLAUDE.md, "Shared Strudel pages require deliberate evaluation").
// A /s/<id> page also passes _meta.session, so the widget joins a live session
// as a second screen.
// =============================================================================

import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

interface ShareInit {
  code: string;
  title?: string;
  bpm?: number;
  /** A live session for the widget to join (a /s/<id> page). */
  session?: { id: string; origin: string };
  /** Where the widget is served. */
  widget: string;
  /** The standalone page, for browsers the full player doesn't suit. */
  classic?: string;
}

/** What the frame may use — the reason this page exists. */
export const FRAME_ALLOW = "autoplay; microphone; accelerometer; gyroscope; magnetometer; midi; fullscreen; clipboard-write";

const init = JSON.parse(document.getElementById("init-data")?.textContent ?? "{}") as ShareInit;
const stage = document.getElementById("stage") as HTMLDivElement;
const note = document.getElementById("note") as HTMLDivElement;
const titleEl = document.getElementById("title") as HTMLHeadingElement;
const classic = document.getElementById("classic") as HTMLAnchorElement;

if (init.title) {
  titleEl.textContent = init.title;
  document.title = `${init.title} — Music Studio`;
} else if (init.session) {
  titleEl.textContent = "Live session";
}
if (init.classic) {
  classic.href = init.classic;
  classic.hidden = false;
}

type DisplayMode = "inline" | "fullscreen";
let displayMode: DisplayMode = "inline";

function hostContext() {
  const coarse = matchMedia("(pointer: coarse)").matches;
  return {
    theme: matchMedia("(prefers-color-scheme: light)").matches ? ("light" as const) : ("dark" as const),
    displayMode,
    availableDisplayModes: ["inline", "fullscreen"] as DisplayMode[],
    // A fixed container: the widget fills the frame (src/frame-size.ts).
    containerDimensions: {
      height: Math.round(stage.clientHeight),
      width: Math.round(stage.clientWidth),
    },
    platform: coarse ? ("mobile" as const) : ("web" as const),
  };
}

/** A data: blob from ui/download-file, saved the way a browser saves anything. */
function saveResource(resource: { uri?: string; mimeType?: string; blob?: string; text?: string }): void {
  const name = (resource.uri ?? "recording").split("/").pop() || "recording";
  let blob: Blob;
  if (typeof resource.blob === "string") {
    const bin = atob(resource.blob);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    blob = new Blob([bytes], { type: resource.mimeType ?? "application/octet-stream" });
  } else {
    blob = new Blob([resource.text ?? ""], { type: resource.mimeType ?? "text/plain" });
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = decodeURIComponent(name);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function mount(): Promise<void> {
  const frame = document.createElement("iframe");
  frame.title = init.title ? `${init.title} — Strudel player` : "Strudel player";
  frame.setAttribute("allow", FRAME_ALLOW);
  frame.setAttribute("allowfullscreen", "");
  stage.appendChild(frame);

  const bridge = new AppBridge(
    null,
    { name: "Music Studio share page", version: "1" },
    {
      openLinks: {},
      downloadFile: {},
      logging: {},
      // Reports have no model to go to here; accepted and dropped. No
      // `message`: there is no chat to send to (Pass then just says so).
      updateModelContext: { text: {} },
    },
    { hostContext: hostContext() },
  );

  let sent = false;
  bridge.oninitialized = async () => {
    note.remove();
    if (sent) return;
    sent = true;
    const args: Record<string, unknown> = { code: init.code, autoplay: false };
    if (init.title) args.title = init.title;
    if (typeof init.bpm === "number") args.bpm = init.bpm;
    await bridge.sendToolInput({ arguments: args });
    await bridge.sendToolResult({
      content: [{ type: "text", text: init.session ? `Live session: ${init.session.id}.` : "Shared Strudel pattern." }],
      _meta: {
        viewUUID: crypto.randomUUID(),
        // The page's own origin: the Worker served it, and behind a proxy (or
        // wrangler dev) the Worker's idea of its URL can differ from the browser's.
        ...(init.session ? { session: { id: init.session.id, origin: location.origin } } : {}),
      },
    });
  };
  bridge.onupdatemodelcontext = async () => ({});
  bridge.onsizechange = () => {};
  bridge.ondownloadfile = async ({ contents }) => {
    for (const item of contents as Array<{ type: string; resource?: Record<string, string> }>) {
      if (item.type === "resource" && item.resource) saveResource(item.resource);
    }
    return {};
  };
  bridge.onopenlink = async ({ url }) => {
    if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer");
    return {};
  };
  bridge.onrequestdisplaymode = async ({ mode }) => {
    if (mode === "fullscreen") {
      try {
        await stage.requestFullscreen?.();
        displayMode = "fullscreen";
      } catch {
        displayMode = "inline"; // no activation, or the browser refused
      }
    } else if (mode === "inline") {
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
      displayMode = "inline";
    }
    bridge.setHostContext(hostContext());
    return { mode: displayMode };
  };
  document.addEventListener("fullscreenchange", () => {
    displayMode = document.fullscreenElement ? "fullscreen" : "inline";
    bridge.setHostContext(hostContext());
  });
  new ResizeObserver(() => bridge.setHostContext(hostContext())).observe(stage);

  // The transport goes up before the frame navigates, so the widget's
  // initialize request can never arrive before our listener (dev/host.ts).
  await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
  frame.src = init.widget;
  (window as unknown as { __share: unknown }).__share = { bridge, frame, init };
}

void mount().catch((err) => {
  note.textContent = `The player could not start: ${(err as Error)?.message ?? err}`;
});
