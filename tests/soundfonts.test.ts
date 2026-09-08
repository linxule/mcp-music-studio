/**
 * @file Sound-font option map.
 *
 * The URLs must stay in the layout abcjs expects
 * (`<base><instrument>-mp3/<Note>.mp3`, see abcjs src/synth/load-note.js),
 * and every offered bank must include a `percussion` folder or `%%MIDI drumon`
 * silently loses its drums.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SOUNDFONT,
  SOUNDFONTS,
  SOUNDFONT_NAMES,
  isSoundFontName,
  resolveSoundFont,
  soundFontSynthOptions,
} from "../src/music-logic";

describe("SOUNDFONTS", () => {
  it("exposes exactly the declared names", () => {
    expect(Object.keys(SOUNDFONTS).sort()).toEqual([...SOUNDFONT_NAMES].sort());
  });

  it("has a default that keeps abcjs's own default bank", () => {
    expect(DEFAULT_SOUNDFONT).toBe("default");
    // abcjs's `defaultSoundFontUrl` — using it verbatim keeps the current
    // sound, and keeps abcjs's own 3.0 volume multiplier consistent.
    expect(SOUNDFONTS.default.url).toBe(
      "https://paulrosen.github.io/midi-js-soundfonts/FluidR3_GM/",
    );
    expect(SOUNDFONTS.default.volumeMultiplier).toBe(3.0);
  });

  it("gives every bank an https base URL with a trailing slash", () => {
    for (const font of Object.values(SOUNDFONTS)) {
      expect(font.url.startsWith("https://")).toBe(true);
      expect(font.url.endsWith("/")).toBe(true);
      expect(font.label.length).toBeGreaterThan(0);
      expect(font.volumeMultiplier).toBeGreaterThan(0);
    }
  });

  it("only offers banks on a host already allowed by SHEET_CSP", () => {
    for (const font of Object.values(SOUNDFONTS)) {
      expect(new URL(font.url).origin).toBe("https://paulrosen.github.io");
    }
  });

  it("recognises valid names and rejects others", () => {
    expect(isSoundFontName("musyngkite")).toBe(true);
    expect(isSoundFontName("gleitz")).toBe(false);
  });

  it("falls back to the default for unknown or missing names", () => {
    expect(resolveSoundFont(undefined)).toBe(SOUNDFONTS[DEFAULT_SOUNDFONT]);
    expect(resolveSoundFont("")).toBe(SOUNDFONTS[DEFAULT_SOUNDFONT]);
    expect(resolveSoundFont("nope")).toBe(SOUNDFONTS[DEFAULT_SOUNDFONT]);
    expect(resolveSoundFont("musyngkite")).toBe(SOUNDFONTS.musyngkite);
  });

  it("produces synth options abcjs understands", () => {
    expect(soundFontSynthOptions("musyngkite")).toEqual({
      soundFontUrl: SOUNDFONTS.musyngkite.url,
      soundFontVolumeMultiplier: SOUNDFONTS.musyngkite.volumeMultiplier,
    });
    expect(soundFontSynthOptions("bogus")).toEqual({
      soundFontUrl: SOUNDFONTS.default.url,
      soundFontVolumeMultiplier: SOUNDFONTS.default.volumeMultiplier,
    });
  });
});
