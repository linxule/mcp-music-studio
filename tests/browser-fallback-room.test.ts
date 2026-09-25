/**
 * @file The share page gets the widget's Room.
 *
 * The page's script is an inline string, so it can't import src/room-reverb.ts.
 * These run its `// room:begin … // room:end` block in node:vm and hold it to the
 * widget: the same impulse response sample for sample, the same routing of
 * abcjs's sources, the same toggle.
 */
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { generatePlayerHtml } from "../src/browser-fallback";
import { ROOM, ROOM_PREF_KEY, impulseResponseChannels } from "../src/room-settings";

const html = generatePlayerHtml({
  abcNotation: 'X:1\nT:Room probe\nM:3/4\nL:1/4\nK:C\n"C"c z e |]\n',
});

function roomBlock(): string {
  const start = html.indexOf("// room:begin");
  const end = html.indexOf("// room:end");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

/** Enough of an AudioContext for the page's room graph. */
function fakeAudio() {
  const connections: [string, unknown][] = [];
  const node = (name: string) => ({
    name,
    gain: { value: 1, setTargetAtTime: vi.fn() },
    delayTime: { value: 0 },
    frequency: { value: 0 },
    type: "",
    buffer: null as unknown,
    connect(target: unknown) {
      connections.push([name, target]);
    },
  });
  const destination = { name: "destination" };
  const ctx = {
    sampleRate: 8000,
    currentTime: 0,
    destination,
    createGain: () => node("gain"),
    createDelay: () => node("delay"),
    createConvolver: () => node("convolver"),
    createBiquadFilter: () => node("lowpass"),
    createBuffer: (_channels: number, length: number) => {
      const data = [new Float32Array(length), new Float32Array(length)];
      return { length, getChannelData: (c: number) => data[c] };
    },
    createBufferSource: () => node("source"),
  };
  return { ctx, destination, connections };
}

function runPage(stored: string | null = null) {
  const audio = fakeAudio();
  const storage = new Map<string, string>();
  if (stored !== null) storage.set(ROOM_PREF_KEY, stored);
  const sandbox: Record<string, unknown> = {
    ABCJS: { synth: { activeAudioContext: () => audio.ctx } },
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
    },
    Float32Array,
  };
  vm.runInNewContext(roomBlock(), sandbox);
  return { ...audio, sandbox, storage };
}

describe("share page Room", () => {
  it("carries the widget's settings verbatim", () => {
    const { sandbox } = runPage();
    expect(JSON.parse(JSON.stringify(sandbox.ROOM))).toEqual(ROOM);
  });

  it("builds the widget's impulse response, sample for sample", () => {
    const { sandbox } = runPage();
    const [left, right] = (sandbox.roomImpulse as (r: number, s: unknown) => Float32Array[])(8000, ROOM);
    const [wLeft, wRight] = impulseResponseChannels(8000, ROOM);
    expect(Array.from(left)).toEqual(Array.from(wLeft));
    expect(Array.from(right)).toEqual(Array.from(wRight));
  });

  it("routes abcjs's sources into the room, before start()", () => {
    const { ctx, destination, connections, sandbox } = runPage();
    const midiBuffer = {
      _kickOffSound() {
        const source = ctx.createBufferSource();
        source.connect(ctx.destination);
      },
    };
    (sandbox.routeRoom as (b: unknown) => void)(midiBuffer);
    (sandbox.routeRoom as (b: unknown) => void)(midiBuffer); // idempotent
    midiBuffer._kickOffSound();
    const fromSource = connections.filter(([name]) => name === "source");
    expect(fromSource).toHaveLength(1);
    expect(fromSource[0][1]).not.toBe(destination);
    expect((fromSource[0][1] as { name: string }).name).toBe("gain");
    // The room's input reaches the speakers dry, and its wet path too.
    expect(connections.filter(([, target]) => target === destination)).toHaveLength(2);
    // The context is left as it was.
    expect(Object.prototype.hasOwnProperty.call(ctx, "createBufferSource")).toBe(true);
  });

  it("starts from the viewer's stored choice and remembers a change", () => {
    const off = runPage("off");
    expect(off.sandbox.roomOn).toBe(false);
    const on = runPage();
    expect(on.sandbox.roomOn).toBe(true);
    (on.sandbox.setRoom as (v: boolean) => void)(false);
    expect(on.storage.get(ROOM_PREF_KEY)).toBe("off");
  });

  it("wires the toggle and the onReady hook into the page", () => {
    expect(html).toContain('<input type="checkbox" id="room-toggle" checked>');
    expect(html).toMatch(/onReady: function\(controller\) \{\s*if \(controller\) routeRoom\(controller\.midiBuffer\);/);
    expect(html).toContain("roomToggle.addEventListener('change', function () { setRoom(roomToggle.checked); });");
  });
});
