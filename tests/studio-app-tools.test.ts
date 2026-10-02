import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "@modelcontextprotocol/ext-apps";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerStudioAppTools } from "../src/studio-app-tools";
import { createStudioSession, installStudioBridge, type StudioCommand, type StudioMode, type StudioSnapshot, type StudioState } from "../src/studio-session";
import { injectTempo } from "../src/shared/tempo";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(close => close()));
  vi.unstubAllGlobals();
});

async function mounted(mode: StudioMode = "live") {
  const state: StudioSnapshot = {
    args: mode === "live" ? { code: 's("bd")', title: "First" } : { abcNotation: "X:1\nK:C\nC", title: "First" },
    ...(mode === "score" ? { settings: { warp: 125, loop: true, room: false } } : {}),
    playback: "stopped", status: "Ready", error: null,
  };
  const apply = vi.fn(async (args: Record<string, unknown>, settings?: Record<string, unknown>) => {
    // Model an actual renderer normalizing tempo into current live source.
    state.args = mode === "live" && args.bpm ? { ...args, code: injectTempo(String(args.code), Number(args.bpm)).code } : args;
    state.settings = settings; state.playback = "stopped";
  });
  const play = vi.fn(async () => { state.playback = "playing"; });
  const stop = vi.fn(() => { state.playback = "stopped"; });
  const session = createStudioSession({ read: () => structuredClone(state), apply, play, stop }, { mode });
  const app = new App({ name: "Test widget", version: "1" }, { tools: { listChanged: true } }, { autoResize: false });
  // Registration precedes the real SDK initialization handshake.
  registerStudioAppTools(app, session);
  const host = new AppBridge(null, { name: "Test host", version: "1" }, {});
  const [hostTransport, appTransport] = InMemoryTransport.createLinkedPair();
  await host.connect(hostTransport);
  await app.connect(appTransport);
  cleanup.push(async () => { session.dispose(); await app.close(); await host.close(); });
  const read = async () => (await host.callTool({ name: "get-studio-state", arguments: {} })).structuredContent as unknown as StudioState;
  const call = (name: string, args: Record<string, unknown>) => host.callTool({ name, arguments: args });
  return { state, session, host, read, call, apply, play, stop };
}

describe("native widget app tools over real App/AppBridge transports", () => {
  it.each(["live", "score"] as const)("stages native %s review responses into the same human-owned request without applying source", async mode => {
    const widget = await mounted(mode);
    widget.state.error = "Previous draft evaluation failed";
    const current = await widget.read();
    const source = String(current.args[mode === "live" ? "code" : "abcNotation"]);
    const passage = { instanceId: current.instanceId, mode, revision: current.revision, from: 0, to: source.length, text: source };
    const begin = (question: string) => widget.session({ action: "review-start", instanceId: current.instanceId, expectedRevision: current.revision, question, passage });
    const started = await begin("How could this phrase change?");
    const review = started.sharedReview!;
    const explanation = await widget.call("explain-selection", { instanceId: current.instanceId, requestId: review.requestId, passage, explanation: "This phrase repeats its rhythm." });
    expect(explanation.isError).toBeUndefined();
    expect(explanation.structuredContent).toMatchObject({ sharedReview: { requestId: review.requestId, explanation: "This phrase repeats its rhythm." }, revision: current.revision, canUndo: false });
    const proposal = await widget.call("suggest-edit", { instanceId: current.instanceId, requestId: review.requestId, passage, explanation: "Try a pause at the end.", replacement: source + " // proposal" });
    expect(proposal.isError).toBeUndefined();
    expect(proposal.structuredContent).toMatchObject({ sharedReview: { requestId: review.requestId, replacement: source + " // proposal", stale: false } });
    expect((await widget.read()).args).toEqual(current.args);
    expect(widget.apply).not.toHaveBeenCalled();
    expect(widget.play).not.toHaveBeenCalled();
    const newer = await begin("Actually, explain the harmony.");
    const late = await widget.call("suggest-edit", { instanceId: current.instanceId, requestId: review.requestId, passage, explanation: "Old response", replacement: "old" });
    expect(late.isError).toBe(true);
    expect((await widget.read()).sharedReview!.requestId).toBe(newer.sharedReview!.requestId);
    await widget.session({ action: "review-clear", instanceId: current.instanceId, requestId: newer.sharedReview!.requestId });
    const cleared = await widget.call("explain-selection", { instanceId: current.instanceId, requestId: newer.sharedReview!.requestId, passage, explanation: "Late response" });
    expect(cleared.isError).toBe(true);
    await expect(widget.call("explain-selection", { requestId: review.requestId, passage, explanation: "Missing instanceId" })).rejects.toThrow("Invalid input");
    expect((await widget.host.listTools({})).tools.map(tool => tool.name)).not.toContain("review-apply");
  });

  it("uses the same authority from a trusted local bridge and removes its listeners on teardown", async () => {
    const widget = await mounted();
    const surface = new EventTarget();
    const css = { rel: "", href: "", remove: vi.fn() };
    const doc = Object.assign(new EventTarget(), {
      referrer: "http://localhost:5173/studio.html",
      documentElement: { dataset: {} },
      createElement: () => css,
      head: { append: vi.fn() },
    });
    const responses = new Map<string, (state: StudioState) => void>();
    const hostWindow = {
      postMessage: vi.fn((response: { channel: string; id: string; state: StudioState }) => {
        if (response.channel === "music-studio-local-result") responses.get(response.id)?.(response.state);
      }),
    };
    vi.stubGlobal("window", surface);
    vi.stubGlobal("parent", hostWindow);
    vi.stubGlobal("document", doc);
    vi.stubGlobal("location", { search: "?studio=1" });
    installStudioBridge(widget.session);
    const local = (command: StudioCommand) => new Promise<StudioState>(resolve => {
      const id = crypto.randomUUID();
      responses.set(id, resolve);
      const event = Object.assign(new Event("message"), {
        source: hostWindow, origin: "http://localhost:5173", data: { channel: "music-studio-local", id, command },
      });
      surface.dispatchEvent(event);
    });
    const before = await local({ action: "get" });
    const changed = await widget.call("set-pattern", { instanceId: before.instanceId, expectedRevision: before.revision, code: "native change" });
    const restored = await local({ action: "undo", instanceId: before.instanceId, expectedRevision: (changed.structuredContent as unknown as StudioState).revision });
    expect(restored.args.code).toBe('s("bd")');
    expect(restored.canUndo).toBe(false);
    expect((await widget.read())).toEqual(restored);
    expect(widget.play).not.toHaveBeenCalled();
    widget.session.dispose();
    expect(css.remove).toHaveBeenCalledOnce();
    hostWindow.postMessage.mockClear();
    surface.dispatchEvent(Object.assign(new Event("message"), {
      source: hostWindow, origin: "http://localhost:5173", data: { channel: "music-studio-local", id: "after-disposal", command: { action: "get" } },
    }));
    expect(hostWindow.postMessage).not.toHaveBeenCalled();
  });

  it("discovers typed tools, reads an unsaved buffer, shares local edits and native undo without autoplay", async () => {
    const widget = await mounted();
    const tools = (await widget.host.listTools({})).tools;
    expect(tools.map(tool => tool.name).sort()).toEqual(["explain-selection", "get-studio-state", "play-current-music", "set-pattern", "stop-music", "suggest-edit", "undo-studio-edit"]);
    const setSchema = tools.find(tool => tool.name === "set-pattern")!.inputSchema;
    expect(setSchema.required).toEqual(expect.arrayContaining(["instanceId", "expectedRevision", "code"]));
    expect(setSchema.additionalProperties).toBe(false);
    widget.state.args.code = "human unsaved draft";
    const before = await widget.read();
    expect(before).toMatchObject({ mode: "live", args: { code: "human unsaved draft" }, revision: 1 });
    const native = await widget.call("set-pattern", { instanceId: before.instanceId, expectedRevision: before.revision, code: 's("sd")', bpm: 120 });
    expect(native.isError).toBeUndefined();
    const changed = native.structuredContent as unknown as StudioState;
    expect(changed.args.code).toBe(injectTempo('s("sd")', 120).code);
    expect(changed.playback).toBe("stopped");
    expect(widget.play).not.toHaveBeenCalled();
    // The localhost bridge calls this same dispatcher: both surfaces see the
    // exact revision, normalized source, and single history.
    const localRead = await widget.session({ action: "get", instanceId: before.instanceId });
    expect(localRead).toEqual(changed);
    const localEdit = await widget.session({ action: "set", instanceId: before.instanceId, expectedRevision: changed.revision, args: { code: "local edit" } });
    expect(localEdit.args).not.toHaveProperty("bpm");
    const undone = await widget.call("undo-studio-edit", { instanceId: before.instanceId, expectedRevision: localEdit.revision });
    expect((undone.structuredContent as unknown as StudioState).args.code).toBe(changed.args.code);
    const restored = await widget.call("undo-studio-edit", { instanceId: before.instanceId, expectedRevision: (undone.structuredContent as unknown as StudioState).revision });
    expect(restored.structuredContent).toMatchObject({ args: { code: "human unsaved draft" }, canUndo: false, playback: "stopped" });
    expect(widget.play).not.toHaveBeenCalled();
  });

  it("rejects stale revisions and identities across two widgets and a remount", async () => {
    const first = await mounted();
    const second = await mounted();
    const before = await first.read();
    first.state.args.code = "later human edit";
    const stale = await first.call("set-pattern", { instanceId: before.instanceId, expectedRevision: before.revision, code: "stale edit" });
    expect(stale).toMatchObject({ isError: true });
    expect(stale.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("Revision conflict") })]));
    const wrong = await second.call("stop-music", { instanceId: before.instanceId });
    expect(wrong.isError).toBe(true);
    expect(second.stop).not.toHaveBeenCalled();
    first.session.dispose();
    const disposed = await first.call("get-studio-state", { instanceId: before.instanceId });
    expect(disposed.isError).toBe(true);
    const remounted = await mounted();
    const oldMount = await remounted.call("set-pattern", { instanceId: before.instanceId, expectedRevision: 0, code: "old mount edit" });
    expect(oldMount.isError).toBe(true);
    expect(first.apply).not.toHaveBeenCalled();
    expect(remounted.apply).not.toHaveBeenCalled();
  });

  it("uses strict score schemas, retains settings, rejects malformed calls, and permits blank drafts", async () => {
    const widget = await mounted("score");
    const before = await widget.read();
    const base = { instanceId: before.instanceId, expectedRevision: before.revision };
    for (const args of [{ ...base }, { ...base, abcNotation: "C", autoplay: true }, { ...base, abcNotation: "C", settings: { warp: 0 } }]) {
      await expect(widget.call("set-score", args)).rejects.toThrow("Invalid input");
    }
    expect((await widget.call("set-score", { ...base, abcNotation: "C", mode: "live" })).isError).toBe(true);
    expect(widget.apply).not.toHaveBeenCalled();
    const blank = await widget.call("set-score", { ...base, abcNotation: "", settings: { room: true } });
    expect(blank.structuredContent).toMatchObject({ args: { abcNotation: "" }, settings: { warp: 125, loop: true, room: true }, playback: "stopped" });
    const restore = await widget.call("undo-studio-edit", { ...base, expectedRevision: (blank.structuredContent as unknown as StudioState).revision });
    expect(restore.structuredContent).toMatchObject({ args: { abcNotation: "X:1\nK:C\nC" }, settings: { warp: 125, loop: true, room: false } });
    expect(widget.play).not.toHaveBeenCalled();
  });
});
