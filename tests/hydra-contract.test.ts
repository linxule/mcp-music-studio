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

interface FakeHydraLike {
  hushes: number;
  reglDestroys: number;
  regl: { destroy(): void };
}

describe("@strudel/hydra initHydra() contract", () => {
  let dom: ReturnType<typeof makeDom>;
  let imported: string[];
  let constructed: Record<string, unknown>[];
  let instances: FakeHydraLike[];
  let getDrawContext: (id?: string, opts?: unknown) => { canvas: StubCanvas };

  beforeEach(() => {
    dom = makeDom();
    imported = [];
    constructed = [];
    instances = [];
    getDrawContext = loadGetDrawContext(dom.document, dom.window);
  });

  function load() {
    class FakeHydra {
      config: Record<string, unknown>;
      // feedStrudel calls hydra.synth.s0.init({ src: canvas }).
      synth = { s0: { init() {} } };
      // A HydraRenderer owns a regl context. Upstream never destroys it — the
      // counters below are what proves that, and therefore why the widget has
      // to (see disposeHydraInstance in src/strudel-app.ts).
      hushes = 0;
      reglDestroys = 0;
      regl = { destroy: () => { this.reglDestroys++; } };
      constructor(config: Record<string, unknown>) {
        this.config = config;
        constructed.push(config);
        instances.push(this as unknown as FakeHydraLike);
      }
      hush() { this.hushes++; }
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

  // ---------------------------------------------------------------------------
  // Audit finding 7 — the two upstream facts the widget's replacement path is
  // built on. If a hydra version bump changes either, this fails here rather
  // than as a leaked WebGL context in the widget.
  // ---------------------------------------------------------------------------
  it("ABANDONS the superseded renderer on an options change — no hush, no regl.destroy", async () => {
    const { initHydra } = load();
    const first = await initHydra();
    const second = await initHydra({ feedStrudel: true });

    expect(second).not.toBe(first);
    // The whole point: upstream drops the OLD canvas but leaves the old
    // renderer (and its regl context) running. Nobody but the widget can
    // release it — see the initHydra wrapper in src/strudel-app.ts.
    expect(first.hushes).toBe(0);
    expect(first.reglDestroys).toBe(0);
    expect(instances).toHaveLength(2);
  });

  it("clearHydra() would remove the NEW canvas, so it cannot be the disposal tool", async () => {
    // Why the replacement path calls hush()/regl.destroy() on the previous
    // instance directly instead of reaching for clearHydra(): clearHydra()
    // hushes whatever `hydra` currently is (the NEW renderer) and removes the
    // NEW canvas, leaving the visible layer blank.
    const { initHydra, clearHydra } = load();
    const first = await initHydra();
    const second = await initHydra({ feedStrudel: true });
    expect(dom.document.getElementById("hydra-canvas")).not.toBeNull();

    clearHydra();
    expect(dom.document.getElementById("hydra-canvas")).toBeNull();
    expect(second.hushes).toBe(1); // the new one got hushed…
    expect(first.hushes).toBe(0); // …and the old one still was not.
  });
});

// -----------------------------------------------------------------------------
// Audit finding 6 — a refactor guard, not a behaviour test.
//
// The behaviour was verified in the dev harness with Playwright (teardown during
// a route-throttled hydra-synth import: 31 ticks after teardown before the fix,
// 0 after, and #test-canvas left display:none before, cleared after). That needs
// a real browser, a real WebGL context and a real CDN, so what is pinned here is
// the shape the fix depends on: a generation captured BEFORE the await and read
// back after it, and a stale result that returns before anything is installed.
// -----------------------------------------------------------------------------
describe("the widget's initHydra wrapper is generation-guarded", () => {
  const WIDGET = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "strudel-app.ts"),
    "utf8",
  );
  const WRAPPER = /defineWrappedGlobal\("initHydra"[\s\S]*?\n  \}\);/.exec(WIDGET)?.[0];

  it("captures the generation before awaiting and bails on a stale result", () => {
    expect(WRAPPER).toBeTruthy();
    const capture = WRAPPER!.indexOf("const generation = hydraGeneration;");
    const await_ = WRAPPER!.indexOf("await original(merged)");
    const compare = WRAPPER!.indexOf("generation !== hydraGeneration");
    const retain = WRAPPER!.indexOf("hydraInstance = instance");
    const startLoop = WRAPPER!.indexOf("startHydraTickLoop()");

    expect(capture).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(await_); // read BEFORE the await, or it is useless
    expect(compare).toBeGreaterThan(await_);
    // Nothing is installed until the staleness check has passed.
    expect(compare).toBeLessThan(retain);
    expect(compare).toBeLessThan(startLoop);
  });

  it("ends the Hydra lifetime when the layer is struck", () => {
    // setHydraActive(false) is the single teardown funnel (app.onteardown calls
    // it too), so the bump belongs there.
    const strike = /function setHydraActive\(active: boolean\): void \{[\s\S]*?\n\}/
      .exec(WIDGET)?.[0];
    expect(strike).toBeTruthy();
    expect(strike).toContain("hydraGeneration++");
    expect(strike!.indexOf("if (active) return;")).toBeLessThan(
      strike!.indexOf("hydraGeneration++"),
    );
  });

  it("disposes a superseded renderer without reaching for clearHydra()", () => {
    expect(WRAPPER).toContain("disposeHydraInstance(previous)");
    // clearHydra() would remove the canvas the NEW renderer just created — the
    // fact pinned by the contract test above. (Comments stripped: the code says
    // so in prose, and that mention is the point.)
    expect(WRAPPER!.replace(/\/\/[^\n]*/g, "")).not.toContain("clearHydra");
  });
});
