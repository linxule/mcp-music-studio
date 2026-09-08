// =============================================================================
// Local ext-apps HOST harness — drives the built widgets in a plain Chrome tab.
//
// The widgets (dist/strudel-app.html, dist/mcp-app.html) only ever receive input
// through the MCP Apps protocol (`ui/notifications/tool-input`). In production
// that comes from Claude Desktop; here it comes from this page, using the SDK's
// own host side (AppBridge + PostMessageTransport) rather than hand-rolled
// JSON-RPC, so the handshake and schemas are exactly the real ones.
//
// ⚠️ This harness does NOT enforce the widget's CSP. The real host applies the
// `csp` from `_meta.ui` (STRUDEL_CSP / SHEET_CSP in src/shared/tool-defs.ts), so
// any CDN or fetch origin that works here must still be declared there or it
// will be blocked in Claude Desktop.
//
// The iframe is same-origin and unsandboxed by default, which lets you poke at
// the widget's globals from DevTools (`__harness.win.strudel`). Tick "sandbox
// iframe" to approximate the host's `sandbox="allow-scripts"` frame instead;
// that gives the frame an opaque origin, so cross-frame inspection stops working
// but the postMessage protocol still does.
// =============================================================================

import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { PRESETS, type Preset } from "./presets";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const widgetSel = $<HTMLSelectElement>("widget");
const presetSel = $<HTMLSelectElement>("preset");
const widthSel = $<HTMLSelectElement>("frame-width");
const sandboxCb = $<HTMLInputElement>("sandboxed");
const argsTa = $<HTMLTextAreaElement>("args");
const logEl = $<HTMLPreElement>("log");
const stateEl = $<HTMLSpanElement>("state");
const frameWrap = $<HTMLDivElement>("frame-wrap");

const WIDGET_SRC: Record<string, string> = {
  strudel: "/widgets/strudel-app.html",
  abc: "/widgets/mcp-app.html",
};

let bridge: AppBridge | null = null;
let iframe: HTMLIFrameElement | null = null;
let ready = false;

// -----------------------------------------------------------------------------
// Log
// -----------------------------------------------------------------------------

const entries: { t: number; dir: string; text: string }[] = [];

function log(dir: "in" | "out" | "bad", text: string): void {
  const t = Date.now();
  entries.push({ t, dir, text });
  const line = document.createElement("div");
  const stamp = new Date(t).toLocaleTimeString("en-GB", { hour12: false });
  line.innerHTML = `<span class="t">${stamp}</span> <span class="${dir}">${
    dir === "in" ? "◀" : dir === "out" ? "▶" : "✖"
  }</span> `;
  line.appendChild(document.createTextNode(text));
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function setState(text: string, kind: "" | "ok" | "err" = ""): void {
  stateEl.textContent = text;
  stateEl.className = `state ${kind}`;
}

/** One-line summary of a content block — never dumps base64 payloads. */
function describeContent(content: unknown[] | undefined): string {
  if (!content?.length) return "(no content)";
  return content
    .map((raw) => {
      const b = raw as Record<string, any>;
      if (b.type === "text") {
        const text = String(b.text ?? "");
        return `text(${text.length}B): ${text.length > 220 ? `${text.slice(0, 220)}…` : text}`;
      }
      if (b.type === "resource") {
        const r = b.resource ?? {};
        const bytes = typeof r.blob === "string" ? Math.floor((r.blob.length * 3) / 4) : 0;
        return `resource ${r.mimeType ?? "?"} uri=${r.uri ?? "?"} ~${bytes.toLocaleString()} bytes`;
      }
      return `${b.type ?? "unknown"} block`;
    })
    .join(" | ");
}

// -----------------------------------------------------------------------------
// Presets
// -----------------------------------------------------------------------------

function fillPresets(): void {
  const widget = widgetSel.value;
  presetSel.replaceChildren();
  for (const p of PRESETS.filter((x) => x.widget === widget)) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.label;
    presetSel.appendChild(opt);
  }
  applyPreset();
}

function applyPreset(): void {
  const p = PRESETS.find((x) => x.id === presetSel.value);
  if (p) argsTa.value = JSON.stringify(p.args, null, 2);
}

function readArgs(): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(argsTa.value);
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch (err) {
    setState(`bad JSON: ${(err as Error).message}`, "err");
    log("bad", `arguments JSON is invalid: ${(err as Error).message}`);
    return null;
  }
}

// -----------------------------------------------------------------------------
// Frame + bridge
// -----------------------------------------------------------------------------

async function mountFrame(): Promise<void> {
  ready = false;
  setState("loading…");

  if (bridge) {
    try {
      await bridge.close();
    } catch { /* already gone */ }
    bridge = null;
  }
  frameWrap.replaceChildren();

  const frame = document.createElement("iframe");
  frame.id = "widget-frame";
  frame.setAttribute("allow", "autoplay; microphone; clipboard-write");
  if (sandboxCb.checked) {
    // What the real host uses. Opaque origin: postMessage still works.
    frame.setAttribute("sandbox", "allow-scripts allow-downloads");
  }
  const w = widthSel.value;
  frameWrap.style.width = w ? `${w}px` : "100%";
  frameWrap.appendChild(frame);
  iframe = frame;

  // Attach the transport BEFORE navigating so the view's `initialize` request
  // can never race ahead of our listener.
  const b = new AppBridge(
    null,
    { name: "MusicStudioDevHost", version: "0.0.0" },
    {
      openLinks: {},
      downloadFile: {},
      logging: {},
      message: { text: {}, image: {}, resource: {} },
      updateModelContext: { text: {}, structuredContent: {} },
    },
    { hostContext: { theme: "dark", displayMode: "inline" } },
  );
  wireBridge(b);
  await b.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
  bridge = b;

  frame.src = WIDGET_SRC[widgetSel.value];
}

/**
 * Resolve once the widget in the frame has completed its ext-apps handshake.
 *
 * mountFrame() resolves as soon as the transport is connected and the src is
 * assigned; `ready` only flips in `oninitialized`, which is what sendToolInput()
 * actually requires. Anything that remounts must wait for THIS, not for
 * mountFrame().
 */
function waitForReady(timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (ready) { resolve(); return; }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("widget did not initialize within " + timeoutMs + "ms"));
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}

function wireBridge(b: AppBridge): void {
  b.oninitialized = () => {
    ready = true;
    const info = b.getAppVersion();
    setState(`connected: ${info?.name ?? "?"} v${info?.version ?? "?"}`, "ok");
    log("in", `ui/notifications/initialized — ${info?.name} v${info?.version}`);
  };

  b.onsizechange = ({ width, height }) => {
    log("in", `ui/notifications/size-changed w=${width ?? "-"} h=${height ?? "-"}`);
  };

  b.onmessage = async ({ role, content }) => {
    log("in", `ui/message role=${role} — ${describeContent(content as unknown[])}`);
    return {};
  };

  b.onupdatemodelcontext = async ({ content, structuredContent }) => {
    const extra = structuredContent ? ` structured=${JSON.stringify(structuredContent)}` : "";
    log("in", `ui/update-model-context — ${describeContent(content as unknown[])}${extra}`);
    return {};
  };

  b.ondownloadfile = async ({ contents }) => {
    log("in", `ui/download-file — ${describeContent(contents as unknown[])}`);
    return {};
  };

  b.onopenlink = async ({ url }) => {
    log("in", `ui/open-link ${url}`);
    return {};
  };

  b.onrequestdisplaymode = async ({ mode }) => {
    log("in", `ui/request-display-mode ${mode}`);
    // Report back what we actually granted; the harness frame never goes
    // fullscreen, so echo the request and note it.
    b.setHostContext({ theme: "dark", displayMode: mode });
    return { mode };
  };

  b.onerror = (err) => log("bad", `bridge error: ${err.message}`);
  b.onclose = () => log("out", "bridge closed");
}

// -----------------------------------------------------------------------------
// Sending
// -----------------------------------------------------------------------------

function resultTextFor(args: Record<string, unknown>): string {
  const title = typeof args.title === "string" ? `"${args.title}" — ` : "";
  return widgetSel.value === "strudel"
    ? `${title}Strudel pattern ready. It plays in an editable REPL widget in MCP-app hosts.`
    : `${title}Sheet music ready.`;
}

async function sendToolInput(): Promise<void> {
  const args = readArgs();
  if (!args || !bridge) return;
  if (!ready) {
    log("bad", "view not initialized yet — reload the frame and retry");
    return;
  }
  log("out", `ui/notifications/tool-input ${JSON.stringify(args).slice(0, 200)}…`);
  await bridge.sendToolInput({ arguments: args });
  await bridge.sendToolResult({ content: [{ type: "text", text: resultTextFor(args) }] });
  log("out", "ui/notifications/tool-result");
}

async function sendPartial(): Promise<void> {
  const args = readArgs();
  if (!args || !bridge || !ready) return;
  const code = String(args.code ?? args.abcNotation ?? "");
  const half = code.slice(0, Math.ceil(code.length / 2));
  const key = args.code !== undefined ? "code" : "abcNotation";
  log("out", `ui/notifications/tool-input-partial (${half.length} of ${code.length} chars)`);
  await bridge.sendToolInputPartial({ arguments: { ...args, [key]: half } });
}

// -----------------------------------------------------------------------------
// Wiring
// -----------------------------------------------------------------------------

widgetSel.addEventListener("change", () => {
  fillPresets();
  void mountFrame();
});
presetSel.addEventListener("change", applyPreset);
widthSel.addEventListener("change", () => {
  // Resize WITHOUT remounting, so a running pattern keeps playing — this is how
  // we exercise the widget's ResizeObserver / Hydra setResolution path.
  frameWrap.style.width = widthSel.value ? `${widthSel.value}px` : "100%";
});
sandboxCb.addEventListener("change", () => void mountFrame());
$("reload").addEventListener("click", () => void mountFrame());
$("send").addEventListener("click", () => void sendToolInput());
$("send-partial").addEventListener("click", () => void sendPartial());
$("cancel").addEventListener("click", () => {
  void bridge?.sendToolCancelled({ reason: "user cancelled" });
  log("out", "ui/notifications/tool-cancelled");
});
$("teardown").addEventListener("click", async () => {
  if (!bridge) return;
  log("out", "ui/resource-teardown");
  try {
    await bridge.teardownResource({});
    log("in", "teardown ack");
  } catch (err) {
    log("bad", `teardown failed: ${(err as Error).message}`);
  }
});
$("clear-log").addEventListener("click", () => {
  entries.length = 0;
  logEl.replaceChildren();
});

fillPresets();
void mountFrame();

// Handles for browser automation / DevTools poking.
(window as any).__harness = {
  get bridge() { return bridge; },
  get frame() { return iframe; },
  get win() { return iframe?.contentWindow as any; },
  get doc() { return iframe?.contentDocument; },
  entries,
  send: sendToolInput,
  mount: mountFrame,
  setArgs(args: Record<string, unknown>) {
    argsTa.value = JSON.stringify(args, null, 2);
  },
  get ready() { return ready; },
  waitForReady,
  /**
   * Select a preset the way the UI does — INCLUDING the remount.
   *
   * The <select> change event is what normally mounts the matching widget, and
   * setting `.value` from script does not fire it. Without the remount, picking
   * an ABC preset from a Strudel frame left the Strudel widget mounted and
   * `send()` posted ABC arguments into the Strudel bridge. Async so callers can
   * await the new widget's handshake before sending anything.
   */
  async usePreset(id: string) {
    const p = PRESETS.find((x: Preset) => x.id === id);
    if (!p) throw new Error(`no preset ${id}`);
    const remount = widgetSel.value !== p.widget;
    widgetSel.value = p.widget;
    fillPresets();
    presetSel.value = id;
    applyPreset();
    if (remount) {
      await mountFrame();
      await waitForReady();
    }
  },
};
