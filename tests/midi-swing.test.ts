/**
 * @file What the MIDI export is NOT — the measurements behind its label.
 *
 * The widget's MIDI button says "Score MIDI (no swing)". These tests are why:
 * abcjs applies swing in `create-synth.js addSwing()` during `prime()`, on the
 * already-flattened event list, while `getMidiFile()` goes through
 * `abc_midi_create.js` and never sees it. Rather than reimplement abcjs's
 * timing model in the exporter, the difference is measured here and stated in
 * the UI. If a future abcjs starts honouring swing in the writer, these fail —
 * which is the signal to drop the disclaimer.
 */
import { describe, expect, it } from "vitest";
import ABCJS from "abcjs";

const ABC = `X:1
T:Swing probe
M:4/4
L:1/8
Q:1/4=120
K:C
CDEF GABc | cBAG FEDC |
`;

const parse = () => ABCJS.parseOnly(ABC)[0];

function midiBytes(options: Record<string, unknown>): Buffer {
  return Buffer.from(
    ABCJS.synth.getMidiFile(parse(), {
      midiOutputType: "binary",
      ...options,
    }) as Uint8Array,
  );
}

/** Note start times from the same flatten step the synth uses. */
function noteStarts(options: Record<string, unknown>): number[] {
  const flat = parse().setUpAudio(options) as {
    tracks: { cmd: string; start?: number }[][];
  };
  return flat.tracks[0]
    .filter((e) => e.cmd === "note")
    .map((e) => e.start ?? -1);
}

describe("MIDI export ignores swing", () => {
  it("produces byte-identical files for straight and swung playback", () => {
    const straight = midiBytes({ swing: 0 });
    const swung = midiBytes({ swing: 66 });

    expect(straight.length).toBe(swung.length);
    expect(straight.equals(swung)).toBe(true);
  });

  it("is not a flattener difference either — swing lands later, in prime()", () => {
    expect(noteStarts({ swing: 66 })).toEqual(noteStarts({ swing: 0 }));
    // ...and the straight timing is exactly even eighths.
    expect(noteStarts({ swing: 66 }).slice(0, 4)).toEqual([0, 0.125, 0.25, 0.375]);
  });

  it("does honour a tempo written into the tune, so the file isn't inert", () => {
    // The contrast that makes the swing result meaningful: this parameter
    // DOES reach the writer, so byte-identity above is about swing, not about
    // getMidiFile ignoring its options.
    expect(midiBytes({ qpm: 200 }).equals(midiBytes({}))).toBe(false);
  });
});

describe("MIDI export ignores the transport's tempo warp", () => {
  it("has no input for it at all", () => {
    // SynthController.warp scales millisecondsPerMeasure inside the controller
    // (synth-controller.js go()); it never touches the tune, and
    // MidiFileOptions has no warp field. Nothing to pass, hence the label.
    const file = midiBytes({});
    expect(file.subarray(0, 4).toString("latin1")).toBe("MThd");
    expect(midiBytes({ warp: 200 }).equals(file)).toBe(true);
  });
});
