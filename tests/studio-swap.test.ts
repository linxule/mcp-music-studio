import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "@modelcontextprotocol/ext-apps";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerStudioAppTools } from "../src/studio-app-tools";
import {
  createStudioSession, STUDIO_SWAP_DEFAULT_QUANTIZE, type StudioSnapshot, type StudioState, type StudioSwapOutcome,
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
async function liveWidget(playback = "playing") {
  const state: StudioSnapshot = { args: { code: 's("bd*4")', title: "First" }, playback, status: "Playing", error: null };
  const waiting: Array<{ resolve: (o: StudioSwapOutcome) => void; isCancelled: () => boolean; quantize: number }> = [];
  const swap = vi.fn((code: string, quantize: number, isCancelled: () => boolean) => {
    if (state.playback !== "playing") return Promise.reject(new Error("The player is stopped: swap-pattern changes a PLAYING pattern on the bar. Use set-pattern, then play-current-music."));
    state.args = { ...state.args, code };
    return new Promise<StudioSwapOutcome>((resolve) => waiting.push({ resolve, isCancelled, quantize }));
  });
  const apply = vi.fn(async (args: Record<string, unknown>) => {
    state.args = args;
    state.playback = "stopped";
  });
  const stop = vi.fn(() => {
    state.playback = "stopped";
  });
  const session = createStudioSession(
    { read: () => structuredClone(state), apply, play: vi.fn(async () => void (state.playback = "playing")), stop, swap },
    { mode: "live" },
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
    next.resolve(next.isCancelled() ? { ok: false, cycle: null, error: "superseded by a newer studio action before it played" } : { ok: true, cycle });
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
    expect((old.structuredContent as any).swap).toMatchObject({ ok: false, error: expect.stringContaining("superseded") });
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
    w.swap.mockImplementationOnce(async (code: string) => {
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

  it("is not offered by score widgets", async () => {
    const session = createStudioSession(
      {
        read: () => ({ args: { abcNotation: "X:1\nK:C\nC" }, playback: "stopped", status: "", error: null }),
        apply: async () => {},
        play: async () => {},
        stop: () => {},
      },
      { mode: "score" },
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
