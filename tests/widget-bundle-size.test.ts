// =============================================================================
// The widgets must not carry the server's content or the studio's tooling.
//
// 0.10 grew the Strudel widget from 316,840 to 823,162 chars and the sheet
// widget from 801,272 to 936,739 (measured in dist/): studio-session imported
// the play schemas from tool-defs.ts, whose top-level zod calls defeat
// tree-shaking, so every guide, the gallery and the ABC defaults shipped in
// BOTH widgets; and the studio companion bundled @strudel/transpiler (acorn,
// escodegen, @strudel/core/mini) into every Strudel widget for a check only
// the local studio runs. This holds the line: markers absent, size in budget.
// Needs `bun run build` (CI builds first); skipped on a clean checkout.
// =============================================================================

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const file = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const read = (path: string) => readFileSync(file(path), "utf8");
const built = existsSync(file("dist/strudel-app.html")) && existsSync(file("dist/mcp-app.html"));

/** Measured after the fix (2026-10-02) + ~10%. Raise deliberately, with a reason. */
// 0.12: 396k → 420k for two real features in the widget (sing()'s word analysis
// and YIN in stage-runtime, and video recording) — 400.7k after both. The
// markers below, not this number, are what catch tool-defs leaking in.
const BUDGET = { "dist/strudel-app.html": 420_000, "dist/mcp-app.html": 915_000 } as const;

/** Each marker must really be in its source, or its absence from a widget proves nothing. */
const MARKERS: Array<{ marker: string; source: string; what: string; widgets: Array<keyof typeof BUDGET> }> = [
  { marker: "Weather Machine", source: "src/strudel-gallery.ts", what: "the gallery", widgets: ["dist/strudel-app.html", "dist/mcp-app.html"] },
  { marker: "# Strudel Mini-Notation", source: "src/strudel-guide.ts", what: "the Strudel guide", widgets: ["dist/strudel-app.html", "dist/mcp-app.html"] },
  { marker: "# General MIDI Instruments", source: "src/abc-guide.ts", what: "the ABC guide", widgets: ["dist/strudel-app.html", "dist/mcp-app.html"] },
  { marker: "Twinkle, Twinkle Little Star", source: "src/abc-guide.ts", what: "the ABC default score", widgets: ["dist/strudel-app.html"] },
  { marker: "ecmaVersion", source: "node_modules/acorn/dist/acorn.mjs", what: "acorn (via @strudel/transpiler)", widgets: ["dist/strudel-app.html", "dist/mcp-app.html"] },
  { marker: "analyze-harmony", source: "src/shared/tool-defs.ts", what: "the server's tool definitions", widgets: ["dist/strudel-app.html", "dist/mcp-app.html"] },
];

describe.skipIf(!built)("widget bundles (after bun run build)", () => {
  it.each(MARKERS)("$what stays out of the widgets ($marker)", ({ marker, source, widgets }) => {
    expect(read(source), `${marker} is no longer in ${source}: pick a new marker`).toContain(marker);
    for (const widget of widgets) expect(read(widget).includes(marker), `${widget} carries ${marker}`).toBe(false);
  });

  it.each(Object.entries(BUDGET))("%s stays within its size budget", (widget, budget) => {
    expect(read(widget).length).toBeLessThanOrEqual(budget);
  });

  it("the studio companion fetches the transpiler at runtime instead of bundling it", () => {
    const companion = read("src/studio-strudel-companion.ts");
    expect(companion).not.toMatch(/from\s+["']@strudel\/transpiler["']/);
    expect(companion).toContain("STUDIO_TRANSPILER_URL");
  });
});
