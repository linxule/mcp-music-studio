// =============================================================================
// Room: abcjs notes held at full level then cut by a 200 ms linear fade into
// silence (place-note.js), which the user heard as notes stopping "quite
// abruptly" with no decay. A longer release (NOTE_FADE_MS) plus a light room.
// =============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  ROOM,
  impulseResponseChannels,
  routeThroughRoom,
  seededRandom,
} from "../src/room-reverb";
import { NOTE_FADE_MS, buildSynthOptions } from "../src/music-logic";

describe("impulse response", () => {
  const rate = 8000;
  const [left, right] = impulseResponseChannels(rate);

  it("lasts the room's RT60", () => {
    expect(left.length).toBe(Math.floor(rate * ROOM.seconds));
    expect(right.length).toBe(left.length);
  });

  it("decays about 60 dB from start to end", () => {
    const rms = (a: Float32Array, from: number, to: number) => {
      let sum = 0;
      for (let i = from; i < to; i++) sum += a[i] * a[i];
      return Math.sqrt(sum / (to - from));
    };
    const head = rms(left, 100, 500);
    const tail = rms(left, left.length - 400, left.length);
    const db = 20 * Math.log10(tail / head);
    expect(db).toBeLessThan(-50);
    expect(db).toBeGreaterThan(-70);
  });

  it("fades in over a few ms, so the onset can't click", () => {
    expect(Math.abs(left[0])).toBe(0);
    expect(Math.abs(right[0])).toBe(0);
  });

  it("is the same room every time, with decorrelated channels", () => {
    const [again] = impulseResponseChannels(rate);
    expect(Array.from(again.slice(0, 64))).toEqual(Array.from(left.slice(0, 64)));
    expect(Array.from(right.slice(40, 64))).not.toEqual(Array.from(left.slice(40, 64)));
    const r = seededRandom(1);
    const values = Array.from({ length: 1000 }, r);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThan(1);
  });
});

describe("routeThroughRoom", () => {
  /** A context whose sources record where they were connected. */
  function fakeContext() {
    const destination = { name: "destination" };
    const connections: unknown[] = [];
    const ctx = {
      destination,
      createBufferSource() {
        return {
          connect(node: unknown) {
            connections.push(node);
          },
          start: vi.fn(),
        };
      },
    };
    return { ctx, destination, connections };
  }

  /** abcjs's _kickOffSound, reduced: create, connect to destination, start. */
  function fakeMidiBuffer(ctx: ReturnType<typeof fakeContext>["ctx"]) {
    return {
      directSource: [] as unknown[],
      _kickOffSound(this: { directSource: unknown[] }) {
        const source = ctx.createBufferSource();
        source.connect(ctx.destination);
        source.start(0);
        this.directSource = [source];
      },
    };
  }

  it("connects abcjs's sources to the room instead of the destination", () => {
    const { ctx, connections } = fakeContext();
    const room = { name: "room" };
    const buffer = fakeMidiBuffer(ctx);
    expect(routeThroughRoom(buffer, () => ctx as never, () => room as never)).toBe(true);
    buffer._kickOffSound();
    expect(connections).toEqual([room]);
  });

  it("puts the context back as it was after each kick-off", () => {
    const { ctx } = fakeContext();
    const own = ctx.createBufferSource;
    const buffer = fakeMidiBuffer(ctx);
    routeThroughRoom(buffer, () => ctx as never, () => ({}) as never);
    buffer._kickOffSound();
    expect(ctx.createBufferSource).toBe(own);
  });

  it("wraps each midiBuffer once, however many go()s call it", () => {
    const { ctx, connections } = fakeContext();
    const buffer = fakeMidiBuffer(ctx);
    const inputFor = vi.fn(() => ({ name: "room" }) as never);
    routeThroughRoom(buffer, () => ctx as never, inputFor);
    routeThroughRoom(buffer, () => ctx as never, inputFor);
    buffer._kickOffSound();
    expect(inputFor).toHaveBeenCalledTimes(1);
    expect(connections).toHaveLength(1);
  });

  it("plays dry rather than not at all when the room can't be built", () => {
    const { ctx, destination, connections } = fakeContext();
    const buffer = fakeMidiBuffer(ctx);
    routeThroughRoom(buffer, () => ctx as never, () => {
      throw new Error("no convolver");
    });
    buffer._kickOffSound();
    expect(connections).toEqual([destination]);
  });

  it("ignores anything that isn't an abcjs midiBuffer", () => {
    expect(routeThroughRoom(null, () => null, () => ({}) as never)).toBe(false);
    expect(routeThroughRoom({}, () => null, () => ({}) as never)).toBe(false);
  });
});

describe("note release", () => {
  it("every synth option set carries the longer release, alongside tool options", () => {
    const opts = buildSynthOptions({ instrument: "Acoustic Grand Piano", toolSynthOptions: { swing: 60 } });
    expect(opts.fadeLength).toBe(NOTE_FADE_MS);
    expect(NOTE_FADE_MS).toBeGreaterThan(200); // abcjs's default
  });
});

describe("widget wiring", () => {
  const read = (file: string) =>
    readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), "utf8");
  const ABC = read("mcp-app.ts");

  it("routes playback through the room after every go()", () => {
    expect(ABC).toMatch(/onReady\(controller\?: unknown\) \{\s*followSwing\(controller\);\s*routeRoom\(controller\);/);
  });

  it("renders the room into the WAV when it is on", () => {
    expect(ABC).toContain(
      "const rendered = liveRoom.isEnabled ? await renderWithRoom(audioBuffer) : audioBuffer;",
    );
    expect(ABC).toContain("audioBufferToWavBase64(rendered)");
  });

  it("the lit Room button keeps a readable label", () => {
    // A rule of its own once set its text to --color-primary, the colour of
    // the pressed background: a blank blue box. It must use the shared
    // pressed style (white on primary), like Edit.
    const css = read("mcp-app.css");
    expect(css).not.toMatch(/\.room-btn\[aria-pressed="true"\]\s*\{[^}]*color:\s*var\(--color-primary\)/);
    expect(css).toMatch(/\.toolbar-btn\[aria-pressed="true"\]\s*\{[^}]*background:\s*var\(--color-primary\);[^}]*color:\s*#ffffff/);
    expect(ABC).toContain('roomBtn.className = "toolbar-btn toolbar-btn-text room-btn";');
  });

  it("the share page gets the same release", () => {
    expect(read("browser-fallback.ts")).toContain("fadeLength: ${NOTE_FADE_MS}");
  });
});
