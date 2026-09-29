import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// Execute the actual local adapter with controllable audio promises. The
// browser-only module cannot be imported into Vitest's Node environment.
const source = readFileSync(new URL("../src/mcp-app.ts", import.meta.url), "utf8");
const adapter = source.slice(source.indexOf("installStudioBridge({"));
const playBody = adapter.slice(adapter.indexOf("  play: async (isCancelled) => {") + "  play: async (isCancelled) => {".length, adapter.indexOf("\n  stop: () => {")).replace(/\n  },\s*$/, "");

function fixture(draft = "X:1\nK:C\nCDEF|") {
  let generation = 0;
  let cancelled = false;
  const editorEl = { value: draft };
  const control = { play: vi.fn(async () => {}) };
  const state = { currentAbc: draft, synthControl: control };
  const resume = vi.fn(async () => true);
  const applyEdit = vi.fn(async () => {});
  const status = vi.fn();
  const release = vi.fn();
  const run = new Function("deps", `return (async () => {
    const { editorEl, state, resumeAudioContext, applyEditorAbc, setStatus, releaseStaleControl, isCancelled, currentGeneration } = deps;
    const setEditorMessage = () => {};
    const audioContext = () => ({});
    const AUDIO_RESUME_TIMEOUT_MS = 1;
    const disposed = false;
    let playPresses = 0;
    const statusEl = { classList: { contains: () => false } };
    const readTransport = () => ({ wasPlaying: false });
    const ownSynthControl = () => {};
    const renderGeneration = currentGeneration();
    const isStale = value => value !== currentGeneration();
    ${playBody}
  })();`);
  return {
    editorEl, state, control, resume, applyEdit, status, release,
    stop: () => { cancelled = true; generation++; },
    play: () => run({ editorEl, state, resumeAudioContext: resume, applyEditorAbc: applyEdit, setStatus: status, releaseStaleControl: release, isCancelled: () => cancelled, currentGeneration: () => generation }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("local score playback intent", () => {
  it("does not play the previous score when the editor is empty", async () => {
    const f = fixture("  \n");
    await f.play();
    expect(f.control.play).not.toHaveBeenCalled();
    expect(f.status).toHaveBeenCalledWith("Enter ABC notation before playing", true);
  });

  it("cannot restart after Stop during audio resume", async () => {
    const f = fixture();
    const resume = deferred<boolean>();
    f.resume.mockReturnValueOnce(resume.promise);
    const play = f.play();
    f.stop(); resume.resolve(true);
    await play;
    expect(f.control.play).not.toHaveBeenCalled();
  });

  it("cannot restart after Stop while re-priming an edited score", async () => {
    const f = fixture();
    f.state.currentAbc = "old score";
    const priming = deferred<void>();
    f.applyEdit.mockReturnValueOnce(priming.promise);
    const play = f.play();
    await Promise.resolve();
    expect(f.applyEdit).toHaveBeenCalled();
    f.stop(); priming.resolve();
    await play;
    expect(f.control.play).not.toHaveBeenCalled();
  });

  it("silences a delayed controller start after Stop", async () => {
    const f = fixture();
    const start = deferred<void>();
    f.control.play.mockReturnValueOnce(start.promise);
    const play = f.play();
    await Promise.resolve();
    expect(f.control.play).toHaveBeenCalledOnce();
    f.stop(); start.resolve();
    await play;
    expect(f.release).toHaveBeenCalledWith(f.control, 0);
  });

  it("leaves a newer human draft untouched during audio resume", async () => {
    const f = fixture();
    const resume = deferred<boolean>();
    f.resume.mockReturnValueOnce(resume.promise);
    const play = f.play();
    f.editorEl.value = "a newer draft";
    resume.resolve(true);
    await play;
    expect(f.control.play).not.toHaveBeenCalled();
    expect(f.applyEdit).not.toHaveBeenCalled();
  });
});
