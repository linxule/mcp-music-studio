import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RECORD_LIMITS, VIDEO_MIME_CANDIDATES, fixWebmDuration, formatClock, formatSetlist, letterbox,
  nativeVideoType, pickVideoMime, readWebmDuration, setlistLabel, videoFrameSize,
} from "../src/video-recording";
import { MAX_RECORDING_BYTES, MAX_RECORDING_MS } from "../src/strudel-app/recording";

describe("limits", () => {
  it("audio keeps 5 min / 50 MB; video is 5 min / 80 MB", () => {
    expect(RECORD_LIMITS.audio).toEqual({ minutes: 5, bytes: 50 * 1024 * 1024 });
    expect(RECORD_LIMITS.video).toEqual({ minutes: 5, bytes: 80 * 1024 * 1024 });
    expect(MAX_RECORDING_MS).toBe(5 * 60_000);
    expect(MAX_RECORDING_BYTES).toBe(RECORD_LIMITS.audio.bytes);
  });
});

describe("pickVideoMime", () => {
  // What the engines answered in scripts/prototype-video.mjs (2026-10-04).
  const chromium = new Set(["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus"]);
  const webkit = new Set(["video/mp4"]);

  it("Chromium gets VP9+Opus WebM", () => {
    expect(pickVideoMime((m) => chromium.has(m))).toBe("video/webm;codecs=vp9,opus");
  });
  it("VP8 when VP9 is missing", () => {
    expect(pickVideoMime((m) => m === "video/webm;codecs=vp8,opus")).toBe("video/webm;codecs=vp8,opus");
  });
  it("WebKit gets MP4", () => {
    expect(pickVideoMime((m) => webkit.has(m))).toBe("video/mp4");
  });
  it("lets the UA choose when nothing is claimed, the check throws, or there is no check", () => {
    expect(pickVideoMime(() => false)).toBe("");
    expect(pickVideoMime(() => { throw new Error("no"); })).toBe("");
    expect(pickVideoMime(undefined)).toBe("");
  });
  it("tries exactly the documented order", () => {
    const asked: string[] = [];
    pickVideoMime((m) => (asked.push(m), false));
    expect(asked).toEqual(VIDEO_MIME_CANDIDATES.filter(Boolean));
  });
});

describe("frame size and letterbox", () => {
  it("is the stage × DPR, capped at 1280×720 with the aspect kept, in even pixels", () => {
    expect(videoFrameSize(800, 450, 2)).toEqual({ width: 1280, height: 720 });
    expect(videoFrameSize(300, 200, 1)).toEqual({ width: 300, height: 200 });
    expect(videoFrameSize(301, 201, 1)).toEqual({ width: 300, height: 200 });
    // A phone in portrait: height is the binding cap.
    expect(videoFrameSize(390, 700, 3)).toEqual({ width: 400, height: 720 });
    // A wide stage: width binds.
    expect(videoFrameSize(1600, 400, 1)).toEqual({ width: 1280, height: 320 });
    expect(videoFrameSize(0, 0, 0)).toEqual({ width: 2, height: 2 });
  });

  it("letterboxes rather than stretching", () => {
    expect(letterbox(1280, 720, 1280, 720)).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
    // A 4:3 source in a 16:9 frame: pillarboxed, centred.
    expect(letterbox(800, 600, 1280, 720)).toEqual({ x: 160, y: 0, width: 960, height: 720 });
    // A wide source in a tall frame.
    expect(letterbox(960, 540, 400, 720)).toEqual({ x: 0, y: 247.5, width: 400, height: 225 });
    // A downscaled Hydra canvas of the same aspect fills the frame.
    expect(letterbox(640, 360, 1280, 720)).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
    expect(letterbox(0, 0, 10, 10)).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });
});

describe("nativeVideoType", () => {
  it("names the file by its container", () => {
    expect(nativeVideoType("video/webm;codecs=vp9,opus")).toEqual({ mimeType: "video/webm", extension: "webm" });
    expect(nativeVideoType("video/mp4;codecs=avc1.42E01E,mp4a.40.2")).toEqual({ mimeType: "video/mp4", extension: "mp4" });
    expect(nativeVideoType("")).toEqual({ mimeType: "video/webm", extension: "webm" });
  });
});

// --- A minimal live WebM, shaped like Chromium's MediaRecorder output ---------

function vintSize(n: number, length = 1): number[] {
  const out: number[] = [];
  let v = n;
  for (let i = 0; i < length; i++) {
    out.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (length - 1);
  return out;
}
const el = (id: number[], data: number[], sizeLength = 1) => [...id, ...vintSize(data.length, sizeLength), ...data];
const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const f64 = (v: number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v);
  return [...b];
};
const EBML_HEADER = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], [...new TextEncoder().encode("webm")]));
const TIMECODE_SCALE = el([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]); // 1,000,000
const MUXING_APP = el([0x4d, 0x80], [...new TextEncoder().encode("Chrome")]);
const TRACKS = el([0x16, 0x54, 0xae, 0x6b], el([0xae], el([0xd7], [1])));
const CLUSTER = [0x1f, 0x43, 0xb6, 0x75, ...UNKNOWN, ...el([0xe7], [0]), ...el([0xa3], [0x81, 0, 0, 0x80, 1, 2, 3])];

function liveWebm(info: number[] = [...TIMECODE_SCALE, ...MUXING_APP], infoSizeLength = 1): Uint8Array {
  return new Uint8Array([
    ...EBML_HEADER,
    0x18, 0x53, 0x80, 0x67, ...UNKNOWN,
    ...el([0x15, 0x49, 0xa9, 0x66], info, infoSizeLength),
    ...TRACKS,
    ...CLUSTER,
  ]);
}

describe("fixWebmDuration", () => {
  it("writes the duration into a live WebM that has none", () => {
    const original = liveWebm();
    expect(readWebmDuration(original)).toBeNull();
    const fixed = fixWebmDuration(original, 3012.5)!;
    expect(fixed.length).toBe(original.length + 11);
    expect(readWebmDuration(fixed)).toBe(3012.5);
    // Everything after Info is byte-identical (tracks, clusters).
    const tail = TRACKS.length + CLUSTER.length;
    expect([...fixed.subarray(fixed.length - tail)]).toEqual([...original.subarray(original.length - tail)]);
  });

  it("re-encodes an Info size that no longer fits its width", () => {
    const filler = el([0x7b, 0xa9], new Array(110).fill(0x41)); // Title, 113 bytes → Info is 124 bytes
    const original = liveWebm([...TIMECODE_SCALE, ...filler], 1);
    const fixed = fixWebmDuration(original, 1000)!;
    expect(fixed.length).toBe(original.length + 11 + 7); // 1-byte size → 8-byte size
    expect(readWebmDuration(fixed)).toBe(1000);
  });

  it("honours a TimecodeScale other than milliseconds", () => {
    const scale = el([0x2a, 0xd7, 0xb1], [0x01, 0x86, 0xa0]); // 100,000 ns per tick
    const fixed = fixWebmDuration(liveWebm([...scale, ...MUXING_APP]), 2500)!;
    const durationAt = fixed.indexOf(0x44);
    expect(new DataView(fixed.buffer).getFloat64(durationAt + 3)).toBe(25_000);
    expect(readWebmDuration(fixed)).toBe(2500);
  });

  it("overwrites an existing Duration in place", () => {
    const duration = el([0x44, 0x89], f64(0));
    const original = liveWebm([...TIMECODE_SCALE, ...duration, ...MUXING_APP]);
    const fixed = fixWebmDuration(original, 4200)!;
    expect(fixed.length).toBe(original.length);
    expect(readWebmDuration(fixed)).toBe(4200);
    expect(readWebmDuration(original)).toBe(0); // the input is not mutated
  });

  it("adjusts a known Segment size", () => {
    const body = [...el([0x15, 0x49, 0xa9, 0x66], [...TIMECODE_SCALE, ...MUXING_APP]), ...TRACKS];
    const original = new Uint8Array([...EBML_HEADER, 0x18, 0x53, 0x80, 0x67, ...vintSize(body.length, 8), ...body]);
    const fixed = fixWebmDuration(original, 500)!;
    const sizeAt = EBML_HEADER.length + 4;
    const size = new DataView(fixed.buffer).getBigUint64(sizeAt) & 0x00ffffffffffffffn;
    expect(Number(size)).toBe(body.length + 11);
    expect(readWebmDuration(fixed)).toBe(500);
  });

  it("leaves files it can't patch safely alone", () => {
    const seekHead = el([0x11, 0x4d, 0x9b, 0x74], [0xec, 0x80]);
    const withSeek = new Uint8Array([...EBML_HEADER, 0x18, 0x53, 0x80, 0x67, ...UNKNOWN, ...seekHead, ...liveWebm().subarray(EBML_HEADER.length + 12)]);
    expect(fixWebmDuration(withSeek, 1000)).toBeNull();
    expect(fixWebmDuration(new Uint8Array([0, 0, 0, 0]), 1000)).toBeNull();
    expect(fixWebmDuration(new Uint8Array([0x00, 0x00, 0x00, 0x18]), 1000)).toBeNull(); // an MP4 box
    expect(fixWebmDuration(liveWebm(), 0)).toBeNull();
    expect(fixWebmDuration(liveWebm(), Infinity)).toBeNull();
    // Info missing (clusters straight after the segment header).
    expect(fixWebmDuration(new Uint8Array([...EBML_HEADER, 0x18, 0x53, 0x80, 0x67, ...UNKNOWN, ...CLUSTER]), 1000)).toBeNull();
    // Truncated mid-Info.
    expect(fixWebmDuration(liveWebm().subarray(0, EBML_HEADER.length + 16), 1000)).toBeNull();
  });
});

describe("setlist", () => {
  it("labels a pattern by its first comment, else its first line", () => {
    expect(setlistLabel("// verse two — the bass drops out\nsetcps(0.5)\ns('bd')")).toBe("verse two — the bass drops out");
    expect(setlistLabel("\n  s(\"bd*4\").gain(0.8)\n// later")).toBe("later");
    expect(setlistLabel("setcps(0.5)\ns('bd')")).toBe("setcps(0.5)");
    expect(setlistLabel("")).toBe("");
    expect(setlistLabel(`// ${"x".repeat(100)}`)).toHaveLength(72);
  });

  it("formats times as m:ss.t", () => {
    expect(formatClock(0)).toBe("0:00.0");
    expect(formatClock(83_249)).toBe("1:23.2");
    expect(formatClock(599_960)).toBe("10:00.0");
    expect(formatClock(-5)).toBe("0:00.0");
  });

  it("lists every change with its time, bar and author", () => {
    const text = formatSetlist(
      [
        { atMs: 0, cycle: 11.7, by: "start", code: "// intro\ns('bd')" },
        { atMs: 31_240, cycle: 24, by: "claude", rev: 3, code: "// the drop\ns('bd*4')" },
        { atMs: 62_500, cycle: null, by: "you", code: "s('bd*4, hh*8')" },
        { atMs: 70_000, cycle: 40.2, by: "tool", code: "// outro" },
      ],
      { title: "night-set", recordedAt: new Date(Date.UTC(2026, 9, 4, 21, 5)), durationMs: 95_000, file: "night-set.webm" },
    );
    expect(text).toBe([
      "night-set — setlist",
      "Recorded 2026-10-04 21:05 UTC, 1:35.0 long — night-set.webm",
      "",
      "time    bar  by              pattern",
      "0:00.0   11  start           intro",
      "0:31.2   24  Claude (rev 3)  the drop",
      "1:02.5    —  you (edit)      s('bd*4, hh*8')",
      "1:10.0   40  swap-pattern    outro",
      "",
    ].join("\n"));
  });
});

// --- The widget module's video path, with the browser faked -------------------

beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

/** Advance fake time until `p` settles (downloads yield between slices). */
async function settle<T>(p: Promise<T>): Promise<T> {
  let finished = false;
  void p.finally(() => { finished = true; });
  for (let i = 0; i < 100 && !finished; i++) await vi.advanceTimersByTimeAsync(50);
  return p;
}

function button() {
  return { classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
    setAttribute: vi.fn(), textContent: "", disabled: false } as unknown as HTMLButtonElement;
}

async function videoHarness(opts: { session?: boolean; mime?: string } = {}) {
  const recording = await import("../src/strudel-app/recording");
  const state = await import("../src/strudel-app/state");
  const recorders: any[] = [];
  const supported = new Set([opts.mime ?? "video/webm;codecs=vp9,opus"]);
  class FakeRecorder {
    static isTypeSupported = (m: string) => supported.has(m);
    state = "inactive";
    mimeType: string;
    ondataavailable!: (event: { data: Blob }) => void;
    onstop!: () => void;
    constructor(public stream: any, public options: any) { this.mimeType = options.mimeType ?? ""; recorders.push(this); }
    start(timeslice: number) { this.state = "recording"; (this as any).timeslice = timeslice; }
    stop() { this.state = "inactive"; }
  }
  const audioTrack = { kind: "audio", stop: vi.fn() };
  const videoTrack = { kind: "video", stop: vi.fn() };
  const dest = { stream: { getTracks: () => [audioTrack], getAudioTracks: () => [audioTrack] } };
  const limiter = { connect: vi.fn(), disconnect: vi.fn() };
  const draws: unknown[][] = [];
  const ctx2d = { fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn((...a: unknown[]) => draws.push(a)) };
  const comp = {
    width: 0, height: 0, getContext: () => ctx2d,
    captureStream: vi.fn(() => ({ getVideoTracks: () => [videoTrack], getTracks: () => [videoTrack] })),
  };
  class Canvas {}
  (Canvas.prototype as any).captureStream = () => null;
  vi.stubGlobal("HTMLCanvasElement", Canvas);
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("MediaStream", class { constructor(public tracks: unknown[]) {} });
  vi.stubGlobal("document", { createElement: () => comp });
  let rafs: Array<() => void> = [];
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => { rafs.push(fn); return rafs.length; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("window", {
    devicePixelRatio: 2,
    getAudioContext: () => ({ createMediaStreamDestination: () => dest }),
    getSuperdoughAudioController: () => ({ output: { destinationGain: {} } }),
  });
  const hydra = { width: 640, height: 360 };
  const viz = { width: 1600, height: 900 };
  let hydraTicking = true;
  const downloadFile = vi.fn(async (_p: any, _o?: any) => ({}));
  const recordBtn = button();
  const videoBtn = button();
  const setStatus = vi.fn();
  recording.initRecording({
    app: { downloadFile } as any, recordBtn, videoBtn, downloadBtn: button(), setStatus,
    showPlayingStatus: vi.fn(), replAudioContext: () => null,
    ensureLimiter: vi.fn(), currentLimiter: () => limiter as any, recordingFileStem: () => "set",
    visualLayers: () => [hydra, viz] as any,
    stageFrame: () => ({ width: 800, height: 450, background: "rgb(1, 2, 3)" }),
    hydraTicking: () => hydraTicking,
    currentCode: () => "// opener\ns('bd')",
    audibleCycle: () => 4.5,
    inSession: () => !!opts.session,
  });
  state.setCanDownload(true);
  const frame = () => { const r = rafs; rafs = []; r.forEach((f) => f()); };
  return {
    recording, state, recorders, comp, ctx2d, draws, videoTrack, audioTrack, downloadFile, recordBtn, videoBtn, setStatus,
    frame, setHydraTicking: (v: boolean) => { hydraTicking = v; },
  };
}

describe("video recording in the widget module", () => {
  it("records the composited stage with the limiter's audio, in the negotiated type", async () => {
    const h = await videoHarness();
    h.recording.startRecording("video");
    const rec = h.recorders[0];
    expect(rec.options).toMatchObject({ mimeType: "video/webm;codecs=vp9,opus", videoBitsPerSecond: 2_000_000 });
    expect(rec.stream.tracks).toEqual([h.videoTrack, h.audioTrack]);
    expect(h.comp.captureStream).toHaveBeenCalledWith(30);
    expect([h.comp.width, h.comp.height]).toEqual([1280, 720]);
    expect(h.videoBtn.textContent).toBe("Stop Rec");
    expect(h.recordBtn.disabled).toBe(true);
    expect(h.setStatus).toHaveBeenLastCalledWith("Recording video...", "playing");
  });

  it("paints from the Hydra tick while Hydra runs, from its own frame otherwise", async () => {
    const h = await videoHarness();
    h.recording.startRecording("video");
    h.draws.length = 0;
    h.frame(); // Hydra ticking: the recorder's own rAF must not paint
    expect(h.draws).toHaveLength(0);
    h.recording.paintVideoFrameAfterHydraTick();
    // Hydra, then the 2D layer over it, each letterboxed into the frame.
    expect(h.draws).toEqual([
      [{ width: 640, height: 360 }, 0, 0, 1280, 720],
      [{ width: 1600, height: 900 }, 0, 0, 1280, 720],
    ]);
    expect(h.ctx2d.fillStyle).toBe("rgb(1, 2, 3)");
    h.setHydraTicking(false);
    h.draws.length = 0;
    h.frame();
    expect(h.draws).toHaveLength(2);
  });

  it("stops at 80 MB, not the audio path's 50", async () => {
    const h = await videoHarness();
    h.recording.startRecording("video");
    const rec = h.recorders[0];
    rec.ondataavailable({ data: { size: 60 * 1024 * 1024 } as Blob });
    expect(h.state.isRecording).toBe(true);
    rec.ondataavailable({ data: { size: 21 * 1024 * 1024 } as Blob });
    expect(h.state.isRecording).toBe(false);
    expect(h.setStatus).toHaveBeenLastCalledWith("Recording stopped at the size limit — ready to download", "normal");
  });

  it("stops at 5 minutes and releases the canvas stream but not the audio tap", async () => {
    const h = await videoHarness();
    h.recording.startRecording("video");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(h.state.isRecording).toBe(false);
    expect(h.videoTrack.stop).toHaveBeenCalled();
    expect(h.audioTrack.stop).not.toHaveBeenCalled();
    expect(h.videoBtn.textContent).toBe("Rec video");
    expect(h.recordBtn.disabled).toBe(false);
  });

  it("exports the WebM with its duration, then the session's setlist", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    const h = await videoHarness({ session: true });
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 4, 20, 0)));
    h.recording.startRecording("video");
    const rec = h.recorders[0];
    await vi.advanceTimersByTimeAsync(2000);
    h.recording.noteSetlistChange({ by: "claude", rev: 2, cycle: 8, code: "// chorus\ns('bd*2')" });
    await vi.advanceTimersByTimeAsync(1000);
    rec.ondataavailable({ data: new Blob([liveWebm()]) });
    h.recording.stopRecording();
    rec.onstop();
    await settle(h.recording.handleDownload());
    expect(h.downloadFile).toHaveBeenCalledTimes(2);
    const video = h.downloadFile.mock.calls[0][0].contents[0].resource;
    expect(video).toMatchObject({ uri: "file:///set.webm", mimeType: "video/webm" });
    const bytes = Uint8Array.from(Buffer.from(video.blob, "base64"));
    expect(readWebmDuration(bytes)).toBeCloseTo(3000, -1);
    expect(h.downloadFile.mock.calls[0][1]).toEqual({ timeout: 600_000 });
    const list = h.downloadFile.mock.calls[1][0].contents[0].resource;
    expect(list).toMatchObject({ uri: "file:///set-setlist.txt", mimeType: "text/plain" });
    expect(list.text).toContain("0:00.0    4  start           opener");
    expect(list.text).toContain("0:02.0    8  Claude (rev 2)  chorus");
    expect(h.setStatus).toHaveBeenLastCalledWith(expect.stringMatching(/^Saved set\.webm \(0\.0 MB\) and its setlist$/), "normal");
  });

  it("offers no setlist outside a live session, and records MP4 where that is all there is", async () => {
    const h = await videoHarness({ mime: "video/mp4" });
    h.recording.startRecording("video");
    const rec = h.recorders[0];
    expect(rec.options.mimeType).toBe("video/mp4");
    h.recording.noteSetlistChange({ by: "you", cycle: 1, code: "s('bd')" });
    rec.ondataavailable({ data: new Blob([new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70])]) });
    h.recording.stopRecording();
    rec.onstop();
    await settle(h.recording.handleDownload());
    expect(h.downloadFile).toHaveBeenCalledOnce();
    expect(h.downloadFile.mock.calls[0][0].contents[0].resource).toMatchObject({ uri: "file:///set.mp4", mimeType: "video/mp4" });
  });

  it("an audio recording is untouched by the video path", async () => {
    const h = await videoHarness();
    h.recording.startRecording();
    const rec = h.recorders[0];
    expect(rec.options.videoBitsPerSecond).toBeUndefined();
    expect(rec.stream).toBe((globalThis as any).window.getAudioContext().createMediaStreamDestination().stream);
    expect(h.comp.captureStream).not.toHaveBeenCalled();
    expect(h.recordBtn.textContent).toBe("Stop Rec");
    expect(h.videoBtn.disabled).toBe(true);
  });
});
