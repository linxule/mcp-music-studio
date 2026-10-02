// Dev-only host for the shipped, opaque-origin widgets. No local studio channel.
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { SharedReview } from "../src/studio-review";

type Mode = "live" | "score";
type Snapshot = {
  mode: Mode;
  instanceId: string;
  revision: number;
  args: Record<string, unknown>;
  playback?: string;
  canUndo?: boolean;
  settings?: Record<string, unknown>;
  sharedReview?: SharedReview | null;
  [key: string]: unknown;
};
type ToolResult = Awaited<ReturnType<AppBridge["callTool"]>>;
type CapturedWrite = { instanceId: string; expectedRevision: number; source: string; mode: Mode };
type Pane = {
  id: "A" | "B";
  root: HTMLElement;
  status: HTMLElement;
  tools: HTMLElement;
  snapshotEl: HTMLElement;
  capturedEl: HTMLElement;
  source: HTMLTextAreaElement;
  wrap: HTMLElement;
  bridge: AppBridge | null;
  frame: HTMLIFrameElement | null;
  snapshot: Snapshot | null;
  captured: CapturedWrite | null;
  capturedReview: SharedReview | null;
  ready: boolean;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const modeSelect = $<HTMLSelectElement>("mode");
const logEl = $("log");
const summary = $("summary");
const REQUEST_TIMEOUT = 20000;
const requestOptions = { timeout: REQUEST_TIMEOUT };
let mode: Mode = "live";
let activeOperations = 0;
let previousA: { instanceId: string; mode: Mode } | null = null;
const entries: { time: string; kind: string; message: string }[] = [];

function log(kind: "info" | "success" | "failure", message: string): void {
  const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
  entries.push({ time, kind, message });
  const line = document.createElement("div");
  line.className = kind;
  line.textContent = `${time} ${kind.toUpperCase()} ${message}`;
  logEl.append(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function seedSource(id: "A" | "B"): string {
  return mode === "live"
    ? `// Stopped seed ${id}\nnote('${id === "A" ? "c3 e3 g3" : "d3 f3 a3"}').s('sine')`
    : `X:1\nT:Stopped seed ${id}\nM:4/4\nL:1/4\nK:C\n${id === "A" ? "C E G c" : "D F A d"}|`;
}

function editName(forMode = mode): string { return forMode === "live" ? "set-pattern" : "set-score"; }
function sourceOf(snapshot: Snapshot): string { return String(snapshot.args.code ?? snapshot.args.abcNotation ?? ""); }
function editArguments(capture: CapturedWrite): Record<string, unknown> {
  return {
    mode: capture.mode,
    instanceId: capture.instanceId,
    expectedRevision: capture.expectedRevision,
    ...(capture.mode === "live" ? { code: capture.source } : { abcNotation: capture.source }),
  };
}

function snapshotFrom(result: ToolResult): Snapshot | null {
  const candidates: unknown[] = [result.structuredContent];
  for (const item of result.content) {
    if (item.type !== "text") continue;
    try { candidates.push(JSON.parse(item.text)); } catch { /* ordinary tool text */ }
  }
  for (const value of candidates) {
    if (!value || typeof value !== "object") continue;
    const candidate = value as Partial<Snapshot>;
    if (typeof candidate.instanceId === "string" && typeof candidate.revision === "number"
      && (candidate.mode === "live" || candidate.mode === "score") && candidate.args && typeof candidate.args === "object") {
      return candidate as Snapshot;
    }
  }
  return null;
}

function showSnapshot(pane: Pane, snapshot: Snapshot): void {
  pane.snapshot = snapshot;
  pane.status.textContent = `${snapshot.mode} · instance ${snapshot.instanceId} · revision ${snapshot.revision} · ${snapshot.playback ?? "playback unavailable"} · undo ${String(snapshot.canUndo ?? "unknown")}`;
  pane.snapshotEl.textContent = JSON.stringify(snapshot, null, 2);
}

function requireBridge(pane: Pane): AppBridge {
  if (!pane.bridge || !pane.ready) throw new Error(`${pane.id}: widget is not connected; remount first.`);
  return pane.bridge;
}

async function call(pane: Pane, name: string, args: Record<string, unknown>, options = requestOptions): Promise<ToolResult> {
  log("info", `${pane.id} → ${name} ${JSON.stringify(args)}`);
  const result = await requireBridge(pane).callTool({ name, arguments: args }, options);
  const snapshot = snapshotFrom(result);
  if (snapshot) showSnapshot(pane, snapshot);
  log(result.isError ? "failure" : "success", `${pane.id} ← ${name} ${JSON.stringify(result)}`);
  return result;
}

function assertSuccess(result: ToolResult): void {
  if (result.isError) {
    throw new Error(result.content.filter(item => item.type === "text").map(item => item.text).join("\n") || "Tool returned isError.");
  }
}

async function read(pane: Pane): Promise<Snapshot> {
  const result = await call(pane, "get-studio-state", { mode });
  assertSuccess(result);
  const snapshot = snapshotFrom(result);
  if (!snapshot) throw new Error(`${pane.id}: state response omitted mode, instanceId, revision or args.`);
  return snapshot;
}

async function discover(pane: Pane): Promise<void> {
  const tools: Awaited<ReturnType<AppBridge["listTools"]>>["tools"] = [];
  let cursor: string | undefined;
  do {
    const result = await requireBridge(pane).listTools(cursor ? { cursor } : {}, requestOptions);
    tools.push(...result.tools);
    cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
    if (tools.length > 100) throw new Error("Tool discovery exceeded the harness limit.");
  } while (cursor);
  pane.tools.textContent = tools.map(tool => `${tool.name}: ${tool.description ?? ""}`).join("\n");
  log("success", `${pane.id} discovered ${tools.map(tool => tool.name).join(", ")}`);
  const required = ["get-studio-state", editName(), "play-current-music", "stop-music", "undo-studio-edit", "explain-selection", "suggest-edit"];
  const missing = required.filter(name => !tools.some(tool => tool.name === name));
  if (missing.length) throw new Error(`${pane.id}: missing app tools ${missing.join(", ")}. Build the widgets before mounting.`);
  const oppositeEdit = editName(mode === "live" ? "score" : "live");
  if (tools.some(tool => tool.name === oppositeEdit)) throw new Error(`${pane.id}: discovered unexpected ${oppositeEdit} in ${mode} mode.`);
}

async function dispose(pane: Pane): Promise<void> {
  const bridge = pane.bridge;
  pane.ready = false;
  pane.bridge = null;
  if (bridge) {
    try { await bridge.teardownResource({}, { timeout: 4000 }); log("success", `${pane.id} teardown acknowledged.`); }
    catch (error) { log("failure", `${pane.id} teardown: ${errorText(error)}`); }
    try { await bridge.close(); } catch (error) { log("failure", `${pane.id} close: ${errorText(error)}`); }
  }
  pane.frame?.remove();
  pane.frame = null;
  pane.snapshot = null;
}

async function mount(pane: Pane): Promise<void> {
  await dispose(pane);
  pane.status.textContent = "Loading built widget…";
  pane.tools.textContent = "Not discovered yet";
  pane.snapshotEl.textContent = "Not read yet";
  pane.captured = null;
  pane.capturedReview = null;
  $(`review-captured-${pane.id}`).textContent = "No review captured. Begin a question in the embedded widget.";
  $<HTMLTextAreaElement>(`review-replacement-${pane.id}`).value = "";
  pane.capturedEl.textContent = "No captured write";
  pane.source.value = seedSource(pane.id);
  const frame = document.createElement("iframe");
  frame.id = `widget-${pane.id}`;
  frame.title = `Music widget ${pane.id}`;
  frame.setAttribute("sandbox", "allow-scripts allow-downloads");
  pane.wrap.replaceChildren(frame);
  pane.frame = frame;
  const bridge = new AppBridge(null, { name: "MusicStudioAppToolsHost", version: "0.0.0" }, {
    logging: {},
    message: { text: {} },
    updateModelContext: { text: {}, structuredContent: {} },
  }, { hostContext: {
    theme: "dark", displayMode: "inline", availableDisplayModes: ["inline"],
    containerDimensions: { width: Math.round(pane.wrap.clientWidth), maxHeight: 460 },
  } });
  pane.bridge = bridge;
  bridge.onmessage = async params => { log("info", `${pane.id} ui/message ${JSON.stringify(params)}`); return {}; };
  bridge.onupdatemodelcontext = async params => { log("info", `${pane.id} ui/update-model-context ${JSON.stringify(params)}`); return {}; };
  bridge.onerror = error => log("failure", `${pane.id} bridge: ${error.message}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const initialized = new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${pane.id}: initialization timed out after 15 seconds.`)), 15000);
    bridge.oninitialized = () => { clearTimeout(timer); pane.ready = true; resolve(); };
  });
  try {
    await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
    // These are exactly the built resources; no ?studio=1 or custom bridge.
    frame.src = mode === "live" ? "/widgets/strudel-app.html" : "/widgets/mcp-app.html";
    await initialized;
    log("success", `${pane.id} initialized ${JSON.stringify(bridge.getAppVersion())}`);
    await discover(pane);
    const initial = await read(pane);
    assertSuccess(await call(pane, editName(), editArguments({
      mode, instanceId: initial.instanceId, expectedRevision: initial.revision, source: pane.source.value,
    })));
    const seeded = await read(pane);
    if (seeded.playback !== "stopped") throw new Error(`${pane.id}: seed playback is ${String(seeded.playback)}, expected stopped.`);
    log("success", `${pane.id} stopped seed installed at revision ${seeded.revision}; playback=${seeded.playback}.`);
  } catch (error) {
    pane.status.textContent = `Mount failed: ${errorText(error)}`;
    throw error;
  } finally { clearTimeout(timer); }
}

function comparison(snapshot: Snapshot): string {
  return JSON.stringify([snapshot.instanceId, snapshot.revision, snapshot.args, snapshot.settings]);
}

async function rejectedWrite(pane: Pane, capture: CapturedWrite, label: string): Promise<void> {
  const before = await read(pane);
  let rejected = false;
  let rejection = "";
  try {
    const result = await call(pane, editName(capture.mode), editArguments(capture));
    rejected = result.isError === true;
    rejection = result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
  } catch (error) {
    // A request timeout is an evidence gap, never proof of identity/revision rejection.
    if (/timed? ?out|timeout/i.test(errorText(error))) throw error;
    rejected = true;
    rejection = errorText(error);
    log("info", `${pane.id} ${label} returned protocol error: ${errorText(error)}`);
  }
  const after = await read(pane);
  if (!rejected) throw new Error(`${label}: request unexpectedly succeeded.`);
  const expectedReason = capture.instanceId !== before.instanceId ? /instance conflict/i : /revision conflict/i;
  if (!expectedReason.test(rejection)) throw new Error(`${label}: rejected for an unexpected reason: ${rejection}`);
  if (comparison(before) !== comparison(after)) throw new Error(`${label}: rejected request changed the current draft.`);
  log("success", `${pane.id} CHECK ${label}: rejected; current instance, revision, source and settings preserved.`);
}

async function run(label: string, operation: () => Promise<void>): Promise<void> {
  if (activeOperations) { log("failure", "Wait for the current operation before another request."); return; }
  activeOperations++;
  document.querySelectorAll<HTMLButtonElement | HTMLSelectElement>("button, select").forEach(el => { el.disabled = true; });
  summary.textContent = `${label}…`;
  try { await operation(); summary.textContent = `${label} completed. See outcomes below.`; }
  catch (error) { const message = errorText(error); log("failure", `${label}: ${message}`); summary.textContent = `${label} failed: ${message}`; }
  finally {
    activeOperations--;
    document.querySelectorAll<HTMLButtonElement | HTMLSelectElement>("button, select").forEach(el => { el.disabled = false; });
  }
}

function makePane(id: "A" | "B"): Pane {
  const root = document.createElement("section");
  root.className = "pane";
  root.innerHTML = `<h2>Widget ${id}</h2>
    <p id="state-${id}" class="pane-state">Not mounted</p>
    <details><summary>Discovered tools</summary><pre id="tools-${id}" class="tools">Not discovered yet</pre></details>
    <div id="frame-${id}" class="frame-wrap"></div>
    <div class="toolbar">
      <button data-action="discover">Discover ${id}</button><button data-action="read">Read ${id}</button>
      <button data-action="undo">Undo ${id}</button><button data-action="play">Play ${id}</button><button data-action="stop">Stop ${id}</button>
      <button data-action="teardown">Teardown ${id} + check tools disabled</button>
    </div>
    <details open><summary>Current session snapshot</summary><pre id="snapshot-${id}" class="snapshot">Not read yet</pre></details>
    <label for="source-${id}">Agent write source (separate from the widget's human editor)</label>
    <textarea id="source-${id}" spellcheck="false"></textarea>
    <div class="toolbar"><button data-action="write">Read then write ${id}</button>
      <button data-action="capture">Capture write ${id}</button><button data-action="stale">Attempt captured write ${id}</button>
      <button data-action="copy">Copy current snapshot source to write field</button></div>
    <p id="captured-${id}" class="captured">No captured write</p>
    <details open class="review-demo"><summary>Session-owned review demo</summary>
      <p>Begin the question inside this widget: open <b>Work on a passage</b>, enter <b>Ask about this passage</b>, then click <b>Use selection</b>. Capture below, change that question in the widget, then inject the old answer. Apply edit and Undo edit remain human controls in the widget panel.</p>
      <div class="toolbar"><button data-action="review-capture">Capture current review ${id}</button>
        <button data-action="review-old">Inject captured old answer ${id}</button>
        <button data-action="review-explain">Stage current explanation ${id}</button>
        <button data-action="review-suggest">Stage current proposal ${id}</button></div>
      <label for="review-answer-${id}">Demo explanation</label><textarea id="review-answer-${id}" rows="2">This is a test answer for the current question. Review the proposed source before applying.</textarea>
      <label for="review-replacement-${id}">Demo replacement for the exact frozen range</label><textarea id="review-replacement-${id}" rows="3" spellcheck="false"></textarea>
      <p id="review-captured-${id}" class="captured">No review captured. Begin a question in the embedded widget.</p>
    </details>`;
  $("panes").append(root);
  const pane: Pane = {
    id, root, status: $(`state-${id}`), tools: $(`tools-${id}`), snapshotEl: $(`snapshot-${id}`), capturedEl: $(`captured-${id}`),
    source: $<HTMLTextAreaElement>(`source-${id}`), wrap: $(`frame-${id}`), bridge: null, frame: null, snapshot: null, captured: null, capturedReview: null, ready: false,
  };
  root.querySelectorAll<HTMLButtonElement>("button[data-action]").forEach(button => button.addEventListener("click", () => {
    void run(`${id} ${button.dataset.action}`, async () => {
      switch (button.dataset.action) {
        case "discover": await discover(pane); break;
        case "read": await read(pane); break;
        case "review-capture": {
          const snapshot = await read(pane);
          if (!snapshot.sharedReview) throw new Error("Begin a question using the embedded widget's Work on a passage panel first.");
          pane.capturedReview = structuredClone(snapshot.sharedReview);
          $(`review-captured-${id}`).textContent = `Captured request ${snapshot.sharedReview.requestId}: ${snapshot.sharedReview.question}. Change the question inside the widget before injecting the old answer.`;
          $<HTMLTextAreaElement>(`review-replacement-${id}`).value = snapshot.sharedReview.passage.text;
          log("success", `${id} captured review request ${snapshot.sharedReview.requestId}; no source changed.`);
          break;
        }
        case "review-explain": case "review-suggest": {
          const snapshot = await read(pane);
          const review = snapshot.sharedReview;
          if (!review || review.stale) throw new Error("Begin a current question in the embedded widget before staging an answer.");
          const result = await call(pane, button.dataset.action === "review-explain" ? "explain-selection" : "suggest-edit", {
            instanceId: snapshot.instanceId, requestId: review.requestId, passage: review.passage,
            explanation: $<HTMLTextAreaElement>(`review-answer-${id}`).value,
            ...(button.dataset.action === "review-suggest" ? { replacement: $<HTMLTextAreaElement>(`review-replacement-${id}`).value } : {}),
          });
          assertSuccess(result);
          const after = await read(pane);
          if (comparison(snapshot) !== comparison(after)) throw new Error("Staging an answer changed source, revision or settings.");
          if (after.sharedReview?.requestId !== review.requestId || after.sharedReview.explanation !== $<HTMLTextAreaElement>(`review-answer-${id}`).value) throw new Error("The staged answer was not returned by shared review state.");
          log("success", `${id} CHECK review staging: answer visible in sharedReview; source, revision and settings preserved. Apply edit belongs to the embedded human panel.`);
          break;
        }
        case "review-old": {
          const captured = pane.capturedReview;
          if (!captured) throw new Error("Capture a review, then change the question inside the widget first.");
          const before = await read(pane);
          if (before.sharedReview?.requestId === captured.requestId) throw new Error("The request ID has not changed. Edit the question inside the widget first.");
          const result = await call(pane, "suggest-edit", {
            instanceId: captured.passage.instanceId, requestId: captured.requestId, passage: captured.passage,
            explanation: "Late captured answer; must be rejected.", replacement: captured.passage.text,
          });
          const detail = result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
          if (!result.isError || !/review request superseded or cleared/i.test(detail)) throw new Error(`Old answer did not reject for request supersession: ${detail}`);
          const after = await read(pane);
          if (comparison(before) !== comparison(after) || JSON.stringify(before.sharedReview) !== JSON.stringify(after.sharedReview)) throw new Error("The late answer changed source or the current review.");
          log("success", `${id} CHECK late answer: old request rejected; source and new question/review preserved.`);
          break;
        }
        case "copy": {
          const snapshot = await read(pane);
          pane.source.value = sourceOf(snapshot);
          break;
        }
        case "write": {
          const snapshot = await read(pane);
          assertSuccess(await call(pane, editName(), editArguments({ mode, instanceId: snapshot.instanceId, expectedRevision: snapshot.revision, source: pane.source.value })));
          await read(pane);
          break;
        }
        case "capture": {
          const snapshot = await read(pane);
          pane.captured = { mode, instanceId: snapshot.instanceId, expectedRevision: snapshot.revision, source: pane.source.value };
          pane.capturedEl.textContent = `Captured instance ${snapshot.instanceId}, revision ${snapshot.revision}. Edit inside the widget before attempting this write.`;
          log("info", `${id} captured write at revision ${snapshot.revision}; no mutation sent.`);
          break;
        }
        case "stale": {
          if (!pane.captured) throw new Error("Capture a write before checking stale revisions.");
          const current = await read(pane);
          if (current.revision === pane.captured.expectedRevision) throw new Error("Revision has not changed: edit the widget itself first, then attempt the captured write.");
          await rejectedWrite(pane, pane.captured, "stale captured write");
          break;
        }
        case "undo": case "play": case "stop": {
          const snapshot = await read(pane);
          const name = button.dataset.action === "undo" ? "undo-studio-edit" : button.dataset.action === "play" ? "play-current-music" : "stop-music";
          assertSuccess(await call(pane, name, { mode, instanceId: snapshot.instanceId,
            ...(button.dataset.action === "stop" ? {} : { expectedRevision: snapshot.revision }) }));
          await read(pane);
          break;
        }
        case "teardown": {
          const bridge = requireBridge(pane);
          await bridge.teardownResource({}, { timeout: 4000 });
          log("success", `${id} teardown acknowledged; checking tools on the same transport.`);
          let disabled = false;
          try {
            const result = await bridge.callTool({ name: "get-studio-state", arguments: { mode } }, { timeout: 1500 });
            disabled = result.isError === true;
            log("info", `${id} post-teardown response ${JSON.stringify(result)}`);
          } catch (error) {
            disabled = true;
            log("info", `${id} post-teardown request failed: ${errorText(error)} (timeout establishes only no response).`);
          }
          pane.ready = false;
          await bridge.close();
          pane.bridge = null;
          pane.status.textContent = "Torn down; remount to continue.";
          if (!disabled) throw new Error("App tool still answered successfully after teardown.");
          log("success", `${id} CHECK teardown: no successful tool response after acknowledgement; transport closed.`);
          break;
        }
      }
    });
  }));
  return pane;
}

const panes = [makePane("A"), makePane("B")];
async function mountBoth(): Promise<void> {
  previousA = null;
  mode = modeSelect.value as Mode;
  $("score-settings-replacement").hidden = mode !== "score";
  // Sequential mounts make initial seed outcomes unambiguous in the log.
  for (const pane of panes) await mount(pane);
  if (panes[0]!.snapshot!.instanceId === panes[1]!.snapshot!.instanceId) throw new Error("A and B returned the same instance ID.");
  log("success", `CHECK isolation: distinct ${mode} instance IDs for A and B.`);
}

async function checkScoreSettingsReplacement(): Promise<void> {
  if (mode !== "score") throw new Error("Score settings replacement requires Score mode.");
  const pane = panes[0]!;
  const initial = await read(pane);
  if (initial.mode !== "score") throw new Error("A is not a score widget.");
  const changedSettings = { soundFont: "dry", room: false, instrumentOverride: true, warp: 150, loop: true };
  assertSuccess(await call(pane, "set-score", {
    ...initial.args, mode: "score", instanceId: initial.instanceId,
    expectedRevision: initial.revision, settings: changedSettings,
  }));
  const changed = await read(pane);
  log("info", `A settings before replacement: ${JSON.stringify(changed.settings)}`);
  for (const [key, value] of Object.entries(changedSettings)) {
    if (changed.settings?.[key] !== value) throw new Error(`Initial settings write did not apply ${key}: expected ${JSON.stringify(value)}, actual ${JSON.stringify(changed.settings?.[key])}.`);
  }
  if (sourceOf(changed) !== sourceOf(initial) || changed.args.title !== initial.args.title) {
    throw new Error("Initial settings write changed the current source or title.");
  }
  assertSuccess(await call(pane, "set-score", {
    ...changed.args, mode: "score", instanceId: changed.instanceId,
    expectedRevision: changed.revision, replace: true, settings: { warp: 100 },
  }));
  const replaced = await read(pane);
  log("info", `A actual settings after replacement: ${JSON.stringify(replaced.settings)}`);
  const defaults = { soundFont: "default", room: true, instrumentOverride: false, warp: 100, loop: false };
  for (const [key, value] of Object.entries(defaults)) {
    if (replaced.settings?.[key] !== value) throw new Error(`Settings replacement did not restore ${key}: expected ${JSON.stringify(value)}, actual ${JSON.stringify(replaced.settings?.[key])}.`);
  }
  if (sourceOf(replaced) !== sourceOf(initial) || replaced.args.title !== initial.args.title) {
    throw new Error("Settings replacement changed the current source or title.");
  }
  log("success", `A CHECK score settings replacement: complete defaults restored; source and title preserved. Actual settings ${JSON.stringify(replaced.settings)}`);
}

$("mount-both").addEventListener("click", () => { void run("Mount both", mountBoth); });
$("score-settings-replacement").addEventListener("click", () => { void run("Score settings replacement", checkScoreSettingsReplacement); });
modeSelect.addEventListener("change", () => { void run("Switch mode and mount both", mountBoth); });
$("remount-a").addEventListener("click", () => { void run("Remount A", async () => {
  const old = await read(panes[0]!);
  previousA = { instanceId: old.instanceId, mode: old.mode };
  await mount(panes[0]!);
  if (old.instanceId === panes[0]!.snapshot!.instanceId) throw new Error("Remount reused the old instance ID.");
  log("success", `A mount ID changed ${old.instanceId} → ${panes[0]!.snapshot!.instanceId}. Old-instance check is ready.`);
}); });
$("old-instance").addEventListener("click", () => { void run("Old-instance rejection", async () => {
  if (!previousA) throw new Error("Remount A first to retain its previous instance ID.");
  const snapshot = await read(panes[0]!);
  await rejectedWrite(panes[0]!, { mode: previousA.mode, instanceId: previousA.instanceId, expectedRevision: snapshot.revision, source: panes[0]!.source.value }, "old mount instance write");
}); });
$("wrong-instance").addEventListener("click", () => { void run("Wrong-instance rejection", async () => {
  const a = await read(panes[0]!);
  const b = await read(panes[1]!);
  await rejectedWrite(panes[0]!, { mode, instanceId: b.instanceId, expectedRevision: a.revision, source: panes[0]!.source.value }, "B instance routed to A");
  const bAfter = await read(panes[1]!);
  if (comparison(b) !== comparison(bAfter)) throw new Error("Wrong-instance request changed B.");
  log("success", "CHECK wrong-instance routing: B also preserved.");
}); });
$("clear-log").addEventListener("click", () => { entries.length = 0; logEl.replaceChildren(); });

// Protocol-only handles for browser diagnostics; opaque widget DOM stays opaque.
Object.assign(window, { __appTools: { panes, entries, read, discover, call, mount, run, get mode() { return mode; } } });
window.addEventListener("pagehide", () => { for (const pane of panes) { void pane.bridge?.close(); pane.frame?.remove(); } });
void run("Initial stopped seeds", mountBoth);
