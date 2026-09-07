import { readFileSync } from "node:fs";
import { Scale } from "tonal";
import { describe, expect, it } from "vitest";
import {
  analyzeHarmony,
  CHORD_SCALE_NAMES,
  friendlyChordSymbol,
  HARMONY_TASKS,
  keyMaterial,
  normalizeRomanNumeral,
  parseKeyName,
  scoreKeys,
  strudelScaleName,
} from "../src/shared/harmony";
import { handleAnalyzeHarmony } from "../server";

describe("friendlyChordSymbol", () => {
  it("spells chords the way lead sheets and ABC do", () => {
    expect(friendlyChordSymbol("CM")).toBe("C");
    expect(friendlyChordSymbol("CM7")).toBe("Cmaj7");
    expect(friendlyChordSymbol("Cmaj7")).toBe("Cmaj7");
    expect(friendlyChordSymbol("Am7")).toBe("Am7");
    expect(friendlyChordSymbol("Bdim")).toBe("Bdim");
    expect(friendlyChordSymbol("G7")).toBe("G7");
  });

  it("keeps slash bass notes", () => {
    expect(friendlyChordSymbol("F6/D")).toBe("F6/D");
  });

  it("passes unparseable input through untouched", () => {
    expect(friendlyChordSymbol("not-a-chord")).toBe("not-a-chord");
  });
});

describe("parseKeyName", () => {
  it("reads the spellings a model is likely to send", () => {
    expect(parseKeyName("C")).toMatchObject({ tonic: "C", mode: "major" });
    expect(parseKeyName("A minor")).toMatchObject({ tonic: "A", mode: "minor" });
    expect(parseKeyName("F# major")).toMatchObject({ tonic: "F#", mode: "major" });
    expect(parseKeyName("bbm")).toMatchObject({ tonic: "Bb", mode: "minor" });
    expect(parseKeyName("Eb")).toMatchObject({ tonic: "Eb", mode: "major" });
  });

  it("does not mistake 'major' for 'minor'", () => {
    expect(parseKeyName("C major")?.mode).toBe("major");
    expect(parseKeyName("Cmaj")?.mode).toBe("major");
  });

  it("rejects nonsense", () => {
    expect(parseKeyName("H")).toBeNull();
    expect(parseKeyName("")).toBeNull();
    expect(parseKeyName("hello")).toBeNull();
  });
});

describe("scoreKeys", () => {
  it("puts C major first for the C major scale", () => {
    const ranked = scoreKeys(["C", "D", "E", "F", "G", "A", "B"]);
    expect(ranked[0]?.name).toBe("C major");
    expect(ranked[0]?.matched).toBe(7);
  });

  it("finds A minor from a harmonic-minor melody", () => {
    const ranked = scoreKeys(["A", "B", "C", "D", "E", "F", "G#"]);
    expect(ranked[0]?.name).toBe("A minor");
  });

  it("finds Bb major from its own scale", () => {
    const ranked = scoreKeys(["Bb", "C", "D", "Eb", "F", "G", "A"]);
    expect(ranked[0]?.name).toBe("Bb major");
  });

  it("only offers conventionally spelled minor tonics", () => {
    const minors = scoreKeys(["C"])
      .filter((k) => k.mode === "minor")
      .map((k) => k.tonic);
    expect(minors).not.toContain("Db");
    expect(minors).toContain("C#");
  });

  it("returns something for empty input rather than throwing", () => {
    expect(scoreKeys([]).length).toBe(24);
  });
});

describe("normalizeRomanNumeral", () => {
  // tonal reads "ii7" literally as "degree 2, dominant 7th" (D7 in C).
  it("gives lowercase numerals their minor quality", () => {
    expect(normalizeRomanNumeral("ii7")).toBe("iim7");
    expect(normalizeRomanNumeral("vi")).toBe("vim");
    expect(normalizeRomanNumeral("bVII")).toBe("bVII");
  });

  it("leaves an explicit quality alone", () => {
    expect(normalizeRomanNumeral("iim7b5")).toBe("iim7b5");
    expect(normalizeRomanNumeral("viidim")).toBe("viidim");
    expect(normalizeRomanNumeral("Imaj7")).toBe("Imaj7");
    expect(normalizeRomanNumeral("V7")).toBe("V7");
  });
});

describe("keyMaterial", () => {
  it("builds the diatonic set for C major", () => {
    const material = keyMaterial({ tonic: "C", mode: "major", name: "C major" })!;
    expect(material.triads).toEqual(["C", "Dm", "Em", "F", "G", "Am", "Bdim"]);
    expect(material.sevenths).toEqual([
      "Cmaj7",
      "Dm7",
      "Em7",
      "Fmaj7",
      "G7",
      "Am7",
      "Bm7b5",
    ]);
  });

  it("builds the natural-minor set for A minor", () => {
    const material = keyMaterial({ tonic: "A", mode: "minor", name: "A minor" })!;
    expect(material.scale).toEqual(["A", "B", "C", "D", "E", "F", "G"]);
    expect(material.sevenths[0]).toBe("Am7");
  });
});

describe("analyzeHarmony — detect-chord", () => {
  it("names a major seventh and suggests where to go next", () => {
    const text = analyzeHarmony({
      task: "detect-chord",
      notes: ["c4", "e4", "g4", "b4"],
    });
    expect(text).toContain("Cmaj7");
    expect(text).toContain("C E G B");
    expect(text).toContain("Fits keys: C major");
    expect(text).toContain("Try next");
    expect(text).toContain('chord("Cmaj7").voicing()');
    expect(text).toContain('ABC chord symbol: "Cmaj7"');
  });

  it("reads Dm7 as ii of C major, not vi of F major", () => {
    const text = analyzeHarmony({
      task: "detect-chord",
      notes: ["d4", "f4", "a4", "c5"],
    });
    expect(text).toContain("Dm7");
    expect(text).toContain("Try next (in C major): G7, Am7, Bm7b5.");
  });

  it("spells the Strudel voicing ascending", () => {
    const text = analyzeHarmony({
      task: "detect-chord",
      notes: ["d4", "f4", "a4", "c5"],
    });
    expect(text).toContain('note("d4 f4 a4 c5")');
  });

  it("explains itself when no chord matches", () => {
    const text = analyzeHarmony({ task: "detect-chord", notes: ["c4", "c#4"] });
    expect(text).toContain("No standard chord matches");
    expect(text).not.toContain("undefined");
  });

  it("asks for more notes instead of throwing", () => {
    expect(analyzeHarmony({ task: "detect-chord" })).toContain("at least 2 notes");
    expect(analyzeHarmony({ task: "detect-chord", notes: ["c4"] })).toContain(
      "at least 2 notes",
    );
  });

  it("handles garbage note names", () => {
    const text = analyzeHarmony({ task: "detect-chord", notes: ["zz", "qq"] });
    expect(text).toContain("Could not read");
  });
});

describe("analyzeHarmony — detect-key", () => {
  it("hears ii-V-I as C major", () => {
    const text = analyzeHarmony({
      task: "detect-key",
      chords: ["Dm7", "G7", "Cmaj7"],
    });
    expect(text).toContain("Best key: C major");
    expect(text).toContain("ABC key field: K:C");
    expect(text).toContain('scale("C:major")');
  });

  it("hears a raised leading tone as minor", () => {
    const text = analyzeHarmony({
      task: "detect-key",
      notes: ["a4", "b4", "c5", "d5", "e5", "f5", "g#5"],
    });
    expect(text).toContain("Best key: A minor");
    expect(text).toContain("ABC key field: K:Am");
  });

  it("needs some input", () => {
    expect(analyzeHarmony({ task: "detect-key" })).toContain("needs notes or chords");
  });

  it("says so when nothing was readable", () => {
    const text = analyzeHarmony({ task: "detect-key", chords: ["???", "!!!"] });
    expect(text).toContain("Could not read");
  });
});

describe("analyzeHarmony — suggest-progression", () => {
  it("offers stock progressions when no numerals are given", () => {
    const text = analyzeHarmony({ task: "suggest-progression", key: "C" });
    expect(text).toContain("ii-V-I (jazz cadence): Dm7 G7 Cmaj7");
    expect(text).toContain("I-V-vi-IV (pop): C G Am F");
    expect(text).toContain('chord("<Dm7 G7 Cmaj7>").voicing()');
  });

  it("renders supplied roman numerals with minor quality intact", () => {
    const text = analyzeHarmony({
      task: "suggest-progression",
      key: "C",
      romanNumerals: ["ii7", "V7", "Imaj7"],
    });
    expect(text).toContain("Dm7 G7 Cmaj7");
    expect(text).toContain('ABC: "Dm7" "G7" "Cmaj7"');
  });

  it("works in minor", () => {
    const text = analyzeHarmony({ task: "suggest-progression", key: "A minor" });
    expect(text).toContain("Key: A minor");
    expect(text).toContain("Bm7b5");
  });

  it("rejects an unreadable key kindly", () => {
    expect(analyzeHarmony({ task: "suggest-progression", key: "H" })).toContain(
      "Could not read the key",
    );
    expect(analyzeHarmony({ task: "suggest-progression" })).toContain("needs a key");
  });
});

describe("analyzeHarmony — scale-for-chord", () => {
  it("maps each chord quality to its chord scale", () => {
    const text = analyzeHarmony({
      task: "scale-for-chord",
      chords: ["Dm7", "G7", "Cmaj7", "Bm7b5"],
    });
    expect(text).toContain("D dorian");
    expect(text).toContain("G mixolydian");
    expect(text).toContain("C major");
    expect(text).toContain("B locrian");
    expect(text).toContain('scale("D:dorian")');
  });

  it("skips unreadable chords but still answers", () => {
    const text = analyzeHarmony({
      task: "scale-for-chord",
      chords: ["G7", "nonsense"],
    });
    expect(text).toContain("G mixolydian");
    expect(text).toContain("Ignored unreadable chords: nonsense.");
  });

  it("needs chords", () => {
    expect(analyzeHarmony({ task: "scale-for-chord" })).toContain("needs chords");
  });

  // Regression: the Strudel line used to be built with `scaleName.replace(/ .*/, "")`,
  // which truncated "whole tone" → "whole" (no such scale) and the printed notes
  // came from names tonal never knew ("diminished (whole-half)").
  it("prints real notes and a colon-spelled Strudel scale for the exotic qualities", () => {
    const text = analyzeHarmony({
      task: "scale-for-chord",
      chords: ["Caug", "Cdim7", "Calt7"],
    });
    expect(text).toContain("C whole tone: C D E F# G# A#");
    expect(text).toContain('scale("C:whole:tone")');
    expect(text).toContain("C whole-half diminished: C D Eb F Gb Ab A B");
    expect(text).toContain('scale("C:whole-half:diminished")');
    expect(text).toContain("C altered:");
    expect(text).toContain('scale("C:altered")');
    expect(text).not.toContain("whole)");
    expect(text).not.toContain('scale("C:whole")');
  });
});

describe("scale names are real in BOTH tonals", () => {
  // Strudel's `.scale("C:whole:tone")` does `name.replaceAll(":", " ")` and hands
  // the result to the tonal copy bundled in @strudel/repl — an OLDER tonal than
  // ours (it spells a few scales differently, e.g. `neopolitan`). A name we emit
  // has to resolve in our tonal AND appear in the pinned bundle's list.
  const strudelNames: Set<string> = new Set(
    (
      JSON.parse(
        readFileSync(new URL("./fixtures/strudel-scale-names.json", import.meta.url), "utf-8"),
      ) as { names: string[] }
    ).names,
  );

  it.each(CHORD_SCALE_NAMES)("%s resolves in tonal and exists in the Strudel bundle", (name) => {
    expect(Scale.get(`C ${name}`).empty).toBe(false);
    expect(strudelNames.has(name)).toBe(true);
    // Round-trip through the colon spelling Strudel actually receives.
    expect(Scale.get(`C ${strudelScaleName(name).replaceAll(":", " ")}`).empty).toBe(false);
  });

  it("every scale name analyze-harmony can print survives both", () => {
    // Sweep the whole surface: one chord per CHORD_SCALE_BY_TYPE branch plus the
    // chord-scale column of key-chords, then scrape the emitted names back out.
    const texts = [
      analyzeHarmony({
        task: "scale-for-chord",
        chords: [
          "Cm7b5",
          "Cdim7",
          "Cdim",
          "Caug",
          "C7b9",
          "Calt7",
          "C7",
          "Cmaj7",
          "C6",
          "Cm7",
          "Cm6",
          "Csus4",
          "Cm",
          "C",
        ],
      }),
      analyzeHarmony({ task: "key-chords", key: "C" }),
      analyzeHarmony({ task: "key-chords", key: "A minor" }),
      analyzeHarmony({ task: "detect-key", chords: ["Dm7", "G7", "Cmaj7"] }),
    ].join("\n");

    const emitted = [...texts.matchAll(/scale\("[A-G][b#]?:([^"]+)"\)/g)].map((m) => m[1]!);
    expect(emitted.length).toBeGreaterThan(5);
    for (const colonName of new Set(emitted)) {
      const spaced = colonName.replaceAll(":", " ");
      expect(Scale.get(`C ${spaced}`).empty, `tonal: ${spaced}`).toBe(false);
      expect(strudelNames.has(spaced), `strudel bundle: ${spaced}`).toBe(true);
    }
  });
});

describe("analyzeHarmony — key-chords", () => {
  it("lists every degree of F# major", () => {
    const text = analyzeHarmony({ task: "key-chords", key: "F# major" });
    expect(text).toContain("Key: F# major");
    expect(text).toContain("F#maj7");
    expect(text).toContain("C#7");
    expect(text).toContain("ABC key field: K:F#");
    for (const roman of ["I", "ii", "iii", "IV", "V", "vi", "vii°"]) {
      expect(text).toContain(roman);
    }
  });

  it("uses the minor roman numerals for a minor key", () => {
    const text = analyzeHarmony({ task: "key-chords", key: "A minor" });
    expect(text).toContain("ABC key field: K:Am");
    expect(text).toContain("III");
    expect(text).toContain("Am7");
  });
});

describe("analyzeHarmony — robustness", () => {
  it("never throws on an unknown task", () => {
    // deliberately off-schema, as a defensive client might send
    const text = analyzeHarmony({ task: "nope" as never });
    expect(text).toContain("Unknown task");
  });

  it("never throws on undefined input", () => {
    const text = analyzeHarmony(undefined as never);
    expect(text).toContain("Unknown task");
  });

  it("covers all five declared tasks", () => {
    expect(HARMONY_TASKS).toHaveLength(5);
    for (const task of HARMONY_TASKS) {
      const text = analyzeHarmony({ task });
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain("Unknown task");
    }
  });
});

describe("analyze-harmony handler", () => {
  it("wraps the analysis in a non-error text result", async () => {
    const result = await handleAnalyzeHarmony({
      task: "detect-chord",
      notes: ["c4", "e4", "g4"],
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain("C ");
  });

  it("returns help text rather than an error for missing arguments", async () => {
    const result = await handleAnalyzeHarmony({ task: "detect-chord" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("at least 2 notes");
  });
});
