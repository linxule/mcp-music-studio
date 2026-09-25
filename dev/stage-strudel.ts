// =============================================================================
// Strudel screen — the real Strudel widget, fullscreen from the start, for the
// release film. The widget runs exactly as shipped (dist/strudel-app.html);
// this page only hosts it and, for the camera, can hide its chrome (`clean()`)
// or show one visual layer alone (`solo(id)`) by adding a style sheet to the
// same-origin frame.
// =============================================================================

import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

const frame = document.getElementById("w0") as HTMLIFrameElement;
const ctxFor = () => ({
  theme: "dark" as const,
  displayMode: "fullscreen" as const,
  availableDisplayModes: ["inline", "fullscreen"] as ("inline" | "fullscreen")[],
  containerDimensions: { width: innerWidth, height: innerHeight },
});
const bridge = new AppBridge(
  null,
  { name: "StrudelScreen", version: "0.0.0" },
  { openLinks: {}, downloadFile: {}, logging: {}, message: { text: {} }, updateModelContext: { text: {} } },
  { hostContext: ctxFor() },
);
bridge.onmessage = async () => ({});
bridge.onupdatemodelcontext = async () => ({});
bridge.onrequestdisplaymode = async () => ({ mode: "fullscreen" });
let ready!: () => void;
const initialized = new Promise<void>((r) => (ready = r));
bridge.oninitialized = () => ready();
await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
frame.src = "/widgets/strudel-app.html";
await initialized;

async function send(code: string): Promise<void> {
  await bridge.sendToolInput({ arguments: { code, theme: new URLSearchParams(location.search).get("theme") ?? "blackscreen" } });
  await bridge.sendToolResult({ content: [{ type: "text", text: "Strudel pattern ready." }], _meta: { viewUUID: crypto.randomUUID() } } as never);
}

function sheet(id: string, css: string): void {
  const doc = frame.contentDocument!;
  let el = doc.getElementById(id);
  if (!el) {
    el = doc.createElement("style");
    el.id = id;
    doc.head.appendChild(el);
  }
  el.textContent = css;
}

/** No toolbar, no status: only what the widget draws. */
function clean(): void {
  sheet("screen-clean", `.header, header, .toolbar, #status { display: none !important; }
    .main { height: 100vh !important; } .repl-section { height: 100vh !important; flex: 1 1 auto !important; }`);
}

/** Show one visual layer alone (a canvas id: hydra-canvas, test-canvas, roll, beat, rings…), or all with null. */
function solo(id: string | null): void {
  sheet("screen-solo", id ? `.repl-section canvas:not(#${id}) { visibility: hidden !important; }` : "");
}

(window as unknown as { __screen: unknown }).__screen = { send, clean, solo, frame };
(window as unknown as { __stage: boolean }).__stage = true;
console.log("[stage] screen ready");
