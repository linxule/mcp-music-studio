import { describe, expect, it } from "vitest";
import {
  DEFAULT_INSTRUMENT,
  DEFAULT_STYLE,
  applyStyleToAbc,
  findInstrument,
  injectTempoAndTranspose,
  prepareToolInput,
} from "../src/music-logic";

const BASE_ABC = `X:1
T:Test Tune
M:4/4
L:1/4
K:C
C D E F |`;

describe("client music helpers", () => {
  it("resets instrument and style between tool invocations", () => {
    const firstInvocation = prepareToolInput({
      abcNotation: BASE_ABC,
      instrument: "alto sax",
      style: "jazz",
    });

    expect(firstInvocation.instrument).toBe("Alto Sax");
    expect(firstInvocation.style).toBe("jazz");

    const secondInvocation = prepareToolInput({
      abcNotation: BASE_ABC,
    });

    expect(secondInvocation.instrument).toBe(DEFAULT_INSTRUMENT);
    expect(secondInvocation.style).toBe(DEFAULT_STYLE);
  });

  it("replaces an existing Q header when tempo is provided", () => {
    const withTempoHeader = `X:1
T:Tempo Test
M:4/4
L:1/4
Q:1/4=90
K:C
C D E F |`;

    const prepared = prepareToolInput({
      abcNotation: withTempoHeader,
      tempo: 140,
    });

    expect(prepared.abcNotation).toContain("Q:1/4=140");
    expect(prepared.abcNotation).not.toContain("Q:1/4=90");
    expect(prepared.abcNotation?.match(/^Q:/gm)).toHaveLength(1);
  });

  it("inserts style directives immediately after the K line", () => {
    const styled = applyStyleToAbc(BASE_ABC, "jazz");

    expect(styled).toContain("K:C\n%%MIDI drumon\n");
    expect(styled.indexOf("%%MIDI drumon")).toBeGreaterThan(
      styled.indexOf("K:C"),
    );
    expect(styled.indexOf("%%MIDI drumon")).toBeLessThan(
      styled.indexOf("C D E F |"),
    );
  });

  it("injects tempo and transpose together in a single block after the K line", () => {
    const injected = injectTempoAndTranspose(BASE_ABC, {
      tempo: 128,
      transpose: 2,
    });

    expect(injected).toContain("K:C\nQ:1/4=128\n%%MIDI transpose 2\nC D E F |");
  });

  it("supports fuzzy instrument matching for extracted helper tests", () => {
    expect(findInstrument("alto sax")).toBe("Alto Sax");
  });
});
