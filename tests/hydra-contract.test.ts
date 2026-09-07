// =============================================================================
// Contract test: @strudel/hydra's initHydra(), pinned.
//
// The Strudel widget is built around one upstream fact that is nowhere in
// @strudel/hydra's docs: the EXISTENCE of a `#hydra-canvas` element is its own
// "already initialised" flag.
//
//     if (!document.getElementById('hydra-canvas')) { ...create + init... }
//     return hydra
//
// Everything in src/strudel-app.ts inverts around that. We must NOT pre-create
// the canvas in static HTML (v0.4.x did, and initHydra() silently no-opped:
// no engine, no osc/o0 globals, patterns dying on "osc is not defined"), so
// instead the widget lets getDrawContext() prepend it to <body> and ADOPTS it
// into .repl-section from a MutationObserver — and on teardown it must leave NO
// canvas behind, or the next initHydra() no-ops again.
//
// This test executes the REAL upstream sources (saved under tests/fixtures/
// so the suite stays offline and deterministic) against a minimal DOM stub, so
// a version bump that changes the mechanism fails here rather than in the widget.
//
// Why no jsdom: neither jsdom nor happy-dom is a devDependency of this package,
// and adding one would touch package.json for a single test. The two functions
// under test between them touch ~8 DOM members, all stubbed below.
// =============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "strudel");
const HYDRA_SRC = readFileSync(join(FIXTURES, "hydra-1.2.6.mjs"), "utf8");
const DRAW_SRC = readFileSync(join(FIXTURES, "draw-1.2.6.mjs"), "utf8");

// -----------------------------------------------------------------------------
// Minimal DOM
// -----------------------------------------------------------------------------

interface StubCanvas {
  id: string;
  tagName: string;
  width: number;
  height: number;
  style: Record<string, string> & { cssText?: string };
  getContext(type: string): { canvas: StubCanvas; contextType: string };
  remove(): void;
}

function makeDom() {
  const bodyChildren: StubCanvas[] = [];

  function createElement(tag: string): StubCanvas {
    const styleObj: Record<string, string> = {};
    const el = {
      id: "",
      tagName: tag.toUpperCase(),
      width: 0,
      height: 0,
      getContext(type: string) {
        // Real getDrawContext() returns canvas.getContext(...), and
        // @strudel/hydra destructures `{ canvas }` off it — a rendering context
        // does carry a back-reference to its canvas.
        return { canvas: el as StubCanvas, contextType: type };
      },
      remove() {
        const i = bodyChildren.indexOf(el as StubCanvas);
        if (i >= 0) bodyChildren.splice(i, 1);
      },
    } as unknown as StubCanvas;
    // `canvas.style = '...'` must behave like the cssText setter (keep an
    // object), because the very next line does style.imageRendering = '…'.
    Object.defineProperty(el, "style", {
      get: () => styleObj,
      set: (value: string) => {
        styleObj.cssText = String(value);
      },
      configurable: true,
    });
    return el;
  }

  const body = {
    get children() {
      return bodyChildren;
    },
    prepend(node: StubCanvas) {
      bodyChildren.unshift(node);
    },
    appendChild(node: StubCanvas) {
      bodyChildren.push(node);
    },
  };

  const find = (id: string) => bodyChildren.find((c) => c.id === id) ?? null;

  const document = {
    body,
    createElement,
    getElementById: (id: string) => find(id),
    querySelector: (selector: string) =>
      selector.startsWith("#") ? find(selector.slice(1)) : null,
  };

  const window = {
    devicePixelRatio: 2,
    innerWidth: 1280,
    innerHeight: 720,
    addEventListener() {},
  };

  return { document, window, bodyChildren };
}

// -----------------------------------------------------------------------------
// Load the real upstream sources
// -----------------------------------------------------------------------------

/**
 * Rewrite an ES module fixture into a callable factory: drop bare-specifier
 * imports (injected as parameters instead), unexport, and route the dynamic
 * `import(src)` — which would otherwise hit the network — to a spy.
 *
 * Every rewrite is asserted to have MATCHED, so a fixture refresh that renames
 * something can't turn this test into a green no-op.
 */
function loadHydraModule(deps: {
  getDrawContext: (id: string, opts: unknown) => unknown;
  document: unknown;
  dynamicImport: (src: string) => Promise<unknown>;
  Hydra: unknown;
}) {
  let src = HYDRA_SRC;

  const importLines = src.match(/^import .*$/gm) ?? [];
  expect(importLines.length).toBeGreaterThan(0);
  src = src.replace(/^import .*$/gm, "");

  expect(src).toContain("await import(");
  src = src.replace(/await import\((?:\/\*[^*]*\*\/\s*)?src\)/, "await __dynamicImport(src)");
  expect(src).toContain("__dynamicImport(src)");

  expect(src).toMatch(/^export /m);
  src = src.replace(/^export /gm, "");

  src += "\nreturn { initHydra, clearHydra, H };";

  const factory = new Function(
    "getDrawContext",
    "controls",
    "getTime",
    "reify",
    "__dynamicImport",
    "document",
    "Hydra",
    src,
  );
  return factory(
    deps.getDrawContext,
    { speed: "controls.speed", shape: "controls.shape" },
    () => 0,
    (p: unknown) => p,
    deps.dynamicImport,
    deps.document,
    deps.Hydra,
  ) as {
    initHydra: (opts?: Record<string, unknown>) => Promise<unknown>;
    clearHydra: () => void;
    H: (p: unknown) => () => unknown;
  };
}

/**
 * The real getDrawContext(), lifted verbatim out of @strudel/draw. It has no
 * dependency on that module's `@strudel/core` imports — it only touches
 * `window` and `document` — so it can be evaluated on its own.
 */
function loadGetDrawContext(document: unknown, window: unknown) {
  const start = DRAW_SRC.indexOf("export const getDrawContext");
  const end = DRAW_SRC.indexOf("let animationFrames");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const body =
    DRAW_SRC.slice(start, end).replace("export const", "const") +
    "\nreturn getDrawContext;";
  return new Function("document", "window", body)(document, window) as (
    id?: string,
    opts?: unknown,
  ) => { canvas: StubCanvas };
}

// -----------------------------------------------------------------------------

describe("@strudel/hydra initHydra() contract", () => {
  let dom: ReturnType<typeof makeDom>;
  let imported: string[];
  let constructed: Record<string, unknown>[];
  let getDrawContext: (id?: string, opts?: unknown) => { canvas: StubCanvas };

  beforeEach(() => {
    dom = makeDom();
    imported = [];
    constructed = [];
    getDrawContext = loadGetDrawContext(dom.document, dom.window);
  });

  function load() {
    class FakeHydra {
      config: Record<string, unknown>;
      // feedStrudel calls hydra.synth.s0.init({ src: canvas }).
      synth = { s0: { init() {} } };
      constructor(config: Record<string, unknown>) {
        this.config = config;
        constructed.push(config);
      }
      hush() {}
    }
    return loadHydraModule({
      getDrawContext: getDrawContext as never,
      document: dom.document,
      dynamicImport: async (src: string) => {
        imported.push(src);
        return {};
      },
      Hydra: FakeHydra,
    });
  }

  it("no-ops when #hydra-canvas already exists — no import, no engine, undefined", async () => {
    // THE reason strudel-app.html must not pre-create this element.
    const stale = (dom.document as any).createElement("canvas");
    stale.id = "hydra-canvas";
    dom.document.body.prepend(stale);

    const { initHydra } = load();
    const result = await initHydra();

    expect(imported).toEqual([]);
    expect(constructed).toEqual([]);
    expect(result).toBeUndefined();
  });

  it("prepends #hydra-canvas to <body> and builds the engine when none exists", async () => {
    const { initHydra } = load();
    const result = await initHydra();

    // The widget's MutationObserver watches document.body childList for exactly
    // this, and adopts the canvas into .repl-section before hydra-synth's
    // constructor reads canvas.width/height.
    expect(dom.bodyChildren).toHaveLength(1);
    expect(dom.bodyChildren[0].id).toBe("hydra-canvas");
    expect(dom.bodyChildren[0].style.cssText).toContain("position:fixed");
    expect(dom.bodyChildren[0].style.imageRendering).toBe("pixelated");

    expect(constructed).toHaveLength(1);
    expect(constructed[0].canvas).toBe(dom.bodyChildren[0]);
    expect(result).toBeInstanceOf(Object);
  });

  it("defaults hydra-synth to an UNVERSIONED specifier", async () => {
    // This is why every hydra recipe in src/shared/visual-presets.ts passes an
    // explicit pinned `src`: without one, a pattern loads whatever "latest"
    // happens to be on the day it runs.
    const { initHydra } = load();
    await initHydra();
    expect(imported).toEqual(["https://unpkg.com/hydra-synth"]);
  });

  it("honours an explicit src, so a pin actually takes effect", async () => {
    const { initHydra } = load();
    await initHydra({ src: "https://unpkg.com/hydra-synth@1.4.0" });
    expect(imported).toEqual(["https://unpkg.com/hydra-synth@1.4.0"]);
  });

  it("clearHydra() removes the canvas, re-arming the next initHydra()", async () => {
    const { initHydra, clearHydra } = load();
    await initHydra();
    expect(dom.bodyChildren).toHaveLength(1);

    clearHydra();
    expect(dom.document.getElementById("hydra-canvas")).toBeNull();

    // With the canvas gone, a second call builds a fresh engine — the property
    // the widget's teardown depends on (it must leave NO canvas behind).
    await initHydra();
    expect(constructed).toHaveLength(2);
  });

  it("REUSES the instance on unchanged options — skipping the feedStrudel hide", async () => {
    // Why src/strudel-app.ts re-applies the display rule itself
    // (applyHydraFeedMode) instead of trusting initHydra: everything inside the
    // `if (!#hydra-canvas)` block — the hide AND the engine construction that
    // starts a render loop — is skipped when the options are byte-identical.
    // A second Ctrl+Enter on the same pattern therefore left the raw piano roll
    // painting over its own processed output.
    const { initHydra } = load();
    const opts = { feedStrudel: true, src: "https://unpkg.com/hydra-synth@1.4.0" };

    await initHydra({ ...opts });
    const drawCanvas = dom.document.getElementById("test-canvas") as StubCanvas;
    expect(drawCanvas.style.display).toBe("none");
    expect(constructed).toHaveLength(1);

    // The widget clears the inline display on every staging, then re-evaluates.
    drawCanvas.style.display = "";
    await initHydra({ ...opts });

    expect(constructed).toHaveLength(1); // reused: no new engine…
    expect(drawCanvas.style.display).toBe(""); // …and nobody re-hid the canvas.
  });

  it("passes autoLoop through to the HydraRenderer constructor", async () => {
    // hydra-synth 1.4.0 ends its constructor with
    //   if (autoLoop) loop(this.tick.bind(this)).start()
    // and keeps no handle on that raf-loop, so destroying regl cannot stop it.
    // The widget passes autoLoop:false and drives tick() from a rAF it owns —
    // which only works if initHydra forwards the flag instead of eating it.
    const { initHydra } = load();
    await initHydra({ autoLoop: false, src: "https://unpkg.com/hydra-synth@1.4.0" });
    expect(constructed[0]).toMatchObject({ autoLoop: false });
    // src / feedStrudel / contextType / pixelRatio / pixelated ARE destructured
    // out; anything else reaches the constructor verbatim.
    expect(constructed[0]).not.toHaveProperty("src");
  });

  it("resets when the options change, so feedStrudel can be toggled", async () => {
    const { initHydra } = load();
    await initHydra();
    await initHydra({ feedStrudel: false, src: "https://unpkg.com/hydra-synth@1.4.0" });
    // Different options ⇒ the old canvas is removed and the engine rebuilt.
    expect(constructed).toHaveLength(2);
    expect(imported[1]).toBe("https://unpkg.com/hydra-synth@1.4.0");
  });
});
