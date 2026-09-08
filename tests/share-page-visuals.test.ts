import { describe, expect, it } from "vitest";
import { generateStrudelPlayerHtml } from "../src/strudel-browser-fallback";
import { HYDRA_SYNTH_CDN } from "../src/shared/visual-presets";
import { HYDRA_INIT_RE, VIZ_ALL_RE, VIZ_METHOD_RE } from "../src/shared/viz-detect";

// =============================================================================
// The hosted /play page: hydra pin + H() guard (F3) and the visuals layer (F4)
// =============================================================================
//
// The ext-apps widget already had all of this; the standalone page — the one
// terminal and CLI users actually get — shipped without any of it. Verified in
// Chromium against a generated file:// page (screenshots in
// /tmp/ms-handoff/shots/share-fix-*.png): the piano roll paints full-page behind
// the code with the header on top, the Hydra shader does the same, and
// `hydra-synth@1.4.0` is the URL the network layer actually fetches.

const PLAIN = 's("bd*2 sd")';
const ROLL = 'note("c3 e3").pianoroll()';
const HYDRA = "await initHydra()\nosc(8).out(o0)\n\n" + PLAIN;

const readInit = (html: string) => {
  const m = html.match(
    /<script type="application\/json" id="init-data">([\s\S]*?)<\/script>/,
  );
  return JSON.parse(m![1]!);
};

const bodyClass = (html: string) => html.match(/<body class="([^"]*)"/)![1]!;

// -----------------------------------------------------------------------------
// F3 — hydra-synth was loaded UNPINNED, and H() had no rest guard
// -----------------------------------------------------------------------------

describe("hydra-synth is pinned on the hosted page", () => {
  it("carries the pinned CDN URL into the page", () => {
    const html = generateStrudelPlayerHtml({ code: HYDRA });
    expect(readInit(html).hydraCdn).toBe(HYDRA_SYNTH_CDN);
    expect(HYDRA_SYNTH_CDN).toMatch(/hydra-synth@\d+\.\d+\.\d+$/);
  });

  it("wraps initHydra to supply `src` when the pattern does not", () => {
    const html = generateStrudelPlayerHtml({ code: HYDRA });
    expect(html).toContain("defineWrappedGlobal('initHydra'");
    // Caller options spread LAST, so a pattern naming its own src still wins.
    expect(html).toContain("Object.assign({ src: INIT.hydraCdn }, options || {})");
  });

  it("installs the wrappers as ACCESSORS, not plain assignments", () => {
    // The REPL republishes its eval scope with Object.assign across several
    // async chunks, so a plain reassignment is silently overwritten. Only the
    // setter survives — it re-wraps whatever the next publish hands it.
    const html = generateStrudelPlayerHtml({ code: PLAIN });
    expect(html).toContain("Object.defineProperty(globalThis, key,");
    expect(html).toMatch(/set: function \(value\) \{ exposed = apply\(value\); \}/);
    expect(html).not.toMatch(/globalThis\.initHydra\s*=\s*function/);
    expect(html).not.toMatch(/globalThis\.H\s*=\s*function/);
  });

  it("wraps H so a rest returns 0 instead of throwing every frame", () => {
    const html = generateStrudelPlayerHtml({ code: PLAIN });
    expect(html).toContain("defineWrappedGlobal('H'");
    expect(html).toContain("return isFinite(value) ? value : 0;");
    // The catch is the point: upstream H reads [0].value off an empty query.
    expect(html).toMatch(/catch \(e\) \{\s*return 0;\s*\}/);
  });

  it("keeps the injected script's own literals single-quoted", () => {
    // Double-quoted literals in code that reaches Strudel's transpiler are
    // rewritten as mini-notation. Nothing here is pattern code, but the page's
    // own JS stays on the safe side of that rule.
    const html = generateStrudelPlayerHtml({ code: PLAIN });
    const script = html.slice(html.lastIndexOf("<script>"));
    for (const line of ["defineWrappedGlobal('initHydra'", "defineWrappedGlobal('H'"]) {
      expect(script).toContain(line);
    }
    expect(script).not.toContain('defineWrappedGlobal("');
  });
});

// -----------------------------------------------------------------------------
// F4 — viz patterns painted over the page chrome, or not at all
// -----------------------------------------------------------------------------

describe("the visuals canvas is pre-created and layered", () => {
  it("ships #test-canvas in the markup so getDrawContext reuses it", () => {
    // Without it, getDrawContext() PREPENDS a position:fixed, full-viewport
    // canvas with no z-index to <body> — over the header and controls.
    const html = generateStrudelPlayerHtml({ code: ROLL });
    expect(html).toContain('<canvas id="test-canvas"');
    expect(html).toMatch(/#test-canvas,\s*\n\s*#hydra-canvas \{/);
    expect(html).toContain("pointer-events: none;");
  });

  it("puts both canvases behind the chrome", () => {
    const html = generateStrudelPlayerHtml({ code: ROLL });
    // Canvases at z-index 0, header/main at 1.
    expect(html).toMatch(/#test-canvas,\s*\n\s*#hydra-canvas \{[^}]*z-index: 0;/);
    expect(html).toMatch(/header, main \{ position: relative; z-index: 1; \}/);
  });

  it("gives #hydra-canvas the same fixed treatment (it is a second body canvas)", () => {
    const html = generateStrudelPlayerHtml({ code: HYDRA });
    expect(html).toContain("#hydra-canvas { image-rendering: pixelated; }");
    expect(html).toContain("body.hydra-on #test-canvas { background: transparent; }");
  });

  it("carries the v0.4.2 occlusion fix: transparent wrapper, one scrim", () => {
    // StrudelMirror wraps CodeMirror in a div whose background is set INLINE to
    // an opaque var(--background); it sat over the canvas and hid it entirely.
    const html = generateStrudelPlayerHtml({ code: ROLL });
    expect(html).toMatch(
      /body\.viz-on main > div,[\s\S]*?background-color: transparent !important;/,
    );
    expect(html).toMatch(/body\.viz-on \.cm-editor \{[^}]*background-color: transparent !important;/);
    // The readability scrim lives on ONE layer so it never double-darkens.
    expect(html).toMatch(/body\.viz-on \.cm-scroller \{[^}]*background-color: rgba\(20, 17, 29, 0\.5\)/);
    expect(html).toContain("body.viz-on .cm-content { text-shadow:");
  });

  it("does not !important the reveal — feedStrudel hides the canvas inline", () => {
    const html = generateStrudelPlayerHtml({ code: ROLL });
    expect(html).toContain("body.viz-on #test-canvas { display: block; }");
    expect(html).not.toContain("#test-canvas { display: block !important");
  });
});

describe("the stage is revealed only for code that draws", () => {
  it.each([
    ["a plain pattern", PLAIN, ""],
    ["a draw method", ROLL, "viz-on"],
    ["all(pianoroll)", `${PLAIN}\nall(pianoroll)`, "viz-on"],
    ["initHydra", HYDRA, "viz-on hydra-on"],
  ])("%s → body class %o", (_label, code, expected) => {
    expect(bodyClass(generateStrudelPlayerHtml({ code }))).toBe(expected);
  });

  it("ignores a draw method that is only mentioned in a comment", () => {
    expect(bodyClass(generateStrudelPlayerHtml({ code: `${PLAIN} // .pianoroll()` }))).toBe(
      "",
    );
  });

  it("re-derives the state client-side, from the SAME patterns as the server", () => {
    const init = readInit(generateStrudelPlayerHtml({ code: ROLL }));
    expect(init.vizPatterns).toEqual([VIZ_METHOD_RE.source, VIZ_ALL_RE.source]);
    expect(init.hydraPattern).toBe(HYDRA_INIT_RE.source);

    const html = generateStrudelPlayerHtml({ code: ROLL });
    expect(html).toContain("function applyVizState(code)");
    // Re-checked on every play, so an edit that adds .pianoroll() shows up.
    expect(html).toContain("applyVizState(getLiveCode(ed))");
  });

  it("sizes the backing store itself — getDrawContext only sizes canvases it creates", () => {
    const html = generateStrudelPlayerHtml({ code: ROLL });
    expect(html).toContain("function sizeVizCanvas()");
    expect(html).toContain("window.devicePixelRatio || 1");
    expect(html).toContain("window.addEventListener('resize', sizeVizCanvas)");
  });
});
