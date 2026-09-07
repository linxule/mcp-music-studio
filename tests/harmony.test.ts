import { readFileSync } from "node:fs";
import { Scale } from "tonal";
import { describe, expect, it } from "vitest";
import {
  analyzeHarmony,
  asciiChordSymbol,
  CHORD_SCALE_NAMES,
  friendlyChordSymbol,
  HARMONY_TASKS,
  irealChordSymbol,
  IREAL_VOICING_SUFFIXES,
  isChordSymbol,
  KEY_MODES,
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
    // ABC spells it Cmaj7; Strudel's ireal voicing dictionary only knows C^7.
    expect(text).toContain('chord("C^7").voicing()');
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
    // Comma-separated inside one bracketed step — `note("d4 f4 a4 c5")` would
    // play the chord as an arpeggio, one note per quarter of the cycle.
    expect(text).toContain('note("[d4,f4,a4,c5]")');
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
    expect(text).toContain('chord("<Dm7 G7 C^7>").voicing()');
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

// =============================================================================
// Regressions the mechanical audit found (report section 5)
// =============================================================================

describe("H1 — the key suffix is read, not skimmed", () => {
  // The old parser tested `rest.startsWith("m")` and called everything else
  // major, so "garbage" was G major, "D dorian" was D major, "A aeolian" was A
  // major, and "Cmonsoon" was C minor.
  it("names the mode that was actually asked for", () => {
    expect(parseKeyName("D dorian")).toMatchObject({ tonic: "D", mode: "dorian" });
    expect(parseKeyName("G mixolydian")).toMatchObject({ tonic: "G", mode: "mixolydian" });
    expect(parseKeyName("E phrygian")).toMatchObject({ tonic: "E", mode: "phrygian" });
    expect(parseKeyName("F lydian")).toMatchObject({ tonic: "F", mode: "lydian" });
    expect(parseKeyName("B locrian")).toMatchObject({ tonic: "B", mode: "locrian" });
    // ionian and aeolian are major and minor under their other names
    expect(parseKeyName("C ionian")).toMatchObject({ tonic: "C", mode: "major" });
    expect(parseKeyName("A aeolian")).toMatchObject({ tonic: "A", mode: "minor" });
  });

  it("refuses a suffix it does not know", () => {
    for (const bad of ["garbage", "Cmonsoon", "D dorina", "C blues", "Ffoo", "Bbmajorish"]) {
      expect(parseKeyName(bad), bad).toBeNull();
    }
  });

  it("keeps the shorthands, case and all", () => {
    expect(parseKeyName("Cm")).toMatchObject({ mode: "minor" });
    expect(parseKeyName("Cmin")).toMatchObject({ mode: "minor" });
    expect(parseKeyName("CM")).toMatchObject({ mode: "major" });
    expect(parseKeyName("Cmaj")).toMatchObject({ mode: "major" });
    expect(parseKeyName("C")).toMatchObject({ mode: "major" });
  });

  it("tells the caller what a key may look like", () => {
    const text = analyzeHarmony({ task: "key-chords", key: "Cmonsoon" });
    expect(text).toContain('Could not read the key "Cmonsoon"');
    expect(text).toContain("dorian");
    expect(text).toContain("mixolydian");
  });

  it("builds the modal material, not the parallel major's", () => {
    const text = analyzeHarmony({ task: "key-chords", key: "D dorian" });
    expect(text).toContain("Key: D dorian");
    expect(text).toContain("Scale: D E F G A B C");
    // dorian's degree 1 is minor and its IV is dominant — that is the whole point
    expect(text).toContain("Dm7");
    expect(text).toContain("G7");
    expect(text).toContain("ABC key field: K:Ddor");
    expect(text).toContain('scale("D:dorian")');
  });

  it("reads the roman numerals off the triads, for every mode", () => {
    const romans = (key: string) => keyMaterial(parseKeyName(key)!)!.romans;
    expect(romans("C")).toEqual(["I", "ii", "iii", "IV", "V", "vi", "vii°"]);
    expect(romans("A minor")).toEqual(["i", "ii°", "III", "iv", "v", "VI", "VII"]);
    expect(romans("D dorian")).toEqual(["i", "ii", "III", "IV", "v", "vi°", "VII"]);
    expect(romans("G mixolydian")).toEqual(["I", "ii", "iii°", "IV", "v", "vi", "VII"]);
  });

  it("has material and an ABC spelling for every declared mode", () => {
    for (const mode of KEY_MODES) {
      const parsed = parseKeyName(`C ${mode}`);
      expect(parsed, mode).not.toBeNull();
      const material = keyMaterial(parsed!)!;
      expect(material.scale, mode).toHaveLength(7);
      expect(material.sevenths, mode).toHaveLength(7);
      expect(material.romans, mode).toHaveLength(7);
      expect(Scale.get(`C ${material.strudelScale}`).empty, mode).toBe(false);
      expect(analyzeHarmony({ task: "key-chords", key: `C ${mode}` }), mode).toContain(
        `Key: C ${mode}`,
      );
    }
  });
});

describe("H2 — the chord scale follows the chord's intervals", () => {
  const scaleFor = (chord: string) => {
    const line = analyzeHarmony({ task: "scale-for-chord", chords: [chord] }).split("\n")[0]!;
    return line.slice(line.indexOf("→ ") + 2).split(":")[0]!.trim();
  };

  it("hears the flat nine in a G7b9", () => {
    // tonal calls this type "dominant flat ninth", which no prose branch matched,
    // so it fell through to /dominant/ and was answered with G mixolydian — a
    // scale containing the very A the chord flattens.
    expect(scaleFor("G7b9")).toBe("G altered");
    expect(scaleFor("C7#9")).toBe("C altered");
    expect(scaleFor("C7b13")).toBe("C altered");
    expect(scaleFor("C7alt")).toBe("C altered");
    expect(scaleFor("Calt7")).toBe("C altered");
  });

  it("leaves an unaltered dominant on mixolydian", () => {
    expect(scaleFor("G7")).toBe("G mixolydian");
    expect(scaleFor("C13")).toBe("C mixolydian");
    expect(scaleFor("C7sus4")).toBe("C mixolydian");
  });

  it("separates the two sharp-eleven dominants", () => {
    expect(scaleFor("C7#11")).toBe("C lydian dominant");
    expect(scaleFor("C7b9#11")).toBe("C altered");
  });

  it("keeps the diminished family apart", () => {
    expect(scaleFor("Cdim7")).toBe("C whole-half diminished");
    expect(scaleFor("Cm7b5")).toBe("C locrian");
    expect(scaleFor("Cdim")).toBe("C locrian");
  });

  it("hears a minor triad with a major seventh as melodic minor", () => {
    expect(scaleFor("CmMaj7")).toBe("C melodic minor");
    expect(scaleFor("Cm7")).toBe("C dorian");
    expect(scaleFor("Cm6")).toBe("C dorian");
  });

  it("reads a slash chord from its root, not its bass", () => {
    // `Chord.get("C/G").intervals` is measured from the BASS (5P 8P 10M), so a
    // naive interval test finds no third at all.
    expect(scaleFor("C/G")).toBe("C major");
    expect(scaleFor("Cmaj7/E")).toBe("C major");
    expect(scaleFor("G7/B")).toBe("G mixolydian");
  });

  it("still answers for the plain triads", () => {
    expect(scaleFor("C")).toBe("C major");
    expect(scaleFor("Cm")).toBe("C dorian");
    expect(scaleFor("Caug")).toBe("C whole tone");
    expect(scaleFor("Cmaj7")).toBe("C major");
  });
});

describe("H3 — the Strudel snippets are ones Strudel can play", () => {
  it("prints a chord as one bracketed step, not an arpeggio", () => {
    // `note("c4 e4 g4")` is a SEQUENCE — three events, one per third of a cycle.
    const text = analyzeHarmony({ task: "detect-chord", notes: ["c4", "e4", "g4"] });
    expect(text).toContain('note("[c4,e4,g4]")');
    expect(text).not.toMatch(/note\("[a-g][#b]?\d [a-g]/);
  });

  it("brackets the fallback spelling when no chord matches either", () => {
    const text = analyzeHarmony({ task: "detect-chord", notes: ["c4", "c#4"] });
    expect(text).toContain('note("[c4,c#4]")');
  });

  describe("irealChordSymbol", () => {
    // Verified against the published @strudel/tonal@1.2.6 source: renderVoicing
    // does `dictionary[suffix]` — an exact lookup in ireal.mjs's `simple` table
    // plus the aliases voicings.mjs derives at import time. A miss is caught and
    // becomes `silence`, so a wrong spelling is a SILENT layer, not an error.
    it("respells the symbols the dictionary would otherwise miss", () => {
      expect(irealChordSymbol("Cmaj7")).toBe("C^7");
      expect(irealChordSymbol("Cmaj9")).toBe("C^9");
      expect(irealChordSymbol("Cmaj13")).toBe("C^13");
      expect(irealChordSymbol("Cdim")).toBe("Co");
      expect(irealChordSymbol("Cdim7")).toBe("Co7");
      expect(irealChordSymbol("Csus4")).toBe("Csus");
      expect(irealChordSymbol("Csus2")).toBe("C2");
      expect(irealChordSymbol("C6/9")).toBe("C69");
      expect(irealChordSymbol("CmMaj7")).toBe("Cm^7");
      expect(irealChordSymbol("Calt7")).toBe("C7alt");
    });

    it("leaves the spellings the dictionary already accepts alone", () => {
      for (const symbol of ["C", "Cm", "Cm7", "C7", "C9", "C6", "Cm6", "C69", "Cadd9",
        "Cm7b5", "C7b9", "C7#9", "C7#11", "C7b13", "C11", "Cm11", "C13", "C5"]) {
        expect(irealChordSymbol(symbol), symbol).toBe(symbol);
      }
    });

    it("keeps the root's spelling and the slash bass", () => {
      expect(irealChordSymbol("Bbmaj7")).toBe("Bb^7");
      expect(irealChordSymbol("F#m7")).toBe("F#m7");
      expect(irealChordSymbol("Cmaj7/E")).toBe("C^7/E");
    });

    it("says no rather than guessing", () => {
      for (const bad of ["N.C.", "rit.", "", "hello", "Cm(add9)"]) {
        expect(irealChordSymbol(bad), bad).toBeNull();
      }
    });

    it("only ever returns a suffix the dictionary holds", () => {
      const roots = ["C", "F#", "Bb"];
      const suffixes = ["", "m", "maj7", "m7", "7", "6", "m6", "maj9", "m9", "9", "sus4",
        "sus2", "add9", "dim", "dim7", "aug", "m7b5", "7b9", "7#9", "7#11", "7b13", "11",
        "13", "mMaj7", "6/9", "alt7"];
      for (const root of roots) {
        for (const suffix of suffixes) {
          const out = irealChordSymbol(`${root}${suffix}`);
          expect(out, `${root}${suffix}`).not.toBeNull();
          const tail = out!.replace(/^[A-G][b#]*/, "").split("/")[0]!;
          expect(IREAL_VOICING_SUFFIXES.has(tail), `${root}${suffix} → ${out}`).toBe(true);
        }
      }
    });
  });

  it("respells every chord it prints inside chord(…)", () => {
    const texts = [
      analyzeHarmony({ task: "detect-chord", notes: ["c4", "e4", "g4", "b4"] }),
      analyzeHarmony({ task: "suggest-progression", key: "C" }),
      analyzeHarmony({ task: "suggest-progression", key: "A minor" }),
      analyzeHarmony({ task: "suggest-progression", key: "D dorian" }),
      analyzeHarmony({ task: "suggest-progression", key: "C", romanNumerals: ["iim7", "V7", "Imaj7"] }),
      analyzeHarmony({ task: "key-chords", key: "C" }),
      analyzeHarmony({ task: "key-chords", key: "F# major" }),
      analyzeHarmony({ task: "key-chords", key: "A minor" }),
      analyzeHarmony({ task: "key-chords", key: "G mixolydian" }),
    ].join("\n");

    const emitted = [...texts.matchAll(/chord\("<?([^"]*?)>?"\)/g)].flatMap((m) =>
      m[1]!.split(/[\s[\]]+/).filter(Boolean),
    );
    expect(emitted.length).toBeGreaterThan(15);
    for (const token of emitted) {
      if (token === "~") continue;
      const suffix = token.replace(/^[A-G][b#]*/, "").split("/")[0]!.replace(/@\d+$/, "");
      expect(IREAL_VOICING_SUFFIXES.has(suffix), `${token} → "${suffix}"`).toBe(true);
    }
    // ABC still gets the lead-sheet spelling — the two notations differ on purpose.
    expect(texts).toContain('ABC chord symbol: "Cmaj7"');
  });

  it("derives the dictionary the way voicings.mjs does", () => {
    // Spot-checks against the published table, so a wrong derivation is caught.
    for (const present of ["", "^7", "M7", "m7", "-7", "m7b5", "h7", "o7", "o", "aug",
      "+", "sus", "7sus", "69", "add9", "7alt", "m^7", "-^7", "2", "5"]) {
      expect(IREAL_VOICING_SUFFIXES.has(present), present).toBe(true);
    }
    for (const absent of ["maj7", "maj9", "dim", "dim7", "sus4", "sus2", "mMaj7", "6/9",
      "min7", "M9#5", "alt7"]) {
      expect(IREAL_VOICING_SUFFIXES.has(absent), absent).toBe(false);
    }
  });
});

describe("chord symbols arrive as ASCII", () => {
  it("undoes the typographic accidentals abcjs prints", () => {
    expect(asciiChordSymbol("B♭maj7")).toBe("Bbmaj7");
    expect(asciiChordSymbol("F♯m7")).toBe("F#m7");
    expect(asciiChordSymbol("C△")).toBe("Cmaj7");
    expect(asciiChordSymbol("C°7")).toBe("Cdim7");
    // ø already means the seventh — don't let it survive twice
    expect(asciiChordSymbol("Cø7")).toBe("Cm7b5");
    expect(asciiChordSymbol("Cø")).toBe("Cm7b5");
  });

  it("separates chord symbols from annotations", () => {
    for (const yes of ["C", "Am7", "B♭maj7", "F#m7b5", "G7/B", "Csus4"]) {
      expect(isChordSymbol(yes), yes).toBe(true);
    }
    for (const no of ["rit.", "N.C.", "", "poco a poco", "cresc."]) {
      expect(isChordSymbol(no), no).toBe(false);
    }
  });
});
