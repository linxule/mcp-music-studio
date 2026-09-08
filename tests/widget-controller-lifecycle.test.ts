// =============================================================================
// Codex review #3 and #4 — two ways the ABC widget destroyed work in progress.
//
// #3 The widget builds ONE SynthController and HANDS IT ON: renderAbc() creates
//    it, and an edit reuses it (so the transport doesn't flicker and the note
//    cursor keeps working) while bumping the render generation. renderAbc()'s
//    autoplay continuation then resolved into a generation that was no longer
//    current and ran `destroySynthControl(control)` — on the controller the
//    edit had just re-primed and was still driving. abcjs's destroy() stops the
//    buffer and resets the transport but never clears `isLoaded`, so the widget
//    was left with `isLoaded: true, midiBuffer: null` and the next ▶ threw.
//
// #4 `renderAbc()` called `syncEditor(abcNotation)` on EVERY render. Style,
//    instrument and sound-bank changes all re-render `state.currentAbc`, so
//    changing the Style overwrote whatever the user had typed into the editor
//    — including a draft the validator had just rejected, which is precisely
//    the text they cannot retype from the score.
//
// mcp-app.ts touches `document` at import time and pulls in CSS, so (as in
// tests/host-theme.test.ts and tests/widget-display-mode.test.ts) the wiring is
// asserted against the source. The DECISION itself is a pure function in
// abc-edit.ts and is executed here.
// =============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { staleControlAction } from "../src/abc-edit";

const ABC_APP = readFileSync(
  fileURLToPath(new URL("../src/mcp-app.ts", import.meta.url)),
  "utf8",
);

// -----------------------------------------------------------------------------
// #3 — the decision, executed
// -----------------------------------------------------------------------------

describe("staleControlAction (Codex #3)", () => {
  it("keeps a controller a NEWER generation has taken over", () => {
    // renderAbc built it as generation 1; an edit claimed it as generation 2.
    // Generation 1's autoplay resolves last and must NOT touch it.
    expect(staleControlAction({ isCurrent: true, owner: 2, generation: 1 })).toBe(
      "keep",
    );
  });

  it("retires a controller still owned by the generation that is going away", () => {
    // ontoolcancelled / onteardown bumped the generation with no new owner.
    expect(staleControlAction({ isCurrent: true, owner: 1, generation: 1 })).toBe(
      "retire",
    );
  });

  it("destroys an orphan the widget no longer holds", () => {
    expect(staleControlAction({ isCurrent: false, owner: 2, generation: 1 })).toBe(
      "destroy",
    );
    expect(staleControlAction({ isCurrent: false, owner: 0, generation: 1 })).toBe(
      "destroy",
    );
  });
});

describe("the widget's controller survives an edit mid-autoplay (Codex #3)", () => {
  /** Just enough of abcjs's SynthController to see what was done to it. */
  class FakeControl {
    destroyed = 0;
    destroy() {
      this.destroyed += 1;
    }
  }

  /** The widget's generation/ownership bookkeeping, as mcp-app.ts runs it. */
  class Widget {
    generation = 0;
    control: FakeControl | null = null;
    owner = 0;

    /** renderAbc(): a fresh controller, owned by this render. */
    startRender(): { generation: number; control: FakeControl } {
      const generation = ++this.generation;
      const control = new FakeControl();
      this.control = control;
      this.owner = generation;
      return { generation, control };
    }

    /** applyEditorAbc(): REUSES the live controller, under a new generation. */
    startEdit(): { generation: number; control: FakeControl } {
      const generation = ++this.generation;
      const control = this.control!;
      this.owner = generation;
      return { generation, control };
    }

    /** onteardown() / a fresh tool call: the widget drops its controller. */
    retire(): void {
      this.control?.destroy();
      this.control = null;
      this.owner = 0;
    }

    /** releaseStaleControl() in mcp-app.ts. */
    releaseStale(control: FakeControl, generation: number): void {
      const action = staleControlAction({
        isCurrent: this.control === control,
        owner: this.owner,
        generation,
      });
      if (action === "retire") this.retire();
      else if (action === "destroy") control.destroy();
    }
  }

  it("leaves the edited controller alive when the older autoplay lands", () => {
    const widget = new Widget();
    const render = widget.startRender();
    const edit = widget.startEdit(); // same controller, newer generation

    expect(edit.control).toBe(render.control);

    // renderAbc()'s autoplay finally resolves, in a generation that is stale.
    widget.releaseStale(render.control, render.generation);

    expect(render.control.destroyed).toBe(0);
    expect(widget.control).toBe(render.control);
  });

  it("still shuts the controller down when nothing newer claimed it", () => {
    const widget = new Widget();
    const render = widget.startRender();
    widget.generation += 1; // ontoolcancelled: newer generation, no new owner

    widget.releaseStale(render.control, render.generation);

    expect(render.control.destroyed).toBe(1);
    expect(widget.control).toBeNull();
  });

  it("destroys a controller the widget has already replaced", () => {
    const widget = new Widget();
    const first = widget.startRender();
    const second = widget.startRender(); // a second render won the race

    widget.releaseStale(first.control, first.generation);

    expect(first.control.destroyed).toBe(1);
    expect(second.control.destroyed).toBe(0);
    expect(widget.control).toBe(second.control);
  });
});

// -----------------------------------------------------------------------------
// #3 / #4 — the wiring in mcp-app.ts
// -----------------------------------------------------------------------------

describe("mcp-app.ts routes every stale cleanup through the decision (Codex #3)", () => {
  it("never destroys a controller unconditionally after an await", () => {
    // The only destroySynthControl() call sites left are retireSynthControl()
    // and releaseStaleControl() — the two places that have checked ownership.
    const callers = ABC_APP.split("\n").filter((line) =>
      /destroySynthControl\(/.test(line),
    );
    expect(callers.length).toBeGreaterThan(0);
    for (const line of callers) {
      expect(
        /function destroySynthControl|destroySynthControl\(state\.synthControl\)|destroySynthControl\(control\)/.test(
          line,
        ),
        line,
      ).toBe(true);
    }
  });

  it("takes ownership wherever it takes a controller", () => {
    expect(ABC_APP).toContain("ownSynthControl(synthControl, generation);");
    // Once in renderAbc (fresh controller) and once in applyEditorAbc (reuse).
    expect(
      ABC_APP.match(/ownSynthControl\(synthControl, generation\);/g),
    ).toHaveLength(2);
    expect(ABC_APP).toContain("synthControlOwner = generation;");
  });

  it("uses releaseStaleControl at every post-await stale branch", () => {
    // renderAbc: after setTune, and in the autoplay continuation.
    // applyEditorAbc: after setTune, and after play().
    expect(
      ABC_APP.match(/releaseStaleControl\(synthControl, generation\);/g),
    ).toHaveLength(4);
  });

  it("clears the owner when the controller is retired", () => {
    expect(ABC_APP).toMatch(
      /state\.synthControl = null;\s*\n\s*synthControlOwner = 0;/,
    );
  });
});

describe("the editor text follows external input only (Codex #4)", () => {
  it("renderAbc does not rewrite the textarea", () => {
    // Style / instrument / sound-bank changes all go through renderAbc().
    const renderAbc = ABC_APP.slice(
      ABC_APP.indexOf("async function renderAbc("),
      ABC_APP.indexOf("// MCP Apps SDK Integration"),
    );
    expect(renderAbc.length).toBeGreaterThan(500);
    expect(renderAbc).not.toContain("syncEditor(");
  });

  it("the Style selector re-renders without touching the draft", () => {
    const handler = ABC_APP.slice(
      ABC_APP.indexOf('styleSelect.addEventListener("change"'),
      ABC_APP.indexOf("const styleLabel"),
    );
    expect(handler).toContain("renderAbc(state.currentAbc)");
    expect(handler).not.toContain("syncEditor");
    expect(handler).not.toContain("editorEl.value =");
  });

  it("a new tool call DOES replace the editor text", () => {
    // ontoolinput is external replacement — the score the model just wrote
    // supersedes anything in the box, transposition included.
    const onToolInput = ABC_APP.slice(
      ABC_APP.indexOf("app.ontoolinput = (params) => {"),
      ABC_APP.indexOf("// Handle streaming/partial tool input"),
    );
    expect(onToolInput).toContain("syncEditor(abc);");
    expect(onToolInput).toContain("lastEditRendered = abc;");
  });

  it("streaming input keeps the editor in step too", () => {
    const onPartial = ABC_APP.slice(
      ABC_APP.indexOf("app.ontoolinputpartial = (params) => {"),
      ABC_APP.indexOf("app.onerror = console.error;"),
    );
    expect(onPartial).toContain("syncEditor(abcNotation);");
  });
});

describe("an audio-only transposition is said out loud (Codex #5)", () => {
  it("keeps the caveat in the status line and tells the model", () => {
    expect(ABC_APP).toContain("transposeAbcDetailed(");
    expect(ABC_APP).toContain("transposeNote = transposed.warning;");
    expect(ABC_APP).toContain("reportTransposeToModel(transposed.warning);");
    expect(ABC_APP).toContain('setStatus(withTransposeNote("Playing..."));');
    expect(ABC_APP).toContain('setStatus(withTransposeNote("Click ▶ to play"));');
  });

  it("resets the caveat on every new tool call", () => {
    expect(ABC_APP).toContain("transposeNote = null;");
  });
});
