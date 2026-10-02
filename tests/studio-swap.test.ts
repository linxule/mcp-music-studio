import { liveStudioSchemas, scoreStudioSchemas } from "../src/studio-schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "@modelcontextprotocol/ext-apps";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerStudioAppTools } from "../src/studio-app-tools";
import {
  createStudioSession, STUDIO_SWAP_DEFAULT_QUANTIZE, type StudioSnapshot, type StudioState, type StudioSwapHooks,
  type StudioSwapOutcome,
} from "../src/studio-session";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

/**
 * A fake live widget whose swap behaves like quantizedSwap: the code goes into
 * the editor at once, and the call resolves when its "bar" comes (release()),
 * when it is cancelled, or when the player stops.
 */
async function liveWidget(playback = "playing", swapAnswerMs = 10_000) {
  const state: StudioSnapshot = { args: { code: 's("bd*4")', title: "First" }, playback, status: "Playing", error: null };
  const waiting: Array<{ resolve: (o: StudioSwapOutcome) => void; reject: (e: Error) => void; isCancelled: () => boolean; quantize: number }> = [];
  const swap = vi.fn((code: string, quantize: number, isCancelled: () => boolean, hooks?: StudioSwapHooks) => {
    if (state.playback !== "playing") return Promise.reject(new Error("The player is stopped: swap-pattern changes a PLAYING pattern on the bar. Use set-pattern, then play-current-music."));
    // As quantizedSwap: undo target first, then the code goes into the editor, then the bar is known.
    hooks?.beforeLoad?.();
    state.args = { ...state.args, code };
    hooks?.onQueued?.(8, 6);
    return new Promise<StudioSwapOutcome>((resolve, reject) => waiting.push({ resolve, reject, isCancelled, quantize }));
  });
  const apply = vi.fn(async (args: Record<string, unknown>, _settings?: unknown, _isCancelled?: unknown, onCommit?: () => void) => {
    state.args = args;
    state.playback = "stopped";
    onCommit?.();
  });
  const stop = vi.fn(() => {
    state.playback = "stopped";
  });
  const session = createStudioSession(
    { read: () => structuredClone(state), apply, play: vi.fn(async () => void (state.playback = "playing")), stop, swap },
    { mode: "live", schemas: liveStudioSchemas, swapAnswerMs },
  );
  const app = new App({ name: "Test widget", version: "1" }, { tools: { listChanged: true } }, { autoResize: false });
  registerStudioAppTools(app, session);
  const host = new AppBridge(null, { name: "Test host", version: "1" }, {});
  const [hostTransport, appTransport] = InMemoryTransport.createLinkedPair();
  await host.connect(hostTransport);
  await app.connect(appTransport);
  cleanup.push(async () => {
    session.dispose();
    await app.close();
    await host.close();
  });
  const read = async () =>
    (await host.callTool({ name: "get-studio-state", arguments: {} })).structuredContent as unknown as StudioState;
  const call = (args: Record<string, unknown>) => host.callTool({ name: "swap-pattern", arguments: args });
  /** Let the oldest waiting swap reach its bar (or notice it was cancelled). */
  const release = (cycle = 8) => {
    const next = waiting.shift()!;
    next.resolve(next.isCancelled() ? { ok: false, cycle: null, error: "replaced before it played by a newer edit, swap, play, undo or stop" } : { ok: true, cycle });
  };
  return { state, session, host, read, call, release, waiting, swap, apply, stop };
}

describe("swap-pattern (bar-quantized swap through the studio controller)", () => {
  it("is listed for live widgets, swaps on the bar, bumps the revision and answers with the cycle", async () => {
    const w = await liveWidget();
    expect((await w.host.listTools({})).tools.map((t) => t.name)).toContain("swap-pattern");
    const before = await w.read();
    const pending = w.call({ instanceId: before.instanceId, expectedRevision: before.revision, code: 's("hh*8")', quantize: 8 });
    await vi.waitFor(() => expect(w.waiting).toHaveLength(1));
    expect(w.waiting[0].quantize).toBe(8);
    w.release(16);
    const result = await pending;
    expect(result.isError).toBeUndefined();
    const state = result.structuredContent as unknown as StudioState;
    expect(state.swap).toEqual({ ok: true, cycle: 16, quantize: 8 });
    expect(state.args.code).toBe('s("hh*8")');
    expect(state.revision).toBe(before.revision + 1);
    expect(state.canUndo).toBe(true);
  });

  it("defaults quantize to one 4-cycle phrase", async () => {
    const w = await liveWidget();
    const s = await w.read();
    const pending = w.call({ instanceId: s.instanceId, expectedRevision: s.revision, code: 's("cp")' });
    await vi.waitFor(() => expect(w.waiting).toHaveLength(1));
    expect(w.waiting[0].quantize).toBe(STUDIO_SWAP_DEFAULT_QUANTIZE);
    w.release();
    await pending;
  });

  it("changes nothing on a stopped player and says to use set-pattern + play", async () => {
    const w = await liveWidget("stopped");
    const s = await w.read();
    const result = await w.call({ instanceId: s.instanceId, expectedRevision: s.revision, code: 's("cp")' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("set-pattern");
    const after = await w.read();
    expect(after.revision).toBe(s.revision);
    expect(after.canUndo).toBe(false);
  });

  it("rejects a stale revision or another widget's id without swapping", async () => {
    const w = await liveWidget();
    const s = await w.read();
    const stale = await w.call({ instanceId: s.instanceId, expectedRevision: s.revision + 3, code: 's("cp")' });
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale.content)).toContain("Revision conflict");
    const wrong = await w.call({ instanceId: "someone-else", expectedRevision: s.revision, code: 's("cp")' });
    expect(wrong.isError).toBe(true);
    expect(w.swap).not.toHaveBeenCalled();
  });

  it("a newer swap supersedes a waiting one, which answers instead of hanging", async () => {
    const w = await liveWidget();
    const s = await w.read();
    const first = w.call({ instanceId: s.instanceId, expectedRevision: s.revision, code: 's("one")' });
    await vi.waitFor(() => expect(w.waiting).toHaveLength(1));
    const mid = await w.read();
    expect(mid.revision).toBe(s.revision + 1); // the editor already shows the queued code
    const second = w.call({ instanceId: s.instanceId, expectedRevision: mid.revision, code: 's("two")' });
    await vi.waitFor(() => expect(w.waiting).toHaveLength(2));
    w.release();
    const old = await first;
    expect(old.isError).toBe(true);
    expect((old.structuredContent as any).swap).toMatchObject({ ok: false, error: expect.stringContaining("replaced") });
    w.release(12);
    const fresh = (await second).structuredContent as unknown as StudioState;
    expect(fresh.swap).toMatchObject({ ok: true, cycle: 12 });
    expect(fresh.args.code).toBe('s("two")');
  });

  it("stop during the wait cancels it; undo restores the source before the swap, stopped", async () => {
    const w = await liveWidget();
    const s = await w.read();
    const pending = w.call({ instanceId: s.instanceId, expectedRevision: s.revision, code: 's("one")' });
    await vi.waitFor(() => expect(w.waiting).toHaveLength(1));
    await w.host.callTool({ name: "stop-music", arguments: { instanceId: s.instanceId } });
    w.release();
    const answer = await pending;
    expect((answer.structuredContent as any).swap).toMatchObject({ ok: false });
    const now = await w.read();
    expect(now.canUndo).toBe(true);
    const undone = await w.host.callTool({ name: "undo-studio-edit", arguments: { instanceId: s.instanceId, expectedRevision: now.revision } });
    expect(undone.isError).toBeUndefined();
    expect(w.apply).toHaveBeenLastCalledWith(s.args, undefined);
    expect((await w.read()).args.code).toBe('s("bd*4")');
    expect(w.state.playback).toBe("stopped");
  });

  it("a swap that fails to play keeps its state, reports the error and stays undoable", async () => {
    const w = await liveWidget();
    w.swap.mockImplementationOnce(async (code: string, _q: number, _c: () => boolean, hooks?: StudioSwapHooks) => {
      hooks?.beforeLoad?.();
      w.state.args = { ...w.state.args, code };
      return { ok: false, cycle: null, error: "Unexpected token (1:3)" };
    });
    const s = await w.read();
    const result = await w.call({ instanceId: s.instanceId, expectedRevision: s.revision, code: "s((" });
    expect(result.isError).toBe(true);
    const state = result.structuredContent as unknown as StudioState;
    expect(state.error).toBe("Unexpected token (1:3)");
    expect(state.canUndo).toBe(true);
  });

  it("Codex's sequence: A → pending swap B → set C → B finishes: undo gives B's draft, then A", async () => {
    const w = await liveWidget();
    const a = await w.read();
    const swapB = w.call({ instanceId: a.instanceId, expectedRevision: a.revision, code: 's("B")' });
    await vi.waitFor(() => expect(w.waiting).toHaveLength(1));
    const mid = await w.read();
    const setC = await w.host.callTool({ name: "set-pattern", arguments: { instanceId: a.instanceId, expectedRevision: mid.revision, code: 's("C")' } });
    expect(setC.isError).toBeUndefined();
    w.release(); // B reaches its bar after C replaced it
    const b = await swapB;
    expect(b.isError).toBe(true);
    expect((b.structuredContent as any).swap).toMatchObject({ ok: false, error: expect.stringContaining("replaced") });
    let s = await w.read();
    expect(s.args.code).toBe('s("C")');
    await w.host.callTool({ name: "undo-studio-edit", arguments: { instanceId: a.instanceId, expectedRevision: s.revision } });
    s = await w.read();
    expect(s.args.code).toBe('s("B")');
    await w.host.callTool({ name: "undo-studio-edit", arguments: { instanceId: a.instanceId, expectedRevision: s.revision } });
    s = await w.read();
    expect(s.args.code).toBe('s("bd*4")');
    expect(s.canUndo).toBe(false);
  });

  it.each([
    ["set-pattern", (id: string, rev: number) => ({ instanceId: id, expectedRevision: rev, code: 's("X")' })],
    ["undo-studio-edit", (id: string, rev: number) => ({ instanceId: id, expectedRevision: rev })],
    ["play-current-music", (id: string, rev: number) => ({ instanceId: id, expectedRevision: rev })],
    ["stop-music", (id: string) => ({ instanceId: id })],
  ] as const)("Kimi: %s cancels a pending swap, which answers 'replaced'", async (tool, args) => {
    const w = await liveWidget();
    const a = await w.read();
    const pending = w.call({ instanceId: a.instanceId, expectedRevision: a.revision, code: 's("B")' });
    await vi.waitFor(() => expect(w.waiting).toHaveLength(1));
    const mid = await w.read();
    const other = await w.host.callTool({ name: tool, arguments: args(a.instanceId, mid.revision) });
    expect(other.isError).toBeUndefined();
    w.release();
    const answer = await pending;
    expect((answer.structuredContent as any).swap).toMatchObject({ ok: false, error: expect.stringContaining("replaced") });
  });

  it("review-apply cancels a pending swap too", async () => {
    const w = await liveWidget();
    const a = await w.read();
    const pending = w.call({ instanceId: a.instanceId, expectedRevision: a.revision, code: 's("B")' });
    await vi.waitFor(() => expect(w.waiting).toHaveLength(1));
    const mid = await w.read();
    const source = String(mid.args.code);
    const passage = { instanceId: a.instanceId, mode: "live" as const, revision: mid.revision, from: 0, to: source.length, text: source };
    const started = await w.session({ action: "review-start", instanceId: a.instanceId, expectedRevision: mid.revision, question: "?", passage });
    const requestId = started.sharedReview!.requestId;
    await w.session({ action: "review-stage", instanceId: a.instanceId, requestId, passage, explanation: "e", replacement: 's("R")' });
    await w.session({ action: "review-apply", instanceId: a.instanceId, requestId, expectedRevision: mid.revision });
    w.release();
    expect(((await pending).structuredContent as any).swap).toMatchObject({ ok: false });
  });

  it("racing swaps record one undo entry each, in order — none late, none twice", async () => {
    const w = await liveWidget();
    const a = await w.read();
    const one = w.call({ instanceId: a.instanceId, expectedRevision: a.revision, code: 's("one")' });
    await vi.waitFor(() => expect(w.waiting).toHaveLength(1));
    const mid = await w.read();
    const two = w.call({ instanceId: a.instanceId, expectedRevision: mid.revision, code: 's("two")' });
    await vi.waitFor(() => expect(w.waiting).toHaveLength(2));
    w.release();
    w.release(12);
    await Promise.all([one, two]);
    let s = await w.read();
    expect(s.args.code).toBe('s("two")');
    await w.host.callTool({ name: "undo-studio-edit", arguments: { instanceId: a.instanceId, expectedRevision: s.revision } });
    s = await w.read();
    expect(s.args.code).toBe('s("one")');
    await w.host.callTool({ name: "undo-studio-edit", arguments: { instanceId: a.instanceId, expectedRevision: s.revision } });
    s = await w.read();
    expect(s.args.code).toBe('s("bd*4")');
    expect(s.canUndo).toBe(false);
  });

  it("a swap still waiting after the answer window answers 'queued' and stays readable until it lands", async () => {
    const w = await liveWidget("playing", 30);
    const a = await w.read();
    const answer = await w.call({ instanceId: a.instanceId, expectedRevision: a.revision, code: 's("late")', quantize: 32 });
    expect(answer.isError).toBeUndefined();
    const queued = answer.structuredContent as unknown as StudioState;
    expect(queued.swap).toEqual({ queued: true, quantize: 32, boundary: 8, etaSeconds: 6 });
    expect(queued.pendingSwap).toMatchObject({ quantize: 32, boundary: 8, etaSeconds: 6 });
    w.release(32);
    await vi.waitFor(async () => expect((await w.read()).pendingSwap).toBeNull());
    expect((await w.read()).lastSwap).toEqual({ ok: true, cycle: 32, quantize: 32 });
  });

  it("undo never pins the measured runtime tempo as an explicit bpm", async () => {
    const w = await liveWidget();
    w.state.args = { ...w.state.args, bpm: 120 }; // read() reports the measured tempo
    const a = await w.read();
    await w.host.callTool({ name: "set-pattern", arguments: { instanceId: a.instanceId, expectedRevision: a.revision, code: 's("X")' } });
    expect(w.apply.mock.calls[0][0]).not.toHaveProperty("bpm");
    const s = await w.read();
    await w.host.callTool({ name: "undo-studio-edit", arguments: { instanceId: a.instanceId, expectedRevision: s.revision } });
    expect(w.apply.mock.calls[1][0]).not.toHaveProperty("bpm");
    expect(w.apply.mock.calls[1][0]).toMatchObject({ code: 's("bd*4")' });
  });

  it("R2: an older swap's late 'replaced' never overwrites a newer swap's lastSwap", async () => {
    const w = await liveWidget("playing", 20);
    const a = await w.read();
    await w.call({ instanceId: a.instanceId, expectedRevision: a.revision, code: 's("old")', quantize: 32 }); // answers queued
    const mid = await w.read();
    await w.call({ instanceId: a.instanceId, expectedRevision: mid.revision, code: 's("new")', quantize: 4 }); // queued too
    expect(w.waiting).toHaveLength(2);
    const [older, newer] = w.waiting.splice(0, 2);
    newer.resolve({ ok: true, cycle: 12 }); // the newer lands first…
    await vi.waitFor(async () => expect((await w.read()).lastSwap).toMatchObject({ ok: true, cycle: 12 }));
    older.resolve({ ok: false, cycle: null, error: "replaced before it played by a newer edit, swap, play, undo or stop" });
    await new Promise((r) => setTimeout(r, 20));
    expect((await w.read()).lastSwap).toMatchObject({ ok: true, cycle: 12, quantize: 4 });
  });

  it("R2: a queued swap that later REJECTS records a failed lastSwap", async () => {
    const w = await liveWidget("playing", 20);
    const a = await w.read();
    const answer = await w.call({ instanceId: a.instanceId, expectedRevision: a.revision, code: 's("x")', quantize: 32 });
    expect((answer.structuredContent as any).swap).toMatchObject({ queued: true });
    w.waiting.shift()!.reject(new Error("the player could not load Strudel"));
    await vi.waitFor(async () => expect((await w.read()).pendingSwap).toBeNull());
    expect((await w.read()).lastSwap).toMatchObject({ ok: false, cycle: null, error: "the player could not load Strudel", quantize: 32 });
  });

  it("is not offered by score widgets", async () => {
    const session = createStudioSession(
      {
        read: () => ({ args: { abcNotation: "X:1\nK:C\nC" }, playback: "stopped", status: "", error: null }),
        apply: async () => {},
        play: async () => {},
        stop: () => {},
      },
      { mode: "score", schemas: scoreStudioSchemas },
    );
    const app = new App({ name: "Score", version: "1" }, { tools: { listChanged: true } }, { autoResize: false });
    registerStudioAppTools(app, session);
    const host = new AppBridge(null, { name: "Test host", version: "1" }, {});
    const [a, b] = InMemoryTransport.createLinkedPair();
    await host.connect(a);
    await app.connect(b);
    cleanup.push(async () => {
      session.dispose();
      await app.close();
      await host.close();
    });
    expect((await host.listTools({})).tools.map((t) => t.name)).not.toContain("swap-pattern");
    await expect(session({ action: "swap", instanceId: session.instanceId, expectedRevision: 0, args: { code: "x" } })).rejects.toThrow("live");
  });
});
