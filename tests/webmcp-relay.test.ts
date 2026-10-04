import { liveStudioSchemas, scoreStudioSchemas } from "../src/studio-schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "@modelcontextprotocol/ext-apps";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import {
  createWidgetToolRelay, findModelContext, registerWebMcpTool, toWebMcpValue,
  type WebMcpContext, type WebMcpTool, type WidgetTool, type WidgetToolBridge, type WidgetToolResult,
} from "../src/webmcp-relay";
import { registerStudioAppTools } from "../src/studio-app-tools";
import { createStudioSession, type StudioSnapshot, type StudioState } from "../src/studio-session";
import { RELAY_AFTER_PLAY_PRESS, shareRelayAnnotations, shareRelayExclude } from "../src/share-relay-policy";

/** document.modelContext as the spec and Chromium 153 behave: abort unregisters, a duplicate name rejects. */
function fakeContext() {
  const tools = new Map<string, WebMcpTool>();
  const registerTool = vi.fn(async (tool: WebMcpTool, options?: { signal?: AbortSignal }) => {
    if (tools.has(tool.name)) throw Object.assign(new Error("Duplicate tool name"), { name: "InvalidStateError" });
    tools.set(tool.name, tool);
    options?.signal?.addEventListener("abort", () => { if (tools.get(tool.name) === tool) tools.delete(tool.name); });
  });
  const context: WebMcpContext = { registerTool };
  const run = (name: string, input: Record<string, unknown> = {}, signal = new AbortController().signal) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`no WebMCP tool ${name}`);
    return tool.execute(input, { signal });
  };
  return { context, tools, registerTool, run, names: () => [...tools.keys()].sort() };
}

function fakeBridge(initial: WidgetTool[], results: Record<string, WidgetToolResult | (() => WidgetToolResult)> = {}) {
  const state = { tools: initial };
  const listTools = vi.fn(async () => ({ tools: state.tools }));
  const callTool = vi.fn(async (params: { name: string; arguments?: Record<string, unknown> }) => {
    const result = results[params.name];
    if (!result) throw new Error(`Tool ${params.name} not found`);
    return typeof result === "function" ? result() : result;
  });
  const bridge: WidgetToolBridge = { listTools, callTool };
  return { bridge, state, listTools, callTool };
}

const getTool: WidgetTool = {
  name: "get-studio-state",
  description: "Read this widget's live music source.",
  inputSchema: { type: "object", properties: { instanceId: { type: "string" } } },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};
const setTool: WidgetTool = {
  name: "set-pattern",
  title: "Set pattern",
  description: "Replace this widget's Strudel source, stopped.",
  inputSchema: { type: "object", properties: { code: { type: "string" }, expectedRevision: { type: "integer" } }, required: ["code", "expectedRevision"] },
  annotations: { destructiveHint: false, openWorldHint: false },
};
const reviewTool: WidgetTool = { name: "explain-selection", description: "Stage an explanation.", inputSchema: { type: "object", properties: {} } };

afterEach(() => vi.unstubAllGlobals());

describe("findModelContext", () => {
  it("prefers document.modelContext, falls back to navigator.modelContext, and ignores anything without registerTool", () => {
    const doc = { registerTool: vi.fn() };
    const nav = { registerTool: vi.fn() };
    expect(findModelContext({ document: { modelContext: doc }, navigator: { modelContext: nav } })).toBe(doc);
    expect(findModelContext({ document: {}, navigator: { modelContext: nav } })).toBe(nav);
    expect(findModelContext({ document: { modelContext: {} }, navigator: {} })).toBeUndefined();
    expect(findModelContext({})).toBeUndefined();
  });

  it("reads the page's globals by default", () => {
    const mc = { registerTool: vi.fn() };
    vi.stubGlobal("document", { modelContext: mc });
    expect(findModelContext()).toBe(mc);
  });
});

describe("createWidgetToolRelay", () => {
  it("does nothing without a WebMCP context, not even listing the widget's tools", async () => {
    const { bridge, listTools } = fakeBridge([getTool]);
    expect(createWidgetToolRelay({ bridge })).toBeUndefined();
    expect(listTools).not.toHaveBeenCalled();
  });

  it("mirrors the widget's names, descriptions, schemas and annotations", async () => {
    const { context, tools } = fakeContext();
    const { bridge } = fakeBridge([getTool, setTool]);
    const relay = createWidgetToolRelay({ bridge, modelContext: context })!;
    await relay.refresh();
    expect(relay.tools().sort()).toEqual(["get-studio-state", "set-pattern"]);
    const mirrored = tools.get("get-studio-state")!;
    expect(mirrored.description).toBe(getTool.description);
    expect(mirrored.inputSchema).toEqual(getTool.inputSchema);
    expect(mirrored.annotations).toEqual(getTool.annotations);
    expect(tools.get("set-pattern")).toMatchObject({ title: "Set pattern", inputSchema: setTool.inputSchema, annotations: setTool.annotations });
    expect(tools.get("get-studio-state")).not.toHaveProperty("title");
  });

  it("appends the description line, merges extra annotations, and falls back when a tool has no description", async () => {
    const { context, tools } = fakeContext();
    const { bridge } = fakeBridge([getTool, { name: "bare" }, { name: "titled", title: "Titled" }]);
    const relay = createWidgetToolRelay({
      bridge, modelContext: context,
      descriptionSuffix: "This controls the music player on this page.",
      annotate: tool => (tool.annotations?.readOnlyHint ? { untrustedContentHint: true } : undefined),
    })!;
    await relay.refresh();
    expect(tools.get("get-studio-state")!.description).toBe(`${getTool.description}\nThis controls the music player on this page.`);
    expect(tools.get("get-studio-state")!.annotations).toEqual({ ...getTool.annotations, untrustedContentHint: true });
    expect(tools.get("bare")!.description).toBe("bare\nThis controls the music player on this page.");
    expect(tools.get("titled")!.description).toBe("Titled\nThis controls the music player on this page.");
    expect(tools.get("bare")).not.toHaveProperty("annotations");
    expect(tools.get("bare")).not.toHaveProperty("inputSchema");
  });

  it("keeps excluded tools off WebMCP but still mirrors a tool it has never heard of", async () => {
    const { context, names } = fakeContext();
    const swap: WidgetTool = { name: "swap-pattern", description: "Swap on a bar.", inputSchema: { type: "object", properties: {} } };
    const { bridge } = fakeBridge([getTool, reviewTool, { name: "suggest-edit" }, swap]);
    const relay = createWidgetToolRelay({ bridge, modelContext: context, exclude: ["explain-selection", "suggest-edit"] })!;
    await relay.refresh();
    expect(names()).toEqual(["get-studio-state", "swap-pattern"]);
  });

  it("follows pagination", async () => {
    const { context, names } = fakeContext();
    const pages: Record<string, { tools: WidgetTool[]; nextCursor?: string }> = {
      "": { tools: [getTool], nextCursor: "p2" },
      p2: { tools: [setTool] },
    };
    const listTools = vi.fn(async (params: { cursor?: string }) => pages[params.cursor ?? ""]);
    const relay = createWidgetToolRelay({ bridge: { listTools, callTool: vi.fn() }, modelContext: context })!;
    await relay.refresh();
    expect(names()).toEqual(["get-studio-state", "set-pattern"]);
    expect(listTools).toHaveBeenCalledTimes(2);
  });

  describe("forwarding calls", () => {
    it("sends the name, the input and the cancel signal through the bridge and returns structuredContent", async () => {
      const { context, run } = fakeContext();
      const state = { instanceId: "i-1", revision: 4, playback: "stopped" };
      const { bridge, callTool } = fakeBridge([getTool], { "get-studio-state": { content: [{ type: "text", text: JSON.stringify(state) }], structuredContent: state } });
      await createWidgetToolRelay({ bridge, modelContext: context, callTimeoutMs: 1234 })!.refresh();
      const controller = new AbortController();
      expect(await run("get-studio-state", { instanceId: "i-1" }, controller.signal)).toEqual(state);
      expect(callTool).toHaveBeenCalledWith({ name: "get-studio-state", arguments: { instanceId: "i-1" } }, { signal: controller.signal, timeout: 1234 });
    });

    it("returns the text when there is no structuredContent, and the blocks when they are not all text", async () => {
      const { context, run } = fakeContext();
      const image = { type: "image", data: "AAAA" } as unknown as { type: string; text?: string };
      const { bridge } = fakeBridge([getTool, setTool, { name: "pic" }], {
        "get-studio-state": { content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] },
        "set-pattern": { content: [{ type: "text", text: "see" }, image] },
        pic: { content: [] },
      });
      await createWidgetToolRelay({ bridge, modelContext: context })!.refresh();
      expect(await run("get-studio-state")).toBe("one\ntwo");
      expect(await run("set-pattern")).toEqual([{ type: "text", text: "see" }, image]);
      expect(await run("pic")).toBe("");
    });

    it("hands a failed edit back as a readable result with the widget's state, by default", async () => {
      const { context, run } = fakeContext();
      const state = { instanceId: "i-1", revision: 5, error: "Stale revision 3; read get-studio-state first." };
      const { bridge } = fakeBridge([setTool], { "set-pattern": { isError: true, content: [{ type: "text", text: JSON.stringify(state) }], structuredContent: state } });
      await createWidgetToolRelay({ bridge, modelContext: context })!.refresh();
      expect(await run("set-pattern", { code: "x", expectedRevision: 3 })).toEqual({ isError: true, error: state.error, structuredContent: state });
    });

    it("hands a state-less failure back as its text", async () => {
      const { context, run } = fakeContext();
      const { bridge } = fakeBridge([setTool], { "set-pattern": { isError: true, content: [{ type: "text", text: "Error: Invalid input for tool set-pattern: code: Required" }] } });
      await createWidgetToolRelay({ bridge, modelContext: context })!.refresh();
      expect(await run("set-pattern", {})).toEqual({ isError: true, error: "Error: Invalid input for tool set-pattern: code: Required" });
    });

    it("turns a rejected bridge call (unknown tool, timeout) into a readable result and reports it", async () => {
      const { context, run } = fakeContext();
      const onError = vi.fn();
      const { bridge } = fakeBridge([setTool]); // listed, but the widget no longer answers it
      await createWidgetToolRelay({ bridge, modelContext: context, onError })!.refresh();
      expect(await run("set-pattern", {})).toEqual({ isError: true, error: "Tool set-pattern not found" });
      expect(onError).toHaveBeenCalledWith(expect.any(Error), "set-pattern");
    });

    it("rejects instead when asked to follow the spec's error path", async () => {
      const { context, run } = fakeContext();
      const state = { revision: 5, error: "Stale revision" };
      const { bridge } = fakeBridge([setTool, getTool], {
        "set-pattern": { isError: true, content: [{ type: "text", text: JSON.stringify(state) }], structuredContent: state },
      });
      await createWidgetToolRelay({ bridge, modelContext: context, errors: "throw" })!.refresh();
      await expect(run("set-pattern", {})).rejects.toThrow("Stale revision");
      await expect(run("get-studio-state", {})).rejects.toThrow("not found");
    });

    it("rethrows a cancelled call instead of answering nobody", async () => {
      const { context, run } = fakeContext();
      const controller = new AbortController();
      const callTool = vi.fn(async () => { controller.abort(); throw new DOMException("aborted", "AbortError"); });
      await createWidgetToolRelay({ bridge: { listTools: async () => ({ tools: [setTool] }), callTool }, modelContext: context })!.refresh();
      await expect(run("set-pattern", {}, controller.signal)).rejects.toThrow("aborted");
    });
  });

  describe("staying in sync", () => {
    it("registers a tool the widget adds, unregisters one it drops, and re-registers one that changed", async () => {
      const { context, registerTool, names, tools } = fakeContext();
      const { bridge, state } = fakeBridge([getTool, setTool]);
      const relay = createWidgetToolRelay({ bridge, modelContext: context })!;
      await relay.refresh();
      const before = tools.get("get-studio-state")!;
      expect(registerTool).toHaveBeenCalledTimes(2);

      const swap: WidgetTool = { name: "swap-pattern", description: "Swap on a bar." };
      state.tools = [getTool, { ...setTool, description: "Replaced description." }, swap];
      await relay.refresh();
      expect(names()).toEqual(["get-studio-state", "set-pattern", "swap-pattern"]);
      expect(tools.get("get-studio-state")).toBe(before); // unchanged: left alone
      expect(tools.get("set-pattern")!.description).toBe("Replaced description.");
      expect(registerTool).toHaveBeenCalledTimes(4);

      state.tools = [swap];
      await relay.refresh();
      expect(names()).toEqual(["swap-pattern"]);
      expect(relay.tools()).toEqual(["swap-pattern"]);
    });

    it("coalesces refreshes requested while one is running, and still ends on the latest listing", async () => {
      const { context, names } = fakeContext();
      const { bridge, state, listTools } = fakeBridge([getTool]);
      const relay = createWidgetToolRelay({ bridge, modelContext: context })!;
      const first = relay.refresh();
      state.tools = [getTool, setTool];
      const second = relay.refresh();
      const third = relay.refresh();
      await Promise.all([first, second, third]);
      expect(names()).toEqual(["get-studio-state", "set-pattern"]);
      expect(listTools.mock.calls.length).toBeLessThanOrEqual(2);
    });

    it("reports a tool the browser refuses and still registers the rest", async () => {
      const { context, names, registerTool } = fakeContext();
      const real = registerTool.getMockImplementation()!;
      registerTool.mockImplementation(async (tool, options) => {
        if (tool.name === "set-pattern") throw Object.assign(new Error("Invalid tool name"), { name: "TypeError" });
        return real(tool, options);
      });
      const onError = vi.fn();
      const { bridge } = fakeBridge([setTool, getTool]);
      const relay = createWidgetToolRelay({ bridge, modelContext: context, onError })!;
      await relay.refresh();
      expect(names()).toEqual(["get-studio-state"]);
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Invalid tool name" }), "set-pattern");
    });

    it("reports a name the page already owns without disturbing its tool", async () => {
      const { context, tools } = fakeContext();
      const own = { name: "get-studio-state", description: "the page's own", execute: async () => "own" } as WebMcpTool;
      await context.registerTool(own);
      const onError = vi.fn();
      const { bridge } = fakeBridge([getTool, setTool]);
      await createWidgetToolRelay({ bridge, modelContext: context, onError })!.refresh();
      expect(tools.get("get-studio-state")).toBe(own);
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ name: "InvalidStateError" }), "get-studio-state");
      expect(tools.has("set-pattern")).toBe(true);
    });

    it("keeps what it has when listing fails, and recovers on the next refresh", async () => {
      const { context, names } = fakeContext();
      const { bridge, listTools } = fakeBridge([getTool]);
      const relay = createWidgetToolRelay({ bridge, modelContext: context })!;
      await relay.refresh();
      listTools.mockRejectedValueOnce(new Error("widget busy"));
      await expect(relay.refresh()).rejects.toThrow("widget busy");
      expect(names()).toEqual(["get-studio-state"]);
      await relay.refresh();
      expect(names()).toEqual(["get-studio-state"]);
    });
  });

  describe("teardown", () => {
    it("unregisters everything on dispose and ignores later refreshes", async () => {
      const { context, names } = fakeContext();
      const { bridge, listTools } = fakeBridge([getTool, setTool]);
      const relay = createWidgetToolRelay({ bridge, modelContext: context })!;
      await relay.refresh();
      relay.dispose();
      expect(names()).toEqual([]);
      expect(relay.tools()).toEqual([]);
      listTools.mockClear();
      await relay.refresh();
      expect(listTools).not.toHaveBeenCalled();
    });

    it("leaves nothing behind when disposed while its tools were still being listed or registered", async () => {
      const { context, names } = fakeContext();
      const gate = Promise.withResolvers<void>();
      const listTools = vi.fn(async () => { await gate.promise; return { tools: [getTool, setTool] }; });
      const relay = createWidgetToolRelay({ bridge: { listTools, callTool: vi.fn() }, modelContext: context })!;
      const pending = relay.refresh();
      relay.dispose();
      gate.resolve();
      await pending;
      expect(names()).toEqual([]);

      const slow = fakeContext();
      const open = Promise.withResolvers<void>();
      const registerTool = slow.registerTool.getMockImplementation()!;
      slow.registerTool.mockImplementation(async (tool, options) => { await open.promise; return registerTool(tool, options); });
      const second = createWidgetToolRelay({ bridge: fakeBridge([getTool]).bridge, modelContext: slow.context })!;
      const inFlight = second.refresh();
      await Promise.resolve();
      second.dispose();
      open.resolve();
      await inFlight;
      expect(slow.names()).toEqual([]);
    });
  });
});

describe("registerWebMcpTool", () => {
  const tool: WebMcpTool = { name: "t", description: "d", execute: async () => 1 };

  it("unregisters through the abort signal, once", async () => {
    const { context, tools } = fakeContext();
    const remove = await registerWebMcpTool(context, tool);
    expect(tools.has("t")).toBe(true);
    remove();
    remove();
    expect(tools.has("t")).toBe(false);
  });

  it("also uses the handle and unregisterTool(name) that earlier previews offered, and survives them throwing", async () => {
    const unregister = vi.fn(() => { throw new Error("gone"); });
    const unregisterTool = vi.fn(() => { throw new Error("gone"); });
    const context: WebMcpContext = { registerTool: vi.fn(async () => ({ unregister })), unregisterTool };
    const remove = await registerWebMcpTool(context, tool);
    expect(() => remove()).not.toThrow();
    expect(unregister).toHaveBeenCalledOnce();
    expect(unregisterTool).toHaveBeenCalledWith("t");
  });

  it("copes with a registerTool that returns nothing and a context without unregisterTool", async () => {
    const context: WebMcpContext = { registerTool: vi.fn(() => undefined) };
    const remove = await registerWebMcpTool(context, tool);
    expect(() => remove()).not.toThrow();
  });
});

describe("toWebMcpValue", () => {
  it("prefers structuredContent over its own text rendering", () => {
    expect(toWebMcpValue({ content: [{ type: "text", text: '{"a":1}' }], structuredContent: { a: 1 } })).toEqual({ a: 1 });
  });
  it("names an error from the structured state's `error`, else from the text, else generically", () => {
    expect(toWebMcpValue({ isError: true, content: [{ type: "text", text: "{}" }], structuredContent: { error: "boom" } })).toMatchObject({ isError: true, error: "boom" });
    expect(toWebMcpValue({ isError: true, content: [{ type: "text", text: "plain" }] })).toEqual({ isError: true, error: "plain" });
    expect(toWebMcpValue({ isError: true })).toEqual({ isError: true, error: "The tool reported an error." });
  });
});

// The real thing, end to end: the widget's own tools over a real App/AppBridge
// pair, through the relay, onto a spec-shaped WebMCP context.
describe("relaying the real studio app tools over App/AppBridge", () => {
  const cleanup: Array<() => Promise<unknown> | unknown> = [];
  afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });

  async function mounted() {
    const snapshot: StudioSnapshot = { args: { code: 's("bd")', title: "First" }, playback: "stopped", status: "Ready", error: null };
    const play = vi.fn(async () => { snapshot.playback = "playing"; });
    const session = createStudioSession({
      read: () => structuredClone(snapshot),
      apply: async (args) => { snapshot.args = args; snapshot.playback = "stopped"; },
      play,
      stop: () => { snapshot.playback = "stopped"; },
    }, { mode: "live", schemas: liveStudioSchemas });
    const app = new App({ name: "Test widget", version: "1" }, { tools: { listChanged: true } }, { autoResize: false });
    registerStudioAppTools(app, session);
    const bridge = new AppBridge(null, { name: "Test host", version: "1" }, {});
    const [hostTransport, appTransport] = InMemoryTransport.createLinkedPair();
    await bridge.connect(hostTransport);
    await app.connect(appTransport);
    cleanup.push(async () => { session.dispose(); await app.close(); await bridge.close(); });
    return { app, bridge, play, snapshot };
  }

  it("lists the widget's tools minus the review pair, then plays by the widget's own rules", async () => {
    const { bridge, play } = await mounted();
    const web = fakeContext();
    const relay = createWidgetToolRelay({ bridge, modelContext: web.context, exclude: ["explain-selection", "suggest-edit"], descriptionSuffix: "This controls the music player on this page." })!;
    cleanup.push(() => relay.dispose());
    await relay.refresh();
    expect(web.names()).toEqual(["get-studio-state", "play-current-music", "set-pattern", "stop-music", "swap-pattern", "undo-studio-edit"]);
    expect(web.tools.get("set-pattern")!.description).toMatch(/Replace this widget's Strudel source[\s\S]*\nThis controls the music player on this page\.$/);
    expect((web.tools.get("set-pattern")!.inputSchema as { properties: Record<string, unknown> }).properties).toHaveProperty("expectedRevision");

    const state = await web.run("get-studio-state", {}) as StudioState;
    expect(state).toMatchObject({ mode: "live", revision: expect.any(Number), playback: "stopped" });
    const stale = await web.run("set-pattern", { instanceId: state.instanceId, expectedRevision: state.revision + 7, code: 's("cp")' });
    expect(stale).toMatchObject({ isError: true, error: expect.stringContaining("Revision conflict") });
    const set = await web.run("set-pattern", { instanceId: state.instanceId, expectedRevision: state.revision, code: 's("cp*2")' }) as StudioState;
    expect(set.args.code).toBe('s("cp*2")');
    expect(set.revision).toBeGreaterThan(state.revision);
    expect(play).not.toHaveBeenCalled();
    const played = await web.run("play-current-music", { instanceId: state.instanceId, expectedRevision: set.revision }) as StudioState;
    expect(played.playback).toBe("playing");
    const invalid = await web.run("set-pattern", { code: 'x' });
    expect(invalid).toMatchObject({ isError: true, error: expect.stringContaining("Invalid input") });
  });

  it("mirrors a tool the widget registers after it initialised, on its tools/list_changed", async () => {
    const { app, bridge } = await mounted();
    const web = fakeContext();
    const relay = createWidgetToolRelay({ bridge, modelContext: web.context })!;
    cleanup.push(() => relay.dispose());
    const changed = vi.fn(() => void relay.refresh());
    bridge.setNotificationHandler("notifications/tools/list_changed", changed);
    await relay.refresh();
    expect(web.names()).not.toContain("late-tool");

    const swap = app.registerTool("late-tool", {
      description: "A tool registered after the widget initialised.",
      inputSchema: z.object({ code: z.string() }).strict(),
    }, async ({ code }) => ({ content: [{ type: "text" as const, text: `late ${code}` }] }));
    await vi.waitFor(() => expect(web.names()).toContain("late-tool"));
    expect(changed).toHaveBeenCalled();
    expect(await web.run("late-tool", { code: "x" })).toBe("late x");

    swap.remove();
    await vi.waitFor(() => expect(web.names()).not.toContain("late-tool"));
  });
});

describe("a score share page relays the sheet widget's studio tools", () => {
  const SCORE_TOOLS = [
    "explain-selection", "get-studio-state", "play-current-music", "set-score", "stop-music", "suggest-edit", "undo-studio-edit",
  ];

  it("lists the 7 score studio tools; the share policy offers them minus the review pair, play after a press", async () => {
    const snapshot: StudioSnapshot = { args: { abcNotation: "X:1\nK:C\nCDEF|" }, playback: "stopped", status: "Click ▶ to play", error: null, playPressed: false };
    const play = vi.fn(async () => { snapshot.playback = "playing"; });
    const session = createStudioSession({
      read: () => structuredClone(snapshot),
      apply: async (args) => { snapshot.args = args; },
      play,
      stop: () => { snapshot.playback = "stopped"; },
    }, { mode: "score", schemas: scoreStudioSchemas });
    const app = new App({ name: "Sheet widget", version: "1" }, { tools: { listChanged: true } }, { autoResize: false });
    registerStudioAppTools(app, session);
    const bridge = new AppBridge(null, { name: "Share page", version: "1" }, {});
    const [hostTransport, appTransport] = InMemoryTransport.createLinkedPair();
    await bridge.connect(hostTransport);
    await app.connect(appTransport);
    try {
      // Parity: what the widget lists is exactly the score studio set.
      expect((await bridge.listTools({})).tools.map((t) => t.name).sort()).toEqual(SCORE_TOOLS);

      let pressed = false;
      const web = fakeContext();
      const relay = createWidgetToolRelay({
        bridge, modelContext: web.context, exclude: shareRelayExclude(() => pressed), annotate: shareRelayAnnotations,
      })!;
      await relay.refresh();
      expect(web.names()).toEqual(["get-studio-state", "set-score", "stop-music", "undo-studio-edit"]);
      for (const name of web.names()) expect(web.tools.get(name)!.annotations).toMatchObject({ untrustedContentHint: true });

      // The page reads the widget's playPressed after its "play-pressed" log.
      snapshot.playPressed = true;
      const state = await web.run("get-studio-state", {}) as StudioState;
      expect(state.playPressed).toBe(true);
      pressed = true;
      await relay.refresh();
      expect(web.names()).toEqual(["get-studio-state", "play-current-music", "set-score", "stop-music", "undo-studio-edit"]);
      expect(SCORE_TOOLS.filter((n) => !shareRelayExclude(() => true)(n))).toEqual(web.names());
      const played = await web.run("play-current-music", { instanceId: state.instanceId, expectedRevision: state.revision }) as StudioState;
      expect(played.playback).toBe("playing");
      relay.dispose();
    } finally {
      session.dispose();
      await app.close();
      await bridge.close();
    }
  });
});

describe("review fixes (0.10 gauntlet)", () => {
  it("F8: a registerTool that never settles is abandoned after the ceiling, and a later sync still registers the rest", async () => {
    const ctx = fakeContext();
    let hang = true;
    ctx.registerTool.mockImplementation(async (tool: WebMcpTool, options?: { signal?: AbortSignal }) => {
      if (tool.name === "get-studio-state" && hang) return new Promise<void>(() => {});
      ctx.tools.set(tool.name, tool);
      options?.signal?.addEventListener("abort", () => ctx.tools.delete(tool.name));
    });
    await expect(registerWebMcpTool(ctx.context, { name: "get-studio-state", description: "x", execute: async () => null }, 20))
      .rejects.toThrow("did not settle within 20 ms");
    hang = false;
    const remove = await registerWebMcpTool(ctx.context, { name: "get-studio-state", description: "x", execute: async () => null }, 20);
    expect(ctx.names()).toEqual(["get-studio-state"]);
    remove();
  });

  it("R3: a registration that settles AFTER the ceiling is withdrawn at once (handle and unregisterTool)", async () => {
    let finish!: (handle: unknown) => void;
    const registered = new Set<string>();
    const handle = { unregister: vi.fn(() => registered.delete("late")) };
    const unregisterTool = vi.fn((name: string) => registered.delete(name));
    const context: WebMcpContext = {
      // A provider that ignores the abort signal and hands back a handle later.
      registerTool: vi.fn((tool: WebMcpTool) => new Promise((resolve) => { finish = (h) => { registered.add(tool.name); resolve(h); }; })),
      unregisterTool,
    };
    await expect(registerWebMcpTool(context, { name: "late", description: "x", execute: async () => null }, 15)).rejects.toThrow("did not settle");
    unregisterTool.mockClear();
    finish(handle);
    await vi.waitFor(() => expect(handle.unregister).toHaveBeenCalled());
    expect(unregisterTool).toHaveBeenCalledWith("late");
    expect(registered.has("late")).toBe(false);
  });

  it("a late settle never withdraws a NEWER registration of the same name (Codex review)", async () => {
    let finishA!: () => void;
    const installed = new Map<string, number>();
    let n = 0;
    const context: WebMcpContext = {
      registerTool: vi.fn((tool: WebMcpTool) => {
        const id = ++n;
        if (id === 1) return new Promise<void>((resolve) => { finishA = () => { installed.set(tool.name, id); resolve(); }; });
        installed.set(tool.name, id);
        return Promise.resolve();
      }),
      unregisterTool: vi.fn((name: string) => void installed.delete(name)),
    };
    const tool = { name: "play-current-music", description: "x", execute: async () => null };
    await expect(registerWebMcpTool(context, tool, 15)).rejects.toThrow("did not settle");
    await registerWebMcpTool(context, tool, 15); // B owns the name now
    expect(installed.get("play-current-music")).toBe(2);
    (context.unregisterTool as ReturnType<typeof vi.fn>).mockClear();
    finishA(); // A settles late: it may not withdraw the name B owns
    await new Promise((r) => setTimeout(r, 10));
    expect(context.unregisterTool).not.toHaveBeenCalled();
  });

  it("F5: a function exclude is asked on every sync, so a tool can open later", async () => {
    const ctx = fakeContext();
    const { bridge } = fakeBridge([getTool, setTool]);
    let open = false;
    const relay = createWidgetToolRelay({ bridge, modelContext: ctx.context, exclude: (name) => name === "set-pattern" && !open })!;
    await relay.refresh();
    expect(ctx.names()).toEqual(["get-studio-state"]);
    open = true;
    await relay.refresh();
    expect(ctx.names()).toEqual(["get-studio-state", "set-pattern"]);
  });

  it("F1 + F5: the share page's policy — every tool is untrusted content; play/swap only after a press of Play", () => {
    expect(shareRelayAnnotations()).toEqual({ untrustedContentHint: true });
    let played = false;
    const exclude = shareRelayExclude(() => played);
    const offered = (names: string[]) => names.filter((n) => !exclude(n));
    const all = ["get-studio-state", "set-pattern", "play-current-music", "stop-music", "undo-studio-edit", "swap-pattern", "explain-selection", "suggest-edit"];
    expect(offered(all)).toEqual(["get-studio-state", "set-pattern", "stop-music", "undo-studio-edit"]);
    played = true;
    expect(offered(all)).toEqual(["get-studio-state", "set-pattern", "play-current-music", "stop-music", "undo-studio-edit", "swap-pattern"]);
    expect(RELAY_AFTER_PLAY_PRESS).toEqual(["play-current-music", "swap-pattern"]);
  });

  it("F1: with the share policy, write tools carry untrustedContentHint too", async () => {
    const ctx = fakeContext();
    const { bridge } = fakeBridge([getTool, setTool]);
    const relay = createWidgetToolRelay({ bridge, modelContext: ctx.context, annotate: shareRelayAnnotations })!;
    await relay.refresh();
    expect(ctx.tools.get("set-pattern")!.annotations).toMatchObject({ untrustedContentHint: true, destructiveHint: false });
    expect(ctx.tools.get("get-studio-state")!.annotations).toMatchObject({ untrustedContentHint: true, readOnlyHint: true });
  });
});
