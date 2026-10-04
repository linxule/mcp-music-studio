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
// served by the Worker at /widget/strudel; for a score, dist/mcp-app.html at
// /widget/sheet) through the SDK's own host side —
// AppBridge + PostMessageTransport, as dev/host.ts does — and grants its frame
// what a chat host can't: autoplay, microphone, motion sensors, MIDI,
// fullscreen, and real file downloads.
//
// The pattern or score arrives with autoplay OFF: a shared page plays on a
// deliberate press (CLAUDE.md, "Shared Strudel pages require deliberate evaluation").
// A /s/<id> page also passes _meta.session, so the widget joins a live session
// as a second screen.
//
// Where the browser has WebMCP (document.modelContext), the widget's MCP Apps
// tools are relayed to the page's agent too — an agent only sees top-level
// page tools, never an iframe's (src/webmcp-relay.ts).
// =============================================================================

import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { createWidgetToolRelay } from "./webmcp-relay";
import { shareRelayAnnotations, shareRelayExclude } from "./share-relay-policy";
import { enterStageFullscreen, leaveStageFullscreen, stageIsFullscreen, VIEWPORT_FILL_CLASS } from "./share-fullscreen";

interface ShareInit {
  /** What the page plays: a Strudel pattern (the default) or an ABC score. */
  kind?: "play" | "score";
  /** kind "play": the pattern. */
  code?: string;
  /** kind "score": play-sheet-music's arguments (src/shared/share-url.ts ScoreShareArgs). */
  score?: { abcNotation: string } & Record<string, unknown>;
  title?: string;
  bpm?: number;
  /** A live session for the widget to join (a /s/<id> page). */
  session?: { id: string; origin: string; rev?: number };
  /** Where the widget is served. */
  widget: string;
  /** The standalone page, for browsers the full player doesn't suit. */
  classic?: string;
  /** A watch page (`?watch`): the widget shows only its stage. */
  watch?: boolean;
}

/** What the frame may use — the reason this page exists. */
export const FRAME_ALLOW = "autoplay; microphone; accelerometer; gyroscope; magnetometer; midi; fullscreen; clipboard-write";

const init = JSON.parse(document.getElementById("init-data")?.textContent ?? "{}") as ShareInit;
const stage = document.getElementById("stage") as HTMLDivElement;
const note = document.getElementById("note") as HTMLDivElement;
const titleEl = document.getElementById("title") as HTMLHeadingElement;
const classic = document.getElementById("classic") as HTMLAnchorElement;
const isScore = init.kind === "score";

if (init.title) {
  titleEl.textContent = init.title;
  document.title = `${init.title} — Music Studio`;
} else if (init.session) {
  titleEl.textContent = "Live session";
} else if (isScore) {
  titleEl.textContent = "Shared score";
  document.title = "Music Studio — shared score";
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

/**
 * The widget takes a moment after ui/initialize to apply the pattern it was
 * sent; an agent reading its state before then sees an empty draft and loses
 * its first edit to a revision conflict. Wait (bounded) for the source to land.
 */
async function sourceApplied(bridge: AppBridge, expected: string, field: "code" | "abcNotation"): Promise<void> {
  if (!expected) return;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const result = await bridge.callTool({ name: "get-studio-state", arguments: {} }, { timeout: 5_000 });
      const source = (result.structuredContent as { args?: Record<string, unknown> } | undefined)?.args?.[field];
      if (typeof source === "string" && source.length > 0) return;
    } catch {
      return; // no such tool, or no answer: nothing to wait for
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

async function mount(): Promise<void> {
  const frame = document.createElement("iframe");
  const player = isScore ? "Sheet music player" : "Strudel player";
  frame.title = init.title ? `${init.title} — ${player}` : player;
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

  // Anyone can craft a /play link: everything a tool returns is third-party
  // content, and nothing plays until Play has been pressed on this page.
  let playPressed = false;
  const relay = createWidgetToolRelay({
    bridge,
    exclude: shareRelayExclude(() => playPressed),
    descriptionSuffix: isScore
      ? "This controls the sheet-music player on this page. Playing is offered once Play has been pressed on this page."
      : "This controls the music player on this page. Playing and swapping are offered once Play has been pressed on this page.",
    annotate: shareRelayAnnotations,
    onError: (error, what) => console.warn(`WebMCP relay: ${what}:`, error),
  });
  const syncRelay = () => void relay?.refresh().catch((error) => console.warn("WebMCP relay: listing the player's tools failed:", error));
  // A tool the widget adds or changes after it initialised (tools/list_changed).
  if (relay) bridge.setNotificationHandler("notifications/tools/list_changed", syncRelay);
  addEventListener("pagehide", () => relay?.dispose());

  let sent = false;
  bridge.oninitialized = async () => {
    note.remove();
    if (sent) return;
    sent = true;
    let args: Record<string, unknown>;
    if (isScore) {
      // play-sheet-music's own arguments: the widget normalises them as it
      // does a tool call's (prepareToolInput), tempo, style and transpose included.
      args = { ...init.score, autoplay: false };
    } else {
      args = { code: init.code, autoplay: false };
      if (typeof init.bpm === "number") args.bpm = init.bpm;
    }
    if (init.title) args.title = init.title;
    await bridge.sendToolInput({ arguments: args });
    await bridge.sendToolResult({
      content: [{
        type: "text",
        text: init.session ? `Live session: ${init.session.id}.` : isScore ? "Shared score." : "Shared Strudel pattern.",
      }],
      _meta: {
        viewUUID: crypto.randomUUID(),
        // The page's own origin: the Worker served it, and behind a proxy (or
        // wrangler dev) the Worker's idea of its URL can differ from the browser's.
        ...(init.session ? { session: { id: init.session.id, origin: location.origin, rev: init.session.rev ?? 0 } } : {}),
      },
    });
    // Tools appear once the source is in, so an agent's first read sees it.
    if (relay) {
      void (isScore
        ? sourceApplied(bridge, init.score?.abcNotation ?? "", "abcNotation")
        : sourceApplied(bridge, init.code ?? "", "code")
      ).then(syncRelay);
    }
  };
  // The Strudel widget reports after every evaluation; after the first one a
  // press of Play started, its state says playPressed — then the play tools
  // appear. The sheet widget logs "play-pressed" instead (a report would
  // replace its edit report in a chat host); either way the state decides.
  let checking = false;
  let recheck = false;
  const checkPlayPressed = async () => {
    if (playPressed || !relay) return;
    // A report during a check (which may read the state from before it) asks again after.
    if (checking) { recheck = true; return; }
    checking = true;
    try {
      do {
        recheck = false;
        const result = await bridge.callTool({ name: "get-studio-state", arguments: {} }, { timeout: 5_000 });
        if ((result.structuredContent as { playPressed?: unknown } | undefined)?.playPressed === true) {
          playPressed = true;
          syncRelay();
        }
      } while (recheck && !playPressed);
    } catch {
      /* no answer: the next report asks again */
    } finally {
      checking = false;
    }
  };
  bridge.onupdatemodelcontext = async () => {
    void checkPlayPressed();
    return {};
  };
  bridge.onloggingmessage = ({ data }) => {
    if ((data as { event?: unknown } | null)?.event === "play-pressed") void checkPlayPressed();
  };
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
      // Native where the browser allows it; else the stage fills the viewport
      // (iPhone Safari has no Element Fullscreen API).
      await enterStageFullscreen(stage, document);
      displayMode = "fullscreen";
    } else if (mode === "inline") {
      await leaveStageFullscreen(stage, document);
      displayMode = "inline";
    }
    bridge.setHostContext(hostContext());
    return { mode: displayMode };
  };
  document.addEventListener("fullscreenchange", () => {
    displayMode = stageIsFullscreen(stage, document) ? "fullscreen" : "inline";
    bridge.setHostContext(hostContext());
  });
  // Escape leaves the viewport fill when focus is on this page; inside the player
  // frame the key never reaches us, and the player asks for "inline" itself.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !stage.classList.contains(VIEWPORT_FILL_CLASS)) return;
    void leaveStageFullscreen(stage, document).then(() => {
      displayMode = "inline";
      bridge.setHostContext(hostContext());
    });
  });
  new ResizeObserver(() => bridge.setHostContext(hostContext())).observe(stage);

  // The transport goes up before the frame navigates, so the widget's
  // initialize request can never arrive before our listener (dev/host.ts).
  await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
  // The widget reads ?watch=1 itself: stage only, code hidden, one tap to start.
  frame.src = init.watch && !isScore ? `${init.widget}?watch=1` : init.widget;
  (window as unknown as { __share: unknown }).__share = { bridge, frame, init, relay, relayAnnotations: () => relay?.annotations() };
}

void mount().catch((err) => {
  note.textContent = `The player could not start: ${(err as Error)?.message ?? err}`;
});
