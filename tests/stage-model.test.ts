// What the Stage shows, as data (src/stage/stage-model.ts) and the figures'
// note → part maps (src/stage/figures.ts): who plays, on which figure, what
// lights at a moment, where a finger goes.
import ABCJS from "abcjs";
import { describe, expect, it } from "vitest";
import {
  assignStops,
  bowed,
  clarinet,
  drumKit,
  flute,
  drumPiece,
  fluteKeys,
  FLUTE_FINGERING,
  grandPiano,
  guitar,
  keyRange,
  whistle,
} from "../src/stage/figures";
import { CLARINET, FLUTE, pitchForKey, fingeringFor, type FingeringChart } from "../src/stage/fingerings";
import {
  DRUMS,
  MIN_LIT_SECONDS,
  figureFor,
  momentAt,
  noteMapFromSequence,
  playersFrom,
  programOf,
  shortName,
  type MapNote,
} from "../src/stage/stage-model";
import { buildStage } from "../src/stage/room";
import { renderScene } from "../src/stage/iso";

describe("who plays on which figure", () => {
  it("draws each GM family on its figure, and anything else on a keyboard", () => {
    expect(figureFor(0)).toBe("grand");
    expect(figureFor(4)).toBe("keys");
    expect(figureFor(12)).toBe("mallets");
    expect(figureFor(24)).toBe("guitar");
    expect(figureFor(27)).toBe("guitar");
    expect(figureFor(33)).toBe("ebass");
    expect(figureFor(32)).toBe("bowed"); // the acoustic bass is the upright
    expect(figureFor(40)).toBe("bowed");
    expect(figureFor(42)).toBe("bowed");
    expect(figureFor(48)).toBe("bowed");
    expect(figureFor(71)).toBe("clarinet");
    expect(figureFor(73)).toBe("flute");
    expect(figureFor(78)).toBe("whistle");
    expect(figureFor(56)).toBe("keys"); // trumpet: no figure yet
    expect(figureFor(DRUMS)).toBe("drums");
  });

  it("reads abcjs's instrument names back to GM programs", () => {
    expect(programOf("acoustic_grand_piano")).toBe(0);
    expect(programOf("flute")).toBe(73);
    expect(programOf("percussion")).toBe(DRUMS);
    expect(programOf(42)).toBe(42);
  });

  it("puts one word on a name tag", () => {
    expect(shortName("Acoustic Grand Piano")).toBe("Piano");
    expect(shortName("Electric Bass (finger)")).toBe("Bass");
    expect(shortName("Acoustic Guitar (nylon)")).toBe("Guitar");
    expect(shortName("String Ensemble")).toBe("Strings");
    expect(shortName("Choir Aahs")).toBe("Voices");
  });
});

describe("players from abcjs's audio", () => {
  it("flattens a sequence like create-note-map.js: program events, per-note instruments, the gap", () => {
    const tracks = noteMapFromSequence([
      [
        { cmd: "program", instrument: 40 },
        { cmd: "note", pitch: 67, start: 0, duration: 0.25, volume: 90, gap: 0.03 },
        { cmd: "note", pitch: 69, start: 0.25, duration: 0.25, volume: 90, instrument: 73 },
        { cmd: "text" },
      ],
    ]);
    expect(tracks[0]).toEqual([
      { pitch: 67, instrument: 40, start: 0, end: 0.22, volume: 90 },
      { pitch: 69, instrument: 73, start: 0.25, end: 0.5, volume: 90 },
    ]);
  });

  it("groups by instrument in order of first appearance, in seconds, with ranges", () => {
    const n = (pitch: number, instrument: number | string, start: number, end: number, volume = 90): MapNote => ({ pitch, instrument, start, end, volume });
    const players = playersFrom([[n(72, "flute", 0.5, 0.75), n(74, "flute", 0, 0.25)], [n(36, "percussion", 0, 0.125)]], 2);
    expect(players.map((p) => [p.id, p.figure, p.low, p.high])).toEqual([["flute", "flute", 72, 74], ["percussion", "drums", 36, 36]]);
    expect(players[0].notes.map((x) => x.start)).toEqual([0, 1]); // sorted, seconds
  });

  it("remembers which tracks each player's notes come from (Join mutes those voices)", () => {
    const n = (pitch: number, instrument: number | string): MapNote => ({ pitch, instrument, start: 0, end: 0.25, volume: 90 });
    const players = playersFrom([[n(72, "flute")], [n(48, "cello")], [n(76, "flute")]], 2);
    expect(players.map((p) => [p.id, p.tracks])).toEqual([["flute", [0, 2]], ["cello", [1]]]);
  });

  it("reads a real tune: the voices and a style's chords, bass and drums", () => {
    const [tune] = ABCJS.parseOnly("X:1\nM:4/4\nL:1/4\nK:C\n%%MIDI program 73\n%%MIDI gchord fzcz\n%%MIDI chordprog 24\n%%MIDI bassprog 33\n%%MIDI drumon\n%%MIDI drum dddd 36 42 38 42 90 70 100 70\n\"C\"c d e f|\"G\"g a b c'|]");
    const flat = tune.setUpAudio({}) as unknown as { tracks: Record<string, unknown>[][] };
    const players = playersFrom(noteMapFromSequence(flat.tracks), 2);
    expect(players.map((p) => p.figure).sort()).toEqual(["drums", "ebass", "flute", "guitar"]);
  });
});

describe("a moment", () => {
  const player = playersFrom([[
    { pitch: 60, instrument: 0, start: 0, end: 1, volume: 90 },
    { pitch: 64, instrument: 0, start: 0.5, end: 0.55, volume: 90 },
    { pitch: 67, instrument: 0, start: 1, end: 2, volume: 0 },
    { pitch: 72, instrument: 0, start: 1.6, end: 2, volume: 90 },
  ]], 1)[0];

  it("lights what sounds, keeps a staccato note lit long enough to see", () => {
    expect(momentAt(player, 0.2).on).toEqual([60]);
    expect(momentAt(player, 0.5 + MIN_LIT_SECONDS - 0.01).on.sort()).toEqual([60, 64]);
  });

  it("shows a muted voice's notes as yours, and what starts within the lookahead as next", () => {
    const m = momentAt(player, 1.2, 0.5);
    expect(m.on).toEqual([]);
    expect(m.yours).toEqual([67]);
    expect(m.next).toEqual([72]);
    expect(momentAt(player, 1.2).next).toEqual([]);
  });

  it("counts notes started, so a bow can turn round on each", () => {
    expect(momentAt(player, 0.2).started).toBe(1);
    expect(momentAt(player, 1.7).started).toBe(4);
  });
});

describe("figures map notes to parts", () => {
  it("keeps keyboards to whole octaves, two at least", () => {
    expect(keyRange(60, 64)).toEqual([48, 72]);
    expect(keyRange(40, 90, 4)[1] - keyRange(40, 90, 4)[0]).toBe(48);
  });

  it("gives a grand all 88 keys and folds out-of-range notes onto them", () => {
    const piano = grandPiano(48, 84);
    expect(piano.parts.filter((p) => p.key).length).toBe(88);
    expect(piano.light([10])).toEqual(["k22"]);
    expect(piano.pitchOf("k61")).toBe(61);
  });

  it("maps GM drum notes to pieces and back", () => {
    expect(drumPiece(36)).toBe("kick");
    expect(drumPiece(42)).toBe("hat");
    expect(drumPiece(49)).toBe("crash");
    const kit = drumKit();
    expect(kit.light([36, 38, 42, 42])).toEqual(["d:kick", "d:snare", "d:hat"]);
    expect(kit.pitchOf("d:snare")).toBe(38);
  });

  it("stops a guitar chord the way a teacher would show it first", () => {
    // C major in first position: C on the A string 3rd fret, E open, G open.
    const stops = assignStops([48, 52, 55], [40, 45, 50, 55, 59, 64], 12);
    expect(stops).toContainEqual({ string: 1, fret: 3 });
    expect(stops).toContainEqual({ string: 2, fret: 2 });
    expect(stops).toContainEqual({ string: 3, fret: 0 });
    const g = guitar(false);
    expect(g.light([52])).toEqual(["s2", "s2f2"]);
    expect(g.pitchOf("s0f5")).toBe(45);
  });

  it("places what it can of a chord that needs one string twice (reviewer: G7 on a cello went dark)", () => {
    // abcjs voices G7 at G3 B3 D4 F4; on a cello (C G D A) F4 and D4 both want the A string.
    const g7 = assignStops([55, 59, 62, 65], [36, 43, 50, 57], 14);
    expect(g7).toHaveLength(3);
    expect(new Set(g7.map((s) => s.string)).size).toBe(3);
    // E2 and F2 both live only on a guitar's low E string: one of them shows.
    expect(assignStops([40, 41], [40, 45, 50, 55, 59, 64], 12)).toHaveLength(1);
    expect(bowed("cello").light([55, 59, 62, 65]).length).toBeGreaterThan(0);
  });

  it("fingers a whistle in D: all holes for D, cross-fingered C, half-holed F", () => {
    expect(FLUTE_FINGERING[0]).toBe("xxxxxx");
    expect(fluteKeys(62)).toEqual(["blow", "h0", "h1", "h2", "h3", "h4", "h5"]);
    expect(fluteKeys(72)).toEqual(["blow", "h1", "h2"]);
    expect(fluteKeys(65)).toEqual(["blow", "h0", "h1", "h2", "h3", "h4h"]);
    expect(fluteKeys(74)).toContain("oct");
    const w = whistle();
    expect(w.pitchOf("h2")).toBe(67); // three holes down: G
    expect(w.pitchOf("blow")).toBe(73);
  });

  it("reads a keyed woodwind's chart: unverified notes show no fingering", () => {
    const chart: FingeringChart = { instrument: "t", writtenOffset: 2, keys: ["T", "L1"], sequence: ["T", "L1"], held: [], chart: { 67: [], 60: ["T", "L1"], 62: ["T"] } };
    expect(fingeringFor(chart, 65)).toEqual([]); // written 67: open G, no keys
    expect(fingeringFor(chart, 61)).toBeNull();
  });

  it("plays what a learner expects when one key is pressed", () => {
    // Clarinet: a main hole closes itself and every hole above it.
    expect(pitchForKey(CLARINET, "T")).toBe(63); // written F4 → sounding E♭4
    expect(pitchForKey(CLARINET, "L3")).toBe(58); // T123: written C4
    expect(pitchForKey(CLARINET, "R3")).toBe(53); // all six: written G3
    expect(pitchForKey(CLARINET, "Reg")).toBe(68); // register key: written B♭4
    expect(pitchForKey(CLARINET, "RP_F")).toBe(51); // right pinky F/C: written F3, not the E3 that also uses it
    expect(pitchForKey(CLARINET, "")).toBe(65); // nothing pressed: open G
    // Flute: the same, with the right pinky's E♭ held as usual.
    expect(pitchForKey(FLUTE, "L3")).toBe(67); // G4, not the third-octave D6 that also uses L3
    expect(pitchForKey(FLUTE, "R3")).toBe(62); // all six down: D4 (E♭ up)
    expect(pitchForKey(FLUTE, "Gs")).toBe(68);
    expect(pitchForKey(FLUTE, "")).toBe(73); // E♭ alone: C♯5
  });

  it("holds the verified charts to their basic shapes", () => {
    expect(Object.keys(FLUTE.chart)).toHaveLength(37);
    expect(Object.keys(CLARINET.chart)).toHaveLength(33);
    expect(FLUTE.chart[62]).not.toContain("Eb"); // low D: E♭ key up (D♯ with it)
    expect(CLARINET.chart[55]).toEqual(["T", "L1", "L2", "L3", "R1", "R2", "R3"]); // G3: no pinkies
    // The clarinet overblows a twelfth: clarion = chalumeau + register key.
    for (let w = 71; w <= 84; w++) expect([...CLARINET.chart[w]].sort()).toEqual([...CLARINET.chart[w - 19], "Reg"].sort());
    // Every key a chart uses is drawn on its figure.
    for (const [chart, fig] of [[FLUTE, flute()], [CLARINET, clarinet()]] as const) {
      const drawn = new Set(fig.parts.map((p) => p.key));
      for (const k of chart.keys) expect(drawn.has(k), `${chart.instrument}: ${k}`).toBe(true);
    }
  });
});

describe("the room", () => {
  it("lays a band out with no two figures overlapping on the floor", () => {
    const n = (pitch: number, instrument: number): MapNote => ({ pitch, instrument, start: 0, end: 1, volume: 90 });
    const players = playersFrom([[n(72, 73)], [n(60, 71)], [n(76, 40)], [n(48, 42)], [n(60, 0)], [n(36, 128)]], 1);
    const { placed } = buildStage(players, "Test");
    for (const a of placed) for (const b of placed) {
      if (a === b) continue;
      const apart = a.offset[0] + a.figure.size[0] <= b.offset[0] + 0.01 || b.offset[0] + b.figure.size[0] <= a.offset[0] + 0.01 ||
        a.offset[1] + a.figure.size[1] <= b.offset[1] + 0.01 || b.offset[1] + b.figure.size[1] <= a.offset[1] + 0.01;
      expect(apart, `${a.player.id} / ${b.player.id}`).toBe(true);
    }
    expect(placed.map((p) => p.player.id)).toEqual(players.map((p) => p.id)); // players' order kept
  });

  it("draws the shipped band (perspective on) with every pressable part and no NaN", () => {
    const n = (pitch: number, instrument: number): MapNote => ({ pitch, instrument, start: 0, end: 1, volume: 90 });
    const players = playersFrom([[n(72, 73)], [n(60, 71)], [n(76, 40)], [n(48, 42)], [n(60, 0), n(84, 0)], [n(36, 128)]], 1);
    const { scene, placed } = buildStage(players, "Test");
    expect(scene.eye).toBeGreaterThan(0);
    const { svg } = renderScene(scene, 0);
    expect(svg).not.toContain("NaN");
    for (const p of placed) {
      const keys = new Set(p.figure.parts.filter((x) => x.key).map((x) => x.key));
      for (const k of keys) expect(svg.includes(`data-k="${k}"`), `${p.player.id}: ${k}`).toBe(true);
    }
  });
});
