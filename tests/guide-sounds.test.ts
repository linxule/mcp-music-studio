import { describe, expect, it } from "vitest";
import { STRUDEL_GUIDES } from "../src/strudel-guide";
import gmNames from "./fixtures/gm-sound-names.json";

/**
 * Every gm_* sound name the guide tells an agent to use must exist in
 * @strudel/soundfonts (fixture vendored from gm.mjs, 1.3.0). superdough throws
 * "sound X not found" for unknown names, which silently mutes that layer —
 * the jazz and progressive-house templates shipped with such names (fixed).
 */
describe("Strudel guide GM sound names", () => {
  const canonical = new Set(gmNames as string[]);
  const placeholders = new Set(["gm_", "gm_instrument_name"]);

  it("only references real gm_* soundfont names", () => {
    const mentioned = new Set<string>();
    for (const text of Object.values(STRUDEL_GUIDES)) {
      for (const m of text.matchAll(/gm_[a-z0-9_]*/g)) mentioned.add(m[0]);
    }
    const unknown = [...mentioned].filter((n) => !canonical.has(n) && !placeholders.has(n));
    expect(unknown).toEqual([]);
  });

  it("fixture looks like the full GM set", () => {
    expect(gmNames.length).toBeGreaterThanOrEqual(128);
    expect(canonical.has("gm_piano")).toBe(true);
    expect(canonical.has("gm_epiano1")).toBe(true);
  });
});
