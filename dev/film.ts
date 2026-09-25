// =============================================================================
// Film page — a wordless phone conversation of real widgets, for the 0.5.12
// release film. Driven by a Playwright script (touch pans and taps through CDP,
// so activation is exactly what a phone gives); this page only lays out the
// conversation, mounts each widget in a sandboxed frame with its own AppBridge,
// and draws the finger.
//
//   /film.html            the current widgets (dist/)
//   /film.html?v=old      /widgets/old/*.html — the recorder routes those to
//                         the published 0.5.8 widgets, for the "before" take
// =============================================================================

import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { CONVERSATION, type Turn } from "./film-score";

const params = new URLSearchParams(location.search);
const OLD = params.get("v") === "old";
const SRC = {
  abc: OLD ? "/widgets/old/mcp-app.html" : "/widgets/mcp-app.html",
  strudel: OLD ? "/widgets/old/strudel-app.html" : "/widgets/strudel-app.html",
};
const MAX_H = Number(params.get("maxh") ?? 560) || 560;
document.getElementById("label")!.textContent = params.get("label") ?? "";

const chat = document.getElementById("chat")!;
const finger = document.getElementById("finger")!;
const phone = document.getElementById("phone")!;
const SCALE = Number(params.get("scale") ?? 1) || 1;
const MODE = params.get("mode") === "transform" ? "transform" : "zoom";
if (SCALE !== 1) {
  if (MODE === "zoom") phone.style.zoom = String(SCALE);
  else { phone.style.transform = `scale(${SCALE})`; phone.style.transformOrigin = "0 0"; }
}

function bars(widths: number[]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "bars";
  for (const w of widths) {
    const b = document.createElement("div");
    b.className = "bar";
    b.style.width = `${w}%`;
    wrap.appendChild(b);
  }
  return wrap;
}

type Mounted = { turn: Turn; frame: HTMLIFrameElement; bridge: AppBridge; ready: Promise<void> };
const widgets: Mounted[] = [];

function makeBridge(frame: HTMLIFrameElement, name: string): AppBridge {
  // getBoundingClientRect is in viewport px; the widget thinks in phone px.
  const width = () => Math.round(frame.getBoundingClientRect().width / SCALE);
  const b = new AppBridge(
    null,
    { name, version: "0.0.0" },
    {
      openLinks: {},
      downloadFile: {},
      logging: {},
      message: { text: {}, image: {}, resource: {} },
      updateModelContext: { text: {}, structuredContent: {} },
    },
    {
      hostContext: {
        theme: "dark",
        platform: "mobile",
        displayMode: "inline",
        availableDisplayModes: ["inline", "fullscreen"],
        containerDimensions: { width: width(), maxHeight: MAX_H },
      },
    },
  );
  b.onsizechange = ({ height }) => {
    if (typeof height === "number") frame.style.height = `${Math.min(Math.max(height, 60), MAX_H)}px`;
  };
  b.onmessage = async () => ({});
  b.onupdatemodelcontext = async ({ content }) => {
    const text = (content as { text?: string }[])?.map((c) => c.text).filter(Boolean).join(" ");
    console.log(`[film:${name}] context: ${String(text).slice(0, 160)}`);
    return {};
  };
  b.ondownloadfile = async () => ({});
  b.onopenlink = async () => ({});
  b.onrequestdisplaymode = async ({ mode }) => {
    const full = mode === "fullscreen";
    frame.classList.toggle("full", full);
    // The version label is for the conversation, not the stage.
    document.getElementById("label")!.classList.toggle("off", full);
    if (full) {
      frame.style.top = `${phone.scrollTop}px`;
      phone.style.overflowY = "hidden";
    } else {
      frame.style.top = "";
      phone.style.overflowY = "";
    }
    const r = frame.getBoundingClientRect();
    b.setHostContext({
      theme: "dark",
      platform: "mobile",
      displayMode: full ? "fullscreen" : "inline",
      availableDisplayModes: ["inline", "fullscreen"],
      containerDimensions: full ? { width: Math.round(r.width / SCALE), height: Math.round(r.height / SCALE) } : { width: width(), maxHeight: MAX_H },
    } as never);
    return { mode: full ? "fullscreen" : "inline" };
  };
  b.onerror = (err) => console.warn(`[film:${name}] bridge error`, err);
  return b;
}

function build(): void {
  CONVERSATION.forEach((turn, i) => {
    const you = document.createElement("div");
    you.className = "turn you";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.style.width = `${turn.ask}%`;
    bubble.appendChild(bars(turn.askLines ?? [100, 62]));
    you.appendChild(bubble);
    chat.appendChild(you);

    const me = document.createElement("div");
    me.className = "turn me";
    me.appendChild(bars(turn.reply ?? [92, 70]));
    const frame = document.createElement("iframe");
    frame.className = "widget";
    frame.id = `w${i}`;
    frame.setAttribute("sandbox", "allow-scripts allow-downloads");
    // No allow="autoplay" by default: delegation would let any activation of the
    // host page (a script, a stray click) unlock every widget. ?allow=1 adds it,
    // as the dev harness does.
    if (params.get("allow") === "1") frame.setAttribute("allow", "autoplay; clipboard-write");
    frame.style.height = `${turn.height ?? 220}px`;
    me.appendChild(frame);
    chat.appendChild(me);

    const bridge = makeBridge(frame, `w${i}`);
    let done!: () => void;
    const ready = new Promise<void>((r) => (done = r));
    bridge.oninitialized = () => done();
    widgets.push({ turn, frame, bridge, ready });
  });
}

async function mountAll(): Promise<void> {
  for (const w of widgets) {
    await w.bridge.connect(new PostMessageTransport(w.frame.contentWindow!, w.frame.contentWindow!));
    w.frame.src = SRC[w.turn.widget];
  }
  await Promise.all(widgets.map((w) => w.ready));
}

async function send(i: number, args?: Record<string, unknown>): Promise<void> {
  const w = widgets[i];
  const a = args ?? w.turn.args;
  await w.bridge.sendToolInput({ arguments: a });
  await w.bridge.sendToolResult({
    content: [{ type: "text", text: w.turn.widget === "abc" ? "Sheet music ready." : "Strudel pattern ready." }],
    _meta: { viewUUID: crypto.randomUUID() },
  } as never);
}

/**
 * The finger: drawn by the page, moved by the driver in step with its CDP
 * touches. (x, y) are viewport pixels; the finger lives in the phone's own
 * scrolled coordinates.
 */
function touch(x: number, y: number, state: "down" | "move" | "up" | "tap"): void {
  finger.style.left = `${x / SCALE}px`;
  finger.style.top = `${y / SCALE + phone.scrollTop}px`;
  if (state === "down" || state === "move") finger.classList.add("down");
  if (state === "tap") {
    finger.classList.add("down");
    finger.classList.remove("tap");
    void finger.offsetWidth;
    finger.classList.add("tap");
  }
  if (state === "up") finger.classList.remove("down");
}

/** Widget i's box in viewport pixels (what CDP touches use). */
function rect(i: number) {
  const r = widgets[i].frame.getBoundingClientRect();
  // Measured: under both zoom and transform this is already in viewport px.
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

build();
(window as unknown as { __film: unknown }).__film = {
  old: OLD,
  count: widgets.length,
  send,
  touch,
  rect,
  scale: SCALE,
  mode: MODE,
  phone,
  scrollTo: (y: number) => phone.scrollTo({ top: y, behavior: "instant" as ScrollBehavior }),
  sendAll: async () => { for (let i = 0; i < widgets.length; i++) if (widgets[i].turn.args) await send(i); },
  ready: false,
};
await mountAll();
(window as unknown as { __film: { ready: boolean } }).__film.ready = true;
console.log("[film] ready", OLD ? "(0.5.8)" : "(current)");
