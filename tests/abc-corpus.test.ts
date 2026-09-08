/**
 * @file ABC corpus regression tests.
 *
 * Fixtures live in tests/fixtures/abc/ (see EXPECTATIONS.md for the intent of
 * each one). 01–09 must parse cleanly through abcjs; 10 is deliberately
 * malformed and must be rejected by the project's own validation path
 * (createPlaySheetMusicResult) rather than crashing.
 *
 * "Cleanly" uses the project's forgiving rule from src/server-logic.ts:
 * a warning is fatal only when it mentions "Expected", "Unknown" or "Error".
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ABCJS from "abcjs";
import type { TuneObject, VoiceItem } from "abcjs";
import { createPlaySheetMusicResult } from "../src/server-logic";
import { STYLE_PRESETS, applyStyleToAbc } from "../src/music-logic";

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "abc",
);

function loadFixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, `${name}.abc`), "utf8");
}

/** Mirrors the forgiving rule in src/server-logic.ts. */
function fatalWarnings(tune: TuneObject): string[] {
  const warnings = (tune as unknown as { warnings?: string[] }).warnings ?? [];
  return warnings
    .map((w) => String(w).replace(/<[^>]*>/g, ""))
    .filter(
      (m) =>
        m.includes("Expected") || m.includes("Unknown") || m.includes("Error"),
    );
}

/** All voice items across every staff line of a tune, flattened. */
function allVoiceItems(tune: TuneObject): VoiceItem[] {
  const items: VoiceItem[] = [];
  for (const line of tune.lines ?? []) {
    for (const staff of line.staff ?? []) {
      for (const voice of staff.voices ?? []) {
        items.push(...voice);
      }
    }
  }
  return items;
}

const VALID_FIXTURES = [
  "01-simple-melody",
  "02-multiple-voices",
  "03-tuplets",
  "04-repeats-endings",
  "05-lyrics",
  "06-chords-style",
  "07-meter-change",
  "08-ties-slurs-accidentals",
  "09-grace-dynamics",
] as const;

describe("ABC corpus — parse health (01–09)", () => {
  it.each(VALID_FIXTURES)("%s parses to one tune with no fatal warnings", (name) => {
    const tunes = ABCJS.parseOnly(loadFixture(name));

    expect(tunes).toHaveLength(1);
    const tune = tunes[0];
    expect(tune.lines?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(fatalWarnings(tune)).toEqual([]);
  });

  it.each(VALID_FIXTURES)("%s passes the server's validation path", (name) => {
    const result = createPlaySheetMusicResult(loadFixture(name));
    expect(result.isError).not.toBe(true);
  });
});

describe("ABC corpus — structural expectations", () => {
  it("02 has two simultaneous voices on one staff", () => {
    const tune = ABCJS.parseOnly(loadFixture("02-multiple-voices"))[0];
    const staves = (tune.lines ?? []).flatMap((line) => line.staff ?? []);
    expect(staves.length).toBeGreaterThanOrEqual(1);
    expect(staves[0].voices).toHaveLength(2);
    // Both voices carry notes, i.e. the second voice isn't an empty shell.
    for (const voice of staves[0].voices) {
      expect(voice.some((el) => el.el_type === "note")).toBe(true);
    }
  });

  it("03 produces triplet groupings, not plain eighths", () => {
    const tune = ABCJS.parseOnly(loadFixture("03-tuplets"))[0];
    const triplets = allVoiceItems(tune).filter(
      (el) => (el as { startTriplet?: number }).startTriplet !== undefined,
    );
    expect(triplets).toHaveLength(2);
    for (const el of triplets) {
      expect((el as { startTriplet?: number }).startTriplet).toBe(3);
    }
  });

  it("04 keeps the repeat bars and both endings", () => {
    const tune = ABCJS.parseOnly(loadFixture("04-repeats-endings"))[0];
    const bars = allVoiceItems(tune).filter((el) => el.el_type === "bar") as Array<
      VoiceItem & { type?: string; startEnding?: string }
    >;
    const types = bars.map((b) => b.type);
    expect(types).toContain("bar_left_repeat");
    expect(types).toContain("bar_right_repeat");
    const endings = bars
      .map((b) => b.startEnding)
      .filter((e): e is string => e !== undefined);
    expect(endings).toEqual(["1", "2"]);
  });

  it("05 attaches lyric syllables to notes, with a hyphenated divider", () => {
    const tune = ABCJS.parseOnly(loadFixture("05-lyrics"))[0];
    const notes = allVoiceItems(tune).filter(
      (el) => el.el_type === "note",
    ) as Array<
      VoiceItem & { lyric?: Array<{ syllable: string; divider: string }> }
    >;
    const withLyrics = notes.filter((n) => n.lyric && n.lyric.length > 0);
    expect(withLyrics).toHaveLength(8);
    expect(withLyrics[0].lyric?.[0].syllable).toBe("Small");
    // "a- cross" is the intentional syllabic split.
    expect(withLyrics.some((n) => n.lyric?.[0].divider === "-")).toBe(true);
  });

  it("07 changes meter mid-tune (4/4 → 3/4 → 6/8)", () => {
    const tune = ABCJS.parseOnly(loadFixture("07-meter-change"))[0];
    const inlineMeters = allVoiceItems(tune).filter(
      (el) => el.el_type === "meter",
    ) as Array<
      VoiceItem & { value?: Array<{ num: string; den: string }> }
    >;
    expect(inlineMeters).toHaveLength(2);
    const fractions = inlineMeters.map(
      (m) => `${m.value?.[0].num}/${m.value?.[0].den}`,
    );
    expect(fractions).toEqual(["3/4", "6/8"]);
  });

  it("09 keeps grace notes and dynamic decorations", () => {
    const tune = ABCJS.parseOnly(loadFixture("09-grace-dynamics"))[0];
    const notes = allVoiceItems(tune) as Array<
      VoiceItem & { gracenotes?: unknown[]; decoration?: string[] }
    >;
    expect(notes.some((n) => (n.gracenotes?.length ?? 0) === 2)).toBe(true);
    const decorations = notes.flatMap((n) => n.decoration ?? []);
    expect(decorations).toContain("p");
    expect(decorations).toContain("f");
  });
});

describe("ABC corpus — invalid input (10)", () => {
  it("is rejected by the server's validation, not by throwing", () => {
    const abc = loadFixture("10-invalid-input");

    // abcjs itself must not crash — it reports warnings instead.
    const tunes = ABCJS.parseOnly(abc);
    expect(tunes).toHaveLength(1);
    expect(fatalWarnings(tunes[0]).length).toBeGreaterThan(0);

    // ...and the project's validation path turns those into an isError result.
    const result = createPlaySheetMusicResult(abc);
    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("ABC notation has errors");
    // Warnings are stripped of abcjs's inline <span> markup before display.
    expect(text).not.toContain("<span");
  });
});

describe("ABC corpus — style preset injection", () => {
  it("06: directives land immediately after the K: line", () => {
    const abc = loadFixture("06-chords-style");
    const styled = applyStyleToAbc(abc, "jazz");

    const lines = styled.split("\n");
    const keyIndex = lines.findIndex((l) => l.startsWith("K:"));
    expect(keyIndex).toBeGreaterThanOrEqual(0);

    const preset = STYLE_PRESETS.jazz.split("\n");
    expect(lines.slice(keyIndex + 1, keyIndex + 1 + preset.length)).toEqual(
      preset,
    );

    // The fixture's own %%MIDI directives survive, after the injected preset.
    expect(styled).toContain("%%MIDI gchord fzcz");
    expect(styled).toContain('"Am"A2 c2 e2 c2');

    // Still parses, and still with no fatal warnings.
    const tune = ABCJS.parseOnly(styled)[0];
    expect(fatalWarnings(tune)).toEqual([]);
  });

  it("02: directives land after K: and before the voice music lines", () => {
    const styled = applyStyleToAbc(loadFixture("02-multiple-voices"), "rock");

    const keyPos = styled.indexOf("K:");
    const directivePos = styled.indexOf("%%MIDI drumon");
    const voicePos = styled.indexOf("[V:1]");

    expect(keyPos).toBeGreaterThanOrEqual(0);
    expect(directivePos).toBeGreaterThan(keyPos);
    expect(voicePos).toBeGreaterThan(directivePos);

    // The V: header declarations stay above K:, untouched.
    expect(styled.indexOf("V:1 clef=treble")).toBeLessThan(keyPos);
  });

  it("leaves the corpus untouched when no style is selected", () => {
    for (const name of VALID_FIXTURES) {
      const abc = loadFixture(name);
      expect(applyStyleToAbc(abc, "")).toBe(abc);
    }
  });
});
