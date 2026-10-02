import { liveStudioSchemas } from "../src/studio-schemas";
import { describe, expect, it, vi } from "vitest";
import { createStudioSession, type StudioSnapshot } from "../src/studio-session";
import type { SharedReview } from "../src/studio-review";
import { chatHandoff } from "../src/studio-handoff";

function studio(source = 's("bd hh")') {
  const state: StudioSnapshot = { args: { code: source, title: "Beat" }, playback: "stopped", status: "Ready", error: null };
  const apply = vi.fn(async (args: Record<string, unknown>, settings?: Record<string, unknown>, _cancelled?: () => boolean, onCommit?: () => void) => {
    state.args = args; state.settings = settings; state.playback = "stopped";
    onCommit?.();
  });
  const play = vi.fn(async () => {});
  const session = createStudioSession({ read: () => structuredClone(state), apply, play, stop: () => { state.playback = "stopped"; } }, { mode: "live", schemas: liveStudioSchemas });
  async function begin(question = "Make the drums gentler") {
    const current = await session({ action: "get" });
    const from = String(current.args.code).indexOf("bd");
    const passage = { instanceId: current.instanceId, mode: current.mode, revision: current.revision, from, to: from + 2, text: "bd" };
    const started = await session({ action: "review-start", instanceId: current.instanceId, expectedRevision: current.revision, passage, question });
    return started.sharedReview!;
  }
  const stage = (review: SharedReview, replacement = "sd") => session({ action: "review-stage", instanceId: session.instanceId, requestId: review.requestId, passage: review.passage, explanation: "Use a softer drum.", replacement });
  return { state, session, apply, play, begin, stage };
}

describe("session-owned passage review", () => {
  it("supersedes a response to the old question even when music revision and passage are identical", async () => {
    const { begin, stage, session, state, apply } = studio();
    const first = await begin("What does this drum do?");
    const second = await begin("Can it be gentler?");
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.passage).toEqual(first.passage);
    await expect(stage(first)).rejects.toThrow("superseded");
    const staged = await stage(second);
    expect(staged.sharedReview).toMatchObject({ requestId: second.requestId, question: "Can it be gentler?", replacement: "sd", stale: false });
    expect(staged.revision).toBe(0);
    expect(staged.canUndo).toBe(false);
    expect(state.args.code).toBe('s("bd hh")');
    expect(apply).not.toHaveBeenCalled();
    await expect(session({ action: "review-clear", instanceId: session.instanceId, requestId: first.requestId })).rejects.toThrow("superseded");
  });

  it("preserves question keystrokes and supersedes a pending response when the question becomes empty", async () => {
    const { begin, stage } = studio();
    const first = await begin("What ");
    expect(first.question).toBe("What ");
    const empty = await begin("");
    expect(empty.question).toBe("");
    await expect(stage(first)).rejects.toThrow("superseded");
    expect((await stage(empty)).sharedReview!.question).toBe("");
    const handoff = chatHandoff(empty);
    expect(handoff).toContain("Explain this passage.");
    expect(handoff).toContain(empty.requestId);
    expect(handoff).toContain(JSON.stringify(empty.passage));
  });

  it("freezes the passage independently of cursor movement and rejects an altered response identity", async () => {
    const { begin, stage, state, session } = studio();
    const review = await begin();
    state.selection = { from: 6, to: 8, text: "hh" };
    const response = { action: "review-stage" as const, instanceId: session.instanceId, requestId: review.requestId, explanation: "Change it", replacement: "cp" };
    await expect(session({ ...response, passage: { ...review.passage, from: 6, to: 8, text: "hh" } })).rejects.toThrow("frozen request");
    const staged = await stage(review);
    expect(staged.sharedReview!.passage).toEqual(review.passage);
    const applied = await session({ action: "review-apply", instanceId: session.instanceId, requestId: review.requestId, expectedRevision: staged.revision });
    expect(applied.args.code).toBe('s("sd hh")');
    expect(applied.sharedReview).toBeNull();
    expect(applied.playback).toBe("stopped");
  });

  it("marks source or sound-setting races stale once and never revives a restored source", async () => {
    for (const change of [(state: StudioSnapshot) => { state.args.code = 's("bd cp")'; }, (state: StudioSnapshot) => { state.settings = {}; }]) {
      const { begin, stage, session, state } = studio();
      const review = await begin();
      const listener = vi.fn();
      session.onReviewChange(listener);
      change(state);
      const current = await session({ action: "get" });
      expect(current.sharedReview!.stale).toBe(true);
      const count = listener.mock.calls.length;
      await session({ action: "get" });
      expect(listener).toHaveBeenCalledTimes(count);
      await expect(stage(review)).rejects.toThrow("stale");
      state.args.code = 's("bd hh")'; state.settings = undefined;
      const restored = await session({ action: "get" });
      await expect(session({ action: "review-apply", instanceId: session.instanceId, requestId: review.requestId, expectedRevision: restored.revision })).rejects.toThrow("stale");
    }
  });

  it("applies a proposal through the shared history and undoes to the exact human draft", async () => {
    const { begin, stage, session, state, play } = studio();
    state.args.code = '// human draft\ns("bd hh")';
    const original = structuredClone(state.args);
    const review = await begin();
    const staged = await stage(review);
    const applied = await session({ action: "review-apply", instanceId: session.instanceId, requestId: review.requestId, expectedRevision: staged.revision });
    expect(applied.args.code).toBe('// human draft\ns("sd hh")');
    expect(applied.canUndo).toBe(true);
    expect(play).not.toHaveBeenCalled();
    const undone = await session({ action: "undo", instanceId: session.instanceId, expectedRevision: applied.revision });
    expect(undone.args).toEqual(original);
    expect(undone.canUndo).toBe(false);
  });

  it("bounds the assembled source before recording history or applying", async () => {
    const { begin, stage, session, apply } = studio('s("bd")' + ' '.repeat(65536 - 7));
    const review = await begin();
    const staged = await stage(review, "longer");
    await expect(session({ action: "review-apply", instanceId: session.instanceId, requestId: review.requestId, expectedRevision: staged.revision })).rejects.toThrow();
    expect(apply).not.toHaveBeenCalled();
    expect((await session({ action: "get" })).canUndo).toBe(false);
  });

  it("retains a failed proposal and recovery snapshot when a renderer partially commits then reports an error", async () => {
    const { begin, stage, session, state, apply } = studio();
    const review = await begin();
    const staged = await stage(review);
    apply.mockImplementationOnce(async (args, _settings, _cancelled, onCommit) => { state.args = args; onCommit?.(); state.error = "Rendering failed"; });
    const failed = await session({ action: "review-apply", instanceId: session.instanceId, requestId: review.requestId, expectedRevision: staged.revision });
    expect(failed).toMatchObject({ error: "Rendering failed", canUndo: true, sharedReview: { requestId: review.requestId, stale: true, replacement: "sd" } });
  });

  it("clears an in-flight review before async mutation commits and rejects late stage after clear or teardown", async () => {
    const { begin, stage, session, apply, state } = studio();
    const review = await begin();
    const staged = await stage(review);
    let resume!: () => void;
    apply.mockImplementationOnce(async (args, _settings, cancelled, onCommit) => {
      await new Promise<void>(resolve => { resume = resolve; });
      if (!cancelled?.()) { state.args = args; onCommit?.(); }
    });
    const pending = session({ action: "review-apply", instanceId: session.instanceId, requestId: review.requestId, expectedRevision: staged.revision });
    await session({ action: "review-clear", instanceId: session.instanceId, requestId: review.requestId });
    resume(); await expect(pending).rejects.toThrow("not applied");
    expect(state.args.code).toBe('s("bd hh")');
    expect((await session({ action: "get" })).canUndo).toBe(false);
    await expect(stage(review)).rejects.toThrow("cleared");
    const fresh = await begin();
    session.dispose();
    await expect(stage(fresh)).rejects.toThrow("disposed");
    await expect(session({ action: "review-apply", instanceId: session.instanceId, requestId: fresh.requestId, expectedRevision: 0 })).rejects.toThrow("disposed");
  });

  it("reports an unchanged no-error render as a cancelled Apply and retains the proposal without adding undo", async () => {
    const { begin, stage, session, apply } = studio();
    const review = await begin();
    const staged = await stage(review);
    apply.mockImplementationOnce(async () => {});
    await expect(session({ action: "review-apply", instanceId: session.instanceId, requestId: review.requestId, expectedRevision: staged.revision })).rejects.toThrow("not applied");
    const current = await session({ action: "get" });
    expect(current.sharedReview).toMatchObject({ requestId: review.requestId, replacement: "sd", stale: false });
    expect(current.canUndo).toBe(false);
  });

  it("does not add review undo history for a pre-commit exception or a concurrent human edit", async () => {
    for (const humanEdit of [false, true]) {
      const { begin, stage, session, state, apply } = studio();
      const review = await begin();
      const staged = await stage(review);
      apply.mockImplementationOnce(async () => {
        if (humanEdit) state.args.code = 's("bd cp") // new human draft';
        throw new Error("Cancelled before commit");
      });
      await expect(session({ action: "review-apply", instanceId: session.instanceId, requestId: review.requestId, expectedRevision: staged.revision })).rejects.toThrow("Cancelled before commit");
      const current = await session({ action: "get" });
      expect(current.canUndo).toBe(false);
      expect(current.sharedReview).toMatchObject({ requestId: review.requestId, stale: humanEdit });
      expect(current.args.code).toBe(humanEdit ? 's("bd cp") // new human draft' : 's("bd hh")');
    }
  });

  it("uses the renderer commit receipt even if the human edits the draft before async rendering settles", async () => {
    const { begin, stage, session, state, apply } = studio();
    const review = await begin();
    const staged = await stage(review);
    let resume!: () => void;
    apply.mockImplementationOnce(async (args, _settings, _cancelled, onCommit) => {
      state.args = args; onCommit?.();
      await new Promise<void>(resolve => { resume = resolve; });
    });
    const pending = session({ action: "review-apply", instanceId: session.instanceId, requestId: review.requestId, expectedRevision: staged.revision });
    state.args.code = 's("cp") // human edit after approved commit';
    resume();
    const applied = await pending;
    expect(applied.args.code).toBe('s("cp") // human edit after approved commit');
    expect(applied.sharedReview).toBeNull();
    expect(applied.canUndo).toBe(true);
  });

  it("does not mistake a concurrent human edit matching the proposal for an agent commit", async () => {
    const { begin, stage, session, state, apply } = studio();
    const review = await begin();
    const staged = await stage(review);
    apply.mockImplementationOnce(async args => { state.args = args; });
    await expect(session({ action: "review-apply", instanceId: session.instanceId, requestId: review.requestId, expectedRevision: staged.revision })).rejects.toThrow("not applied");
    const current = await session({ action: "get" });
    expect(current.args.code).toBe('s("sd hh")');
    expect(current.canUndo).toBe(false);
    expect(current.sharedReview).toMatchObject({ requestId: review.requestId, stale: true });
  });

  it("does not create an undo entry when a guard rejects before commit and reports a human draft race as an error", async () => {
    const { begin, stage, session, state, apply } = studio();
    const review = await begin();
    const staged = await stage(review);
    apply.mockImplementationOnce(async () => {
      state.args.code = 's("cp") // human edit during render';
      state.error = "The editor changed while loading. Read the current session before editing again.";
    });
    await expect(session({ action: "review-apply", instanceId: session.instanceId, requestId: review.requestId, expectedRevision: staged.revision })).rejects.toThrow("not applied. The editor changed while loading");
    const rejected = await session({ action: "get" });
    expect(rejected.canUndo).toBe(false);
    expect(rejected.args.code).toBe('s("cp") // human edit during render');
    expect(rejected.sharedReview).toMatchObject({ requestId: review.requestId, stale: true });
    await expect(session({ action: "undo", instanceId: session.instanceId, expectedRevision: rejected.revision })).rejects.toThrow("No agent edit");
  });
});
