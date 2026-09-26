import { describe, expect, it } from "vitest";
import ABCJS from "abcjs";
import { ABC_GUIDES } from "../src/abc-guide";

interface AudioEvent {
  cmd: string;
  instrument?: number;
  pitch?: number;
  volume?: number;
}

function sequence(directives: string, body = "C D E F |") {
  const tune = ABCJS.parseOnly(["X:1", "M:4/4", "L:1/4", "K:C", directives, body]
    .filter(Boolean).join("\n"))[0];
  expect((tune as unknown as { warnings?: string[] }).warnings ?? []).toEqual([]);
  const audio = tune.setUpAudio({}) as { tracks: AudioEvent[][] };
  return audio.tracks.flat().filter((event) => event.cmd === "note");
}

const drums = [...new Set(Object.values(ABC_GUIDES).flatMap((text) =>
  text.match(/^%%MIDI drum [dz][dz\d/]* [\d ]+$/gm) ?? [],
))];

describe("ABC guide directives reach playable audio events", () => {
  it("extracts all eight drum recipes", () => {
    expect(drums).toHaveLength(8);
  });

  it.each(drums)("%s produces the advertised drum hits", (directive) => {
    // Parsing alone accepts rest placeholders, but abcjs's audio flattener
    // silently drops the entire drum track when their argument count is wrong.
    const tokens = directive.replace("%%MIDI drum ", "").split(/\s+/);
    const count = [...tokens[0]].filter((character) => character === "d").length;
    const notes = sequence(`%%MIDI drumon\n${directive}`)
      .filter((event) => event.instrument === 128);
    expect(notes).toHaveLength(count);
    expect(notes.map((event) => event.pitch)).toEqual(tokens.slice(1, count + 1).map(Number));
    expect(notes.map((event) => event.volume)).toEqual(tokens.slice(count + 1).map(Number));
    expect(notes.every((event) => Number.isFinite(event.volume) && event.volume! > 0)).toBe(true);
  });

  it("the concrete beat example parses and controls audible velocities", () => {
    const example = ABC_GUIDES["midi-directives"].match(/^%%MIDI beat \d+ \d+ \d+ \d+$/m)?.[0];
    expect(example).toBeDefined();
    const notes = sequence(example!, "C/ D/ E/ F/ G/ A/ B/ c/ |");
    const [first, strong, weak] = example!.replace("%%MIDI beat ", "").split(/\s+/).map(Number);
    expect(notes.map((event) => event.volume)).toEqual([
      first, weak, strong, weak, strong, weak, strong, weak,
    ]);
  });

  it("the octave examples agree with the emitted MIDI pitches", () => {
    const example = ABC_GUIDES["abc-syntax"].match(/^C D E F G A B\s+%.*$/m)?.[0];
    expect(example).toContain("C4, MIDI 60");
    expect(sequence("", `${example!.split("%")[0]} c |`).map((event) => event.pitch))
      .toEqual([60, 62, 64, 65, 67, 69, 71, 72]);
  });
});
