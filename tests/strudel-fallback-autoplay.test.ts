// =============================================================================
// Audit finding 8: the standalone /play page restarted itself after Stop.
//
// Autoplay installs a document-level click listener ("start on the first click
// anywhere", because browsers keep the AudioContext suspended until a gesture).
// It skipped clicks inside `.controls` and only removed itself when it had
// started playback ITSELF — so Play → Stop left it armed, and the next click in
// the editor re-evaluated the pattern and started the audio again.
//
// The generated page is a string, so string assertions are the cheap thing to
// write and prove nothing about ORDER of effects. This test EXECUTES the script
// the page emits, in a node:vm context over a minimal DOM stub, and clicks the
// same buttons a user would. Same approach (and same reason for hand-stubbing
// the DOM rather than adding jsdom) as tests/hydra-contract.test.ts.
// =============================================================================

import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { generateStrudelPlayerHtml } from "../src/strudel-browser-fallback";

// -----------------------------------------------------------------------------
// Minimal DOM
// -----------------------------------------------------------------------------

type Listener = (ev: any) => unknown;

interface StubEl {
  id: string;
  className: string;
  textContent: string;
  hidden: boolean;
  width: number;
  height: number;
  disabled: boolean;
  /** Which ancestor selector this element answers `closest()` for. */
  within: string | null;
  listeners: Map<string, Listener[]>;
  addEventListener(type: string, fn: Listener): void;
  removeEventListener(type: string, fn: Listener): void;
  closest(sel: string): StubEl | null;
  [key: string]: unknown;
}

function el(id: string, within: string | null = null): StubEl {
  const listeners = new Map<string, Listener[]>();
  const classes = new Set<string>();
  const self: StubEl = {
    classList: {
      add: (n: string) => classes.add(n),
      remove: (n: string) => classes.delete(n),
      contains: (n: string) => classes.has(n),
      toggle: (n: string, on?: boolean) => {
        const want = on ?? !classes.has(n);
        if (want) classes.add(n);
        else classes.delete(n);
        return want;
      },
    },
    id,
    className: "",
    textContent: "",
    hidden: false,
    width: 0,
    height: 0,
    disabled: false,
    within,
    listeners,
    addEventListener(type, fn) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
    },
    closest(sel) {
      return sel === within ? self : null;
    },
  };
  return self;
}

interface Harness {
  ctx: vm.Context;
  editorEl: StubEl;
  playBtn: StubEl;
  stopBtn: StubEl;
  doc: StubEl;
  /** The status line's current text — an "Error: …" here means a real throw. */
  status(): string;
  /** Times `editor.evaluate()` was called — i.e. how often the pattern ran. */
  evaluations(): number;
  /** The stub scheduler's state: is the pattern running? */
  started(): boolean;
  click(target: StubEl): Promise<void>;
  /** How many document-level click listeners are still armed. */
  armedAutoStart(): number;
}

function bootstrap(html: string): Harness {
  // The page's own inline script — the last <script> without a src, i.e. not
  // the JSON island and not the @strudel/repl CDN tag.
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/g)];
  expect(scripts).toHaveLength(1);
  const source = scripts[0][1];

  const initJson = /<script type="application\/json" id="init-data">([\s\S]*?)<\/script>/
    .exec(html)![1];

  let evaluations = 0;
  let started = false;

  const editorEl = el("editor");
  const playBtn = el("play-btn", ".controls");
  const stopBtn = el("stop-btn", ".controls");
  const retryBtn = el("retry-btn", ".controls");
  const statusEl = el("status", ".controls");
  const canvas = el("test-canvas");
  const initData = el("init-data");
  initData.textContent = initJson;

  // The <strudel-editor>'s `editor` — StrudelMirror's public surface, as much
  // of it as this page touches.
  (editorEl as any).editor = {
    code: JSON.parse(initJson).code,
    setCode(next: string) { (editorEl as any).editor.code = next; },
    async evaluate(shouldPlay: boolean) {
      evaluations++;
      started = shouldPlay !== false;
    },
    stop() { started = false; },
    repl: { state: { get started() { return started; } } },
  };

  const byId: Record<string, StubEl> = {
    editor: editorEl,
    "play-btn": playBtn,
    "stop-btn": stopBtn,
    "retry-btn": retryBtn,
    status: statusEl,
    "test-canvas": canvas,
    "init-data": initData,
  };

  const doc = el("#document");
  const body = el("body");
  (doc as any).getElementById = (id: string) => byId[id] ?? null;
  (doc as any).body = body;

  const win = el("window");
  (win as any).innerWidth = 800;
  (win as any).innerHeight = 600;
  (win as any).devicePixelRatio = 1;

  const ctx = vm.createContext({
    document: doc,
    window: win,
    location: { reload() {} },
    setTimeout,
    clearTimeout,
    console: { log() {}, warn() {}, error() {}, debug() {} },
  });
  (ctx as any).globalThis = ctx;

  vm.runInContext(source, ctx);

  async function click(target: StubEl): Promise<void> {
    const ev = { type: "click", target };
    for (const fn of [...(target.listeners.get("click") ?? [])]) await fn(ev);
    // Bubble to document — re-checking registration each time, because a
    // listener removed during dispatch must not be invoked (DOM semantics, and
    // exactly the mechanism the fix relies on).
    for (const fn of [...(doc.listeners.get("click") ?? [])]) {
      if ((doc.listeners.get("click") ?? []).includes(fn)) await fn(ev);
    }
    await new Promise((r) => setTimeout(r, 0));
  }

  return {
    ctx,
    editorEl,
    playBtn,
    stopBtn,
    doc,
    status: () => statusEl.textContent,
    evaluations: () => evaluations,
    started: () => started,
    click,
    armedAutoStart: () => (doc.listeners.get("click") ?? []).length,
  };
}

const CODE = 'note("c3 e3 g3").sound("piano")';

async function ready(h: Harness): Promise<void> {
  // waitForEditor() resolves through a promise chain; let it settle.
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("standalone player: autoplay never overrides an explicit Stop", () => {
  it("stays stopped when the editor is clicked after Play → Stop", async () => {
    const h = bootstrap(generateStrudelPlayerHtml({ code: CODE, autoplay: true }));
    await ready(h);
    expect(h.armedAutoStart()).toBe(1); // armed for the first gesture

    await h.click(h.playBtn);
    expect(h.status()).not.toMatch(/^Error:/);
    expect(h.evaluations()).toBe(1);
    expect(h.started()).toBe(true);
    // Play was explicit, so autoplay's job is done — it must not still be armed.
    expect(h.armedAutoStart()).toBe(0);

    await h.click(h.stopBtn);
    expect(h.started()).toBe(false);

    // THE BUG: this click used to re-evaluate and restart the pattern.
    await h.click(h.editorEl);
    expect(h.evaluations()).toBe(1);
    expect(h.started()).toBe(false);
  });

  it("stays stopped after autoplay itself started it and Stop was pressed", async () => {
    const h = bootstrap(generateStrudelPlayerHtml({ code: CODE, autoplay: true }));
    await ready(h);

    await h.click(h.editorEl); // the first gesture — autoplay's own path
    expect(h.status()).not.toMatch(/^Error:/);
    expect(h.evaluations()).toBe(1);
    expect(h.started()).toBe(true);
    expect(h.armedAutoStart()).toBe(0);

    await h.click(h.stopBtn);
    await h.click(h.editorEl);
    expect(h.evaluations()).toBe(1);
    expect(h.started()).toBe(false);
  });

  it("keeps the listener armed for a click that lands before the editor is ready", async () => {
    // The one case autoplay exists for: the page is still loading, the click
    // cannot start anything, so the NEXT click must still be able to.
    const html = generateStrudelPlayerHtml({ code: CODE, autoplay: true });
    const h = bootstrap(html);
    // Deliberately do NOT let waitForEditor settle: `ready` is still false.
    await h.click(h.editorEl);
    expect(h.evaluations()).toBe(0);
    expect(h.armedAutoStart()).toBe(1);

    await ready(h);
    await h.click(h.editorEl);
    expect(h.evaluations()).toBe(1);
    expect(h.started()).toBe(true);
  });

  it("arms nothing at all when autoplay is off", async () => {
    const h = bootstrap(generateStrudelPlayerHtml({ code: CODE, autoplay: false }));
    await ready(h);
    expect(h.armedAutoStart()).toBe(0);
    await h.click(h.editorEl);
    expect(h.evaluations()).toBe(0);
  });
});
