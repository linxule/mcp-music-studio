import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function button() {
  return { classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
    setAttribute: vi.fn(), textContent: "", disabled: false } as unknown as HTMLButtonElement;
}

async function recordingHarness() {
  const recording = await import("../src/strudel-app/recording");
  const state = await import("../src/strudel-app/state");
  const instances: FakeRecorder[] = [];
  class FakeRecorder {
    static isTypeSupported = () => true;
    state = "inactive";
    mimeType = "audio/webm;codecs=opus";
    ondataavailable!: (event: { data: Blob }) => void;
    onstop!: () => void;
    constructor() { instances.push(this); }
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; }
  }
  const track = { stop: vi.fn() };
  const dest = { stream: { getTracks: () => [track] } };
  const master = { connect: vi.fn(), disconnect: vi.fn() };
  const limiter = { connect: vi.fn(), disconnect: vi.fn() };
  const decodeAudioData = vi.fn(async () => ({
    length: 1, numberOfChannels: 1, sampleRate: 48000,
    getChannelData: () => new Float32Array([0]),
  }));
  const ctx = { createMediaStreamDestination: () => dest, decodeAudioData };
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("window", {
    getAudioContext: () => ctx,
    getSuperdoughAudioController: () => ({ output: { destinationGain: master } }),
  });
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => { fn(); return 1; });
  const setStatus = vi.fn();
  const downloadFile = vi.fn(async () => ({}));
  const downloadBtn = button();
  recording.initRecording({
    app: { downloadFile } as any, recordBtn: button(), downloadBtn, setStatus,
    showPlayingStatus: vi.fn(), replAudioContext: () => ctx as any,
    ensureLimiter: vi.fn(), currentLimiter: () => limiter as any,
    recordingFileStem: () => "take",
  });
  state.setCanDownload(true);
  return { recording, state, instances, master, limiter, dest, track, setStatus, decodeAudioData, downloadFile };
}

describe("recording module lifecycle", () => {
  it("keeps a late previous-recorder chunk out of the next exported take", async () => {
    const h = await recordingHarness();
    h.recording.startRecording();
    const first = h.instances[0];
    h.recording.stopRecording();
    h.recording.startRecording();
    const second = h.instances[1];
    first.ondataavailable({ data: new Blob(["old"]) });
    first.onstop();
    second.ondataavailable({ data: new Blob(["new"]) });
    h.recording.stopRecording();
    second.onstop();
    const exported = h.recording.handleDownload();
    await vi.advanceTimersByTimeAsync(100);
    await exported;
    expect(h.decodeAudioData).toHaveBeenCalledOnce();
    const bytes = h.decodeAudioData.mock.calls[0] as unknown as [ArrayBuffer];
    expect(new TextDecoder().decode(bytes[0])).toBe("new");
    expect(h.downloadFile).toHaveBeenCalledOnce();
    expect(h.downloadFile.mock.calls[0]).toMatchObject([{ contents: [{ resource: {
      uri: "file:///take.wav", mimeType: "audio/wav",
    } }] }]);
  });

  it("enforces the time limit and disconnects only the post-limiter tap", async () => {
    const h = await recordingHarness();
    h.recording.startRecording();
    expect(h.limiter.connect).toHaveBeenCalledWith(h.dest);
    expect(h.master.connect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(h.recording.MAX_RECORDING_MS);
    expect(h.state.isRecording).toBe(false);
    expect(h.setStatus).toHaveBeenLastCalledWith(
      "Recording stopped at the 5-minute limit — ready to download", "normal",
    );
    h.recording.teardownRecording();
    h.recording.disconnectRecordingTap();
    expect(h.limiter.disconnect).toHaveBeenCalledExactlyOnceWith(h.dest);
    expect(h.master.disconnect).not.toHaveBeenCalled();
    expect(h.track.stop).toHaveBeenCalledOnce();
  });

  it("reports an absent MediaRecorder without attempting a recording", async () => {
    const h = await recordingHarness();
    vi.stubGlobal("MediaRecorder", undefined);
    expect(h.recording.pickRecordingMime()).toBeNull();
    h.recording.startRecording();
    expect(h.state.isRecording).toBe(false);
    expect(h.setStatus).toHaveBeenLastCalledWith("Recording not supported on this browser", "error");
  });
});

describe("visual canvas seam", () => {
  it("does not pre-create Hydra, adopts it before use, and reads replacement canvases live", async () => {
    const layers = await import("../src/strudel-app/layers");
    let notify!: MutationCallback;
    const body = {};
    let hydra: any = null;
    class Canvas {
      id = "hydra-canvas";
      parentElement: any = body;
      width = 0;
      height = 0;
      className = "";
      removeAttribute = vi.fn();
    }
    vi.stubGlobal("HTMLCanvasElement", Canvas);
    vi.stubGlobal("document", { body, getElementById: () => hydra });
    vi.stubGlobal("MutationObserver", class {
      constructor(fn: MutationCallback) { notify = fn; }
      observe() {}
      disconnect() {}
    });
    const viz = {} as HTMLCanvasElement;
    const section = {
      clientWidth: 1920, clientHeight: 1080,
      insertBefore: vi.fn((canvas: Canvas) => { canvas.parentElement = section; }),
    };
    layers.initLayers({
      replSection: section as any, vizCanvas: viz, vizBtn: button(), stageBtn: button(),
      hasAudioApi: () => false, installAudioReactiveGlobals: vi.fn(), startAnalyserLoop: vi.fn(),
      setHydraActive: vi.fn(), prefersReducedMotion: () => false,
    });
    expect(layers.getVisualCanvases()).toEqual({ hydra: null, viz });
    hydra = new Canvas();
    notify([{ addedNodes: [hydra] }] as any, {} as MutationObserver);
    expect(section.insertBefore).toHaveBeenCalledWith(hydra, viz);
    expect([hydra.width, hydra.height]).toEqual([960, 540]);
    expect(layers.getVisualCanvases().hydra).toBe(hydra);
    hydra = new Canvas();
    expect(layers.getVisualCanvases().hydra).toBe(hydra);
    hydra = null;
    expect(layers.getVisualCanvases().hydra).toBeNull();
  });
});

describe("reporting module live state", () => {
  it("debounces transitions, deduplicates them and cancels a pending teardown report", async () => {
    const reports = await import("../src/strudel-app/reports");
    const state = await import("../src/strudel-app/state");
    const updateModelContext = vi.fn(async () => ({}));
    let playback: "playing" | "stopped" = "playing";
    reports.initReports({
      app: { updateModelContext } as any, getEditor: () => null,
      currentPlaybackState: () => playback, isSchedulerStarted: () => playback === "playing",
      audioIsBlockedNow: () => false, renderPlayButton: vi.fn(), updatePlayState: vi.fn(),
      setStatus: vi.fn(), showPlayingStatus: vi.fn(), sensorNotes: () => "",
    });
    // Capabilities arrive after module initialization, not as a captured snapshot.
    state.setCanUpdateModelContext(true);
    reports.scheduleStateReport();
    reports.scheduleStateReport();
    await vi.advanceTimersByTimeAsync(500);
    expect(updateModelContext).toHaveBeenCalledOnce();
    expect(state.lastReportText).toContain("playing again");
    reports.scheduleStateReport();
    await vi.advanceTimersByTimeAsync(500);
    expect(updateModelContext).toHaveBeenCalledOnce();
    playback = "stopped";
    reports.scheduleStateReport();
    reports.cancelStateReport();
    await vi.advanceTimersByTimeAsync(500);
    expect(updateModelContext).toHaveBeenCalledOnce();
  });
});
