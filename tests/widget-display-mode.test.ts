// =============================================================================
// Widget fullscreen + settings serialisation (F9, F10)
//
// The widgets are DOM code that vitest doesn't run, so these are source-text
// assertions in the style of tests/host-theme.test.ts — the point is that the
// ABC widget no longer differs from the Strudel one on a behaviour both need.
//
// F9: mcp-app fired `requestDisplayMode({ mode: "fullscreen" })` and dropped the
// promise. A host that declines (or answers -32601 because it doesn't implement
// the method) produced an unhandled rejection, no feedback, and no way back to
// the inline layout — the button simply looked broken.
//
// F10: applySettings() calls SynthController.setTune(), which pauses, rewinds
// and re-primes the transport. Flicking through the instrument selector fires
// one per change, and two overlapping ones interleave a rewind with another
// prime.
// =============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), "utf8");

const ABC = read("mcp-app.ts");
const STRUDEL = read("strudel-app.ts");

describe("both widgets toggle the display mode the same way", () => {
  for (const [label, source] of [
    ["mcp-app.ts", ABC],
    ["strudel-app.ts", STRUDEL],
  ] as const) {
    describe(label, () => {
      it("routes the button through an awaited toggle, not a bare call", () => {
        expect(source).toContain("void toggleDisplayMode();");
        expect(source).toContain(
          "const result = await app.requestDisplayMode({ mode: wanted });",
        );
      });

      it("asks for the OPPOSITE of the mode it is in, so it toggles both ways", () => {
        expect(source).toMatch(
          /displayMode === "fullscreen" \? "inline" : "fullscreen"/,
        );
      });

      it("trusts the mode the host GRANTED rather than the one requested", () => {
        expect(source).toContain("if (result?.mode) displayMode = result.mode;");
      });

      it("catches a host rejection and says so instead of throwing", () => {
        expect(source).toMatch(/\} catch \{\s*setStatus\(\s*\n?\s*"Fullscreen isn't available here/);
      });

      it("declines up front when the host doesn't offer the mode", () => {
        expect(source).toContain(
          "if (availableDisplayModes && !availableDisplayModes.includes(wanted))",
        );
      });

      it("follows the host's own displayMode/availableDisplayModes updates", () => {
        expect(source).toMatch(/if \(ctx\.displayMode\) \{\s*\n\s*displayMode = ctx\.displayMode;/);
        expect(source).toContain("availableDisplayModes = ctx.availableDisplayModes;");
      });

      it("reflects the state on the button (aria-pressed)", () => {
        expect(source).toContain("function syncFullscreenButton()");
        expect(source).toMatch(/setAttribute\("aria-pressed", String\(isFullscreen\)\)/);
      });
    });
  }

  it("no longer fires the old unawaited fullscreen-only request", () => {
    expect(ABC).not.toContain('appInstance?.requestDisplayMode({ mode: "fullscreen" })');
  });
});

describe("applySettings is serialised against rapid selector changes", () => {
  it("chains each call behind the one in flight", () => {
    expect(ABC).toContain("let applySettingsChain: Promise<void> = Promise.resolve()");
    expect(ABC).toContain("applySettingsChain.then(applySettingsNow)");
  });

  it("keeps the chain alive when a link rejects", () => {
    expect(ABC).toContain("applySettingsChain = next.catch(() => {})");
  });

  it("re-reads the current selector values inside the chained call", () => {
    // currentSynthOptions() is read in applySettingsNow, not captured at the
    // moment the call was queued — so a burst primes the LAST choice, not each.
    const body = ABC.slice(
      ABC.indexOf("async function applySettingsNow"),
      ABC.indexOf("// Build instrument selector"),
    );
    expect(body).toContain("currentSynthOptions()");
  });

  it("still returns a promise the callers can chain onto", () => {
    // The sound-bank change path does applySettings().then(...).catch(...).
    expect(ABC).toMatch(/function applySettings\(\): Promise<void>/);
    expect(ABC).toContain("applySettings()\n    .then(");
  });
});
