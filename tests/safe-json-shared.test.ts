import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { safeJsonForScript } from "../src/shared/safe-json";
import { generatePlayerHtml } from "../src/browser-fallback";
import { generateStrudelPlayerHtml } from "../src/strudel-browser-fallback";

// =============================================================================
// safeJsonForScript is shared, not copied (F10)
// =============================================================================
//
// src/browser-fallback.ts carried a byte-identical private copy of the helper
// that src/shared/safe-json.ts exports — two implementations of a security
// escape, which is exactly how the two drift apart under a later fix.

const SRC = join(import.meta.dirname, "..", "src");
const read = (name: string) => readFileSync(join(SRC, name), "utf8");

describe("both browser fallbacks import the shared helper", () => {
  it.each(["browser-fallback.ts", "strudel-browser-fallback.ts"])(
    "%s imports it rather than redefining it",
    (file) => {
      const source = read(file);
      expect(source).toMatch(
        /import \{ safeJsonForScript \} from "\.\/shared\/safe-json\.js"/,
      );
      expect(source).not.toMatch(/function safeJsonForScript/);
    },
  );
});

describe("the escaping the pages actually rely on", () => {
  // A payload carrying `</script>` must not be able to close the block it is
  // inlined into. Both generators embed their payload with this helper.
  const BREAKOUT = '</script><script>globalThis.pwned = 1</script>';

  it("neutralises <, > and & in the literal itself", () => {
    const encoded = safeJsonForScript({ code: BREAKOUT });
    expect(encoded).not.toContain("<");
    expect(encoded).not.toContain(">");
    expect(encoded).not.toContain("&");
    expect(JSON.parse(encoded)).toEqual({ code: BREAKOUT });
  });

  // The payload's own text may appear (it is data); what must NOT appear is an
  // unescaped tag that ends the block early or opens a new one. Counting script
  // tags is the check that catches a breakout regardless of what it says.
  const scriptTags = (html: string) => (html.match(/<\/?script/gi) ?? []).length;

  it("keeps a breakout payload inert in the Strudel page", () => {
    const benign = generateStrudelPlayerHtml({ code: 's("bd")' });
    const hostile = generateStrudelPlayerHtml({ code: BREAKOUT });

    expect(scriptTags(hostile)).toBe(scriptTags(benign));
    const match = hostile.match(
      /<script type="application\/json" id="init-data">([\s\S]*?)<\/script>/,
    );
    // Still the exact pattern the user wrote, after the round trip.
    expect(JSON.parse(match![1]!).code).toBe(BREAKOUT);
  });

  it("keeps a breakout payload inert in the ABC page", () => {
    const benign = generatePlayerHtml({ abcNotation: "X:1\nT:Fine\nK:C\nCDEF|" });
    const hostile = generatePlayerHtml({
      abcNotation: `X:1\nT:${BREAKOUT}\nK:C\nCDEF|`,
    });

    expect(scriptTags(hostile)).toBe(scriptTags(benign));
  });
});
