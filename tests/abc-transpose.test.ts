/**
 * Transposition must move the *notation*, not just the MIDI stream.
 *
 * The tool used to emit `%%MIDI transpose N`, which shifted playback while the
 * printed score and its K: header stayed in the original key — so the sheet
 * music on screen disagreed with the audio coming out of it. These tests pin
 * the replacement (`ABCJS.strTranspose`) by re-parsing the transposed string
 * and asserting on the key signature and the actual note pitches.
 */
import { describe, expect, it } from "vitest";
import ABCJS from "abcjs";
import { transposeAbc, transposeAbcDetailed } from "../src/abc-transpose";
import { DEFAULT_ABC_NOTATION } from "../src/abc-guide";

/** What raw abcjs would do, so the workarounds document what they route around. */
function rawStrTranspose(abc: string, steps: number): string {
  return ABCJS.strTranspose(abc, ABCJS.parseOnly(abc), steps);
}

/** Grace-note pitches (abcjs `pitch` units), in order. */
function gracesOf(abc: string): number[] {
  const out: number[] = [];
  const tune = ABCJS.parseOnly(abc)[0];
  for (const line of tune.lines ?? []) {
    for (const staff of line.staff ?? []) {
      for (const voice of staff.voices ?? []) {
        for (const el of voice as Array<Record<string, any>>) {
          for (const g of (el.gracenotes as { pitch: number }[] | undefined) ?? []) {
            out.push(g.pitch);
          }
        }
      }
    }
  }
  return out;
}

/** Key signature root + accidental of the first tune, e.g. "Eb". */
function keyOf(abc: string): string {
  const key = ABCJS.parseOnly(abc)[0].getKeySignature();
  const acc = key.acc ?? "";
  return `${key.root}${acc === "natural" ? "" : acc}`;
}

/** Every sounding pitch in the tune, in order (abcjs `pitch` units). */
function pitchesOf(abc: string): number[] {
  const pitches: number[] = [];
  const tune = ABCJS.parseOnly(abc)[0];
  for (const line of tune.lines ?? []) {
    for (const staff of line.staff ?? []) {
      for (const voice of staff.voices ?? []) {
        for (const el of voice as Array<Record<string, any>>) {
          for (const note of el.pitches ?? []) {
            pitches.push(note.pitch as number);
          }
        }
      }
    }
  }
  return pitches;
}

describe("transposeAbc", () => {
  it("moves the key signature and the notes of the default tune together", () => {
    const original = DEFAULT_ABC_NOTATION;
    const up3 = transposeAbc(original, 3);

    // C major up a minor third is E-flat major — in the notation, not just MIDI.
    expect(keyOf(original)).toBe("C");
    expect(keyOf(up3)).toBe("Eb");
    expect(up3).toMatch(/^K:\s*Eb/m);

    // Every printed pitch moves up two diatonic steps (a third).
    const before = pitchesOf(original);
    const after = pitchesOf(up3);
    expect(after).toHaveLength(before.length);
    expect(before.length).toBeGreaterThan(0);
    for (const [i, pitch] of after.entries()) {
      expect(pitch - before[i]).toBe(2);
    }
  });

  it("transposes downwards too", () => {
    const down2 = transposeAbc("X:1\nT:D\nM:4/4\nL:1/4\nK:D\nD E F G |", -2);
    expect(down2).toMatch(/^K:\s*C/m);
  });

  it("moves chord symbols with the notes, so style presets stay in key", () => {
    const abc = 'X:1\nT:Chords\nM:4/4\nL:1/4\nK:C\n"C"C D E F | "G7"G A B c |]';
    const up3 = transposeAbc(abc, 3);
    expect(up3).toContain('"Eb"');
    expect(up3).toContain('"Bb7"');
    expect(up3).not.toContain('"C"');
  });

  it("survives quoted V: name attributes in a multi-voice score", () => {
    // The same shape the deleted stripVoiceNameQuotes() claimed abcjs choked on.
    const abc = [
      "X:1",
      "T:Two Voices",
      "M:4/4",
      "L:1/4",
      'V:1 clef=treble name="Melody Line"',
      'V:2 clef=bass name="Bass"',
      "K:C",
      "[V:1] C E G c |]",
      "[V:2] C,2 G,2 |]",
    ].join("\n");

    const up2 = transposeAbc(abc, 2);
    expect(up2).toMatch(/^K:\s*D/m);
    // The voice names are untouched — and still quoted, in full.
    expect(up2).toContain('name="Melody Line"');
    expect(up2).toContain('name="Bass"');
  });

  it("is a no-op for zero, undefined, and non-finite shifts", () => {
    const abc = DEFAULT_ABC_NOTATION;
    expect(transposeAbc(abc, 0)).toBe(abc);
    expect(transposeAbc(abc, undefined)).toBe(abc);
    expect(transposeAbc(abc, Number.NaN)).toBe(abc);
  });

  it("returns the input unchanged when parsing throws", () => {
    const abc = DEFAULT_ABC_NOTATION;
    const boom = () => {
      throw new Error("parser exploded");
    };
    expect(transposeAbc(abc, 4, boom as never)).toBe(abc);
  });

  it("returns the input unchanged when parsing yields no tune", () => {
    const abc = DEFAULT_ABC_NOTATION;
    expect(transposeAbc(abc, 4, () => [] as never)).toBe(abc);
  });

  it("does not throw on non-ABC prose (abcjs transposes it as a tune body)", () => {
    // abcjs has no "this isn't music" verdict — it reads bare prose as a tune
    // body and shifts the letters it recognises as pitches. Documented here so
    // the behaviour is a known quantity: callers feed this validated ABC only.
    const junk = "this is not ABC notation at all";
    expect(() => transposeAbc(junk, 4)).not.toThrow();
    expect(typeof transposeAbc(junk, 4)).toBe("string");
  });

  it("never emits the audio-only %%MIDI transpose directive for a tune it can rewrite", () => {
    expect(transposeAbc(DEFAULT_ABC_NOTATION, 5)).not.toContain(
      "%%MIDI transpose",
    );
    expect(transposeAbcDetailed(DEFAULT_ABC_NOTATION, 5).warning).toBeNull();
  });
});

// =============================================================================
// Codex review #5 — abcjs's strTranspose corrupts two shapes and silently
// mis-shifts a third. We can't fork abcjs, so transposeAbc works around all
// three: grace groups are lifted out and moved separately, a keyless tune is
// not rewritten at all, and every result is reparsed before it is accepted.
// =============================================================================

describe("grace notes survive transposition (Codex #5a)", () => {
  const ONE_GRACE = "X:1\nT:g\nM:4/4\nL:1/4\nK:C\n{^F} C4 |\n";
  const TWO_GRACE = "X:1\nT:g\nM:4/4\nL:1/4\nK:C\n{^FG} C4 |\n";

  it("is working around a real abcjs defect, not a hypothetical one", () => {
    // Pinned so this stops being a workaround the day abcjs fixes it.
    expect(rawStrTranspose(ONE_GRACE, 2)).toContain("{^G D4"); // closing brace GONE
    expect(gracesOf(TWO_GRACE)).toHaveLength(2);
    expect(gracesOf(rawStrTranspose(TWO_GRACE, 2))).toHaveLength(1); // one DROPPED
  });

  it("keeps the braces around a single grace note and moves it", () => {
    const up2 = transposeAbc(ONE_GRACE, 2);
    expect(up2).toMatch(/^K:\s*D/m);
    expect(up2).toContain("{^G}");
    expect(gracesOf(up2)).toEqual(gracesOf(ONE_GRACE).map((p) => p + 1));
  });

  it("keeps BOTH grace notes of a two-note group", () => {
    const up2 = transposeAbc(TWO_GRACE, 2);
    expect(gracesOf(up2)).toHaveLength(2);
    expect(gracesOf(up2)).toEqual(gracesOf(TWO_GRACE).map((p) => p + 1));
    expect(up2).toContain("{^GA}");
  });

  it("handles several grace groups in one tune", () => {
    const abc = "X:1\nT:g\nM:4/4\nL:1/4\nK:C\n{^F}C4 | {G}D2 E2 |\n";
    const up2 = transposeAbc(abc, 2);
    expect(up2).toContain("{^G}");
    expect(up2).toContain("{A}");
    expect(gracesOf(up2)).toEqual(gracesOf(abc).map((p) => p + 1));
    expect(transposeAbcDetailed(abc, 2).warning).toBeNull();
  });

  it("does not mistake a brace inside a chord symbol for a grace group", () => {
    const abc = 'X:1\nT:g\nM:4/4\nL:1/4\nK:C\n"C{x}"C D E F |\n';
    const result = transposeAbcDetailed(abc, 2);
    expect(result.abc).toContain("{x}");
    expect(result.abc).not.toContain("@zQg");
  });

  it("never leaves a marker behind in the output", () => {
    for (const abc of [ONE_GRACE, TWO_GRACE, DEFAULT_ABC_NOTATION]) {
      expect(transposeAbc(abc, 3)).not.toContain("@zQg");
    }
  });
});

describe("a keyless tune is not rewritten (Codex #5b)", () => {
  const KEYLESS = "X:1\nT:g\nM:4/4\nL:1/4\nK:none\nC D E F |\n";

  it("is working around a real abcjs defect, not a hypothetical one", () => {
    // Under K:none abcjs shifts by SCALE STEPS: C D E F becomes D E F G,
    // intervals [2,2,1,2] instead of a uniform two semitones.
    expect(rawStrTranspose(KEYLESS, 2)).toContain("D E F G");
  });

  it("shifts the audio with a directive and leaves the notation alone", () => {
    const result = transposeAbcDetailed(KEYLESS, 2);
    expect(result.abc).toContain("%%MIDI transpose 2");
    expect(result.abc).toContain("C D E F |");
    expect(result.abc).toMatch(/^K:\s*none/m);
    expect(result.warning).toContain("AUDIO only");
    expect(result.warning).toContain("printed score is still in the written key");
  });

  it("does the same for a tune with no K: header at all", () => {
    const result = transposeAbcDetailed("C D E F |\n", -3);
    expect(result.abc).toContain("%%MIDI transpose -3");
    expect(result.warning).toContain("down 3 semitones");
  });

  it("says 'semitone' in the singular for a one-semitone shift", () => {
    expect(transposeAbcDetailed(KEYLESS, 1).warning).toContain("up 1 semitone)");
  });
});

describe("the rewritten notation is always verified (Codex #5c)", () => {
  it("falls back to the directive when the rewrite loses notes", () => {
    // A parse that reports FEWER notes coming back than going in is exactly the
    // signal the grace-note corruption produced; simulate it by handing the
    // verifier a parser that under-reports the second time it is called.
    const abc = "X:1\nT:g\nM:4/4\nL:1/4\nK:C\nC D E F |\n";
    let call = 0;
    const parse = ((input: string) => {
      call += 1;
      const parsed = ABCJS.parseOnly(call === 1 ? input : "X:1\nK:C\nC |\n");
      return parsed;
    }) as never;

    const result = transposeAbcDetailed(abc, 2, parse);
    expect(result.abc).toContain("%%MIDI transpose 2");
    expect(result.warning).toContain("lost notes");
  });

  it("falls back when the rewrite stops parsing cleanly", () => {
    const abc = "X:1\nT:g\nM:4/4\nL:1/4\nK:C\nC D E F |\n";
    let call = 0;
    const parse = ((input: string) => {
      call += 1;
      return ABCJS.parseOnly(call === 1 ? input : "X:1\nK:C\nC q D E F |\n");
    }) as never;

    const result = transposeAbcDetailed(abc, 2, parse);
    expect(result.abc).toContain("%%MIDI transpose 2");
    expect(result.warning).toContain("did not parse cleanly");
  });

  it("puts the directive after the K: line so abcjs reads it", () => {
    const result = transposeAbcDetailed(
      "X:1\nT:g\nM:4/4\nL:1/4\nK:none\nC D E F |\n",
      2,
    );
    const lines = result.abc.split("\n");
    const keyLine = lines.findIndex((l) => l.startsWith("K:"));
    expect(lines[keyLine + 1]).toBe("%%MIDI transpose 2");
  });

  it("keeps the string form usable — the fallback rides inside the ABC", () => {
    const keyless = "X:1\nT:g\nM:4/4\nL:1/4\nK:none\nC D E F |\n";
    expect(transposeAbc(keyless, 2)).toBe(transposeAbcDetailed(keyless, 2).abc);
  });
});
