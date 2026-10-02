import { describe, expect, it, vi } from "vitest";
import { createStudioSession, type StudioCommand, type StudioMode, type StudioSnapshot } from "../src/studio-session";

function studio(code = 's("bd")', mode: StudioMode = "live") {
  const state: StudioSnapshot = { args: { [mode === "live" ? "code" : "abcNotation"]: code }, playback: "stopped", status: "Ready", error: null };
  const apply = vi.fn(async (args: Record<string, unknown>, settings?: Record<string, unknown>) => { state.args = args; state.settings = settings; state.playback = "stopped"; });
  const play = vi.fn(async (_isCancelled: () => boolean) => { state.playback = "playing"; });
  const stop = vi.fn(() => { state.playback = "stopped"; });
  const session = createStudioSession({ read: () => structuredClone(state), apply, play, stop }, { mode });
  const dispatch = (command: StudioCommand) => session({ instanceId: session.instanceId, ...command });
  return { state, apply, play, stop, dispatch, session };
}

describe("local studio sessions", () => {
  it("reads an unevaluated human draft and rejects an agent holding the old revision", async () => {
    const { state, dispatch, apply } = studio();
    expect((await dispatch({ action: "get" })).revision).toBe(0);
    state.args.code = 's("bd hh") // human draft';
    await expect(dispatch({ action: "set", expectedRevision: 0, args: { code: 's("sd")' } })).rejects.toThrow("Revision conflict");
    expect(apply).not.toHaveBeenCalled();
    expect((await dispatch({ action: "get" })).args.code).toContain("human draft");
  });

  it("stages edits without playing and restores the exact pre-edit draft on undo", async () => {
    const { state, dispatch, play } = studio();
    state.args.code = "human draft";
    const current = await dispatch({ action: "get" });
    const changed = await dispatch({ action: "set", expectedRevision: current.revision, args: { code: "agent draft" } });
    expect(changed.args.code).toBe("agent draft");
    expect(changed.canUndo).toBe(true);
    expect(play).not.toHaveBeenCalled();
    const undone = await dispatch({ action: "undo", expectedRevision: changed.revision });
    expect(undone.args.code).toBe("human draft");
    expect(undone.canUndo).toBe(false);
    expect(undone.playback).toBe("stopped");
  });

  it("does not offer an empty initial editor as an undo target", async () => {
    const { dispatch } = studio("");
    const before = await dispatch({ action: "get" });
    const seeded = await dispatch({ action: "set", expectedRevision: before.revision, args: { code: "seed" } });
    expect(seeded.canUndo).toBe(false);
  });

  it("includes human toolbar changes in revisions and restores settings on undo", async () => {
    const { state, dispatch } = studio("score", "score");
    state.settings = { warp: 125, loop: true, room: false };
    const before = await dispatch({ action: "get" });
    expect(before.revision).toBe(1);
    const edited = await dispatch({ action: "set", expectedRevision: 1, args: { abcNotation: "agent edit" } });
    expect(edited.settings).toEqual(state.settings);
    state.settings = { warp: 150, loop: false, room: true };
    const newer = await dispatch({ action: "get" });
    const undone = await dispatch({ action: "undo", expectedRevision: newer.revision });
    expect(undone.settings).toEqual({ warp: 125, loop: true, room: false });
  });

  it("can undo back to a human-cleared empty draft", async () => {
    const { state, dispatch } = studio();
    state.args.code = "";
    const before = await dispatch({ action: "get" });
    const after = await dispatch({ action: "set", expectedRevision: before.revision, args: { code: "agent edit" } });
    expect((await dispatch({ action: "undo", expectedRevision: after.revision })).args.code).toBe("");
  });

  it("reports actual playback errors and does not revise music just because playback changed", async () => {
    const { state, dispatch } = studio();
    await dispatch({ action: "play", expectedRevision: 0 });
    state.playback = "audio-blocked";
    state.error = "Sound load failed";
    const result = await dispatch({ action: "get" });
    expect(result).toMatchObject({ revision: 0, playback: "audio-blocked", error: "Sound load failed" });
  });

  it("keeps stop available while an edit is pending and rejects overlapping mutations", async () => {
    const { dispatch, apply, stop } = studio();
    let finish!: () => void;
    apply.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const edit = dispatch({ action: "set", expectedRevision: 0, args: { code: "pending" } });
    expect((await dispatch({ action: "get" })).busy).toBe(true);
    await expect(dispatch({ action: "play", expectedRevision: 0 })).rejects.toThrow("busy");
    await dispatch({ action: "stop" });
    expect(stop).toHaveBeenCalledOnce();
    finish(); await edit;
    expect((await dispatch({ action: "get" })).busy).toBe(false);
  });

  it("unlocks after a failed edit and retains its recovery snapshot", async () => {
    const { dispatch, apply } = studio();
    apply.mockRejectedValueOnce(new Error("Render failed"));
    await expect(dispatch({ action: "set", expectedRevision: 0, args: { code: "bad" } })).rejects.toThrow("Render failed");
    expect(await dispatch({ action: "get" })).toMatchObject({ busy: false, canUndo: true });
  });

  it("signals an in-flight play when stop arrives, before the play continuation resumes", async () => {
    const { dispatch, play } = studio();
    let resume!: () => void;
    let cancelled!: () => boolean;
    play.mockImplementationOnce(async (isCancelled: () => boolean) => {
      cancelled = isCancelled;
      await new Promise<void>(resolve => { resume = resolve; });
      expect(isCancelled()).toBe(true);
    });
    const pending = dispatch({ action: "play", expectedRevision: 0 });
    expect(cancelled()).toBe(false);
    await dispatch({ action: "stop" });
    expect(cancelled()).toBe(true);
    resume();
    await pending;
  });

  it("keeps an undo target when rendering reports an error without rejecting", async () => {
    const { state, dispatch, apply } = studio("original");
    const changed = await dispatch({ action: "set", expectedRevision: 0, args: { code: "agent" } });
    apply.mockImplementationOnce(async () => { state.error = "Could not restore"; });
    await expect(dispatch({ action: "undo", expectedRevision: changed.revision })).rejects.toThrow("Could not restore");
    expect((await dispatch({ action: "get" })).canUndo).toBe(true);
    state.error = null;
    const restored = await dispatch({ action: "undo", expectedRevision: changed.revision });
    expect(restored.args.code).toBe("original");
    expect(restored.canUndo).toBe(false);
  });

  it("requires identity even for stop and rejects a disposed mount or another widget", async () => {
    const first = studio();
    const second = studio();
    await expect(second.session({ action: "stop", instanceId: first.session.instanceId })).rejects.toThrow("instance conflict");
    await expect(first.session({ action: "stop" })).rejects.toThrow("instance conflict");
    expect(second.stop).not.toHaveBeenCalled();
    first.session.dispose();
    await expect(first.dispatch({ action: "get" })).rejects.toThrow("disposed");
    await expect(second.session({ action: "set", instanceId: first.session.instanceId, expectedRevision: 0, args: { code: "old" } })).rejects.toThrow("instance conflict");
    expect(second.apply).not.toHaveBeenCalled();
  });

  it("rejects malformed direct bridge commands before changing source or history", async () => {
    const { dispatch, apply } = studio();
    await expect(dispatch({ action: "set", expectedRevision: 0, args: { code: "draft", autoplay: true } })).rejects.toThrow();
    await expect(dispatch({ action: "set", expectedRevision: 0, args: { code: "draft" }, settings: { warp: 100 } })).rejects.toThrow();
    await expect(dispatch({ action: "play", expectedRevision: 0.5 })).rejects.toThrow();
    expect(apply).not.toHaveBeenCalled();
    expect((await dispatch({ action: "get" })).canUndo).toBe(false);
  });

  it("replaces omitted source metadata while retaining settings unless explicitly provided", async () => {
    const live = studio();
    live.state.args.theme = "nord";
    const before = await live.dispatch({ action: "get" });
    const cleared = await live.dispatch({ action: "set", expectedRevision: before.revision, args: { code: "imported" }, replace: true });
    expect(cleared.args).toEqual({ code: "imported" });
    const score = studio("ABC", "score");
    score.state.args.style = "jazz";
    score.state.settings = { soundFont: "dry", room: false, instrumentOverride: true, warp: 150, loop: true };
    const scoreBefore = await score.dispatch({ action: "get" });
    const changed = await score.dispatch({ action: "set", expectedRevision: scoreBefore.revision, args: { abcNotation: "imported ABC" }, replace: true });
    expect(changed.args).toEqual({ abcNotation: "imported ABC" });
    expect(changed.settings).toEqual({ soundFont: "dry", room: false, instrumentOverride: true, warp: 150, loop: true });
    const explicit = await score.dispatch({ action: "set", expectedRevision: changed.revision, args: { abcNotation: "file ABC" }, settings: { warp: 100 }, replace: true });
    const defaults = { soundFont: "default", room: true, instrumentOverride: false, warp: 100, loop: false };
    expect(explicit.settings).toEqual(defaults);
    expect(score.apply).toHaveBeenLastCalledWith({ abcNotation: "file ABC" }, defaults);
  });

  it("cancels a pending play on disposal and never returns a live session afterward", async () => {
    const { session, dispatch, play } = studio();
    let resume!: () => void;
    let cancelled!: () => boolean;
    play.mockImplementationOnce(async (isCancelled: () => boolean) => {
      cancelled = isCancelled;
      await new Promise<void>(resolve => { resume = resolve; });
      expect(isCancelled()).toBe(true);
    });
    const pending = dispatch({ action: "play", expectedRevision: 0 });
    session.dispose();
    expect(cancelled()).toBe(true);
    resume();
    await expect(pending).rejects.toThrow("disposed");
    await expect(dispatch({ action: "get" })).rejects.toThrow("disposed");
  });
});
