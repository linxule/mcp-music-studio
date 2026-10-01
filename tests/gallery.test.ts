// The gallery (src/strudel-gallery.ts): complete pieces the guide hands to a
// model as worked examples. Every one must evaluate cleanly, produce events,
// run its frame/event callbacks without throwing, use only registered sounds —
// and show the stage runtime, not the plumbing it replaced.
import { describe, expect, it } from "vitest";
import { GALLERY_IDS, STRUDEL_GALLERY, galleryIndex } from "../src/strudel-gallery";
import { validateStrudelInProcess } from "../src/shared/strudel-validate-core";
import { evalStrudelSandboxed, queryHaps, setupStrudel } from "../src/shared/strudel-eval";

/** Hand-built plumbing the stage runtime replaced (cycle/onFrame/onTap/say). */
const REPLACED_PLUMBING = [
  "requestAnimationFrame",
  "speechSynthesis",
  "getTime",
  "H(signal",
  "addEventListener('pointerdown'",
];

describe("gallery pieces", () => {
  it.each(STRUDEL_GALLERY.map((p) => [p.id, p] as const))(
    "%s evaluates, sounds, and its callbacks run",
    async (_id, piece) => {
      const result = await validateStrudelInProcess(piece.code, { timeoutMs: 8000 });
      expect(result.error, piece.id).toBeUndefined();
      expect(result.ok).toBe(true);
      expect(result.eventsPerCycle).toBeGreaterThan(0);
      // An onFrame/onEvent callback that throws on the validator's test frame.
      expect(result.warnings).toBeUndefined();
      expect(result.unregistered ?? []).toEqual([]);
    },
  );

  it.each(STRUDEL_GALLERY.map((p) => [p.id, p] as const))(
    "%s uses the stage runtime, not the plumbing it replaced",
    (_id, piece) => {
      for (const needle of REPLACED_PLUMBING) {
        expect(piece.code.includes(needle), `${piece.id} still contains ${needle}`).toBe(false);
      }
      expect(piece.code).not.toContain("`");
    },
  );

  it("the modernised pieces actually use the primitives", () => {
    const byId = Object.fromEntries(STRUDEL_GALLERY.map((p) => [p.id, p.code]));
    expect(byId["first-light"]).toMatch(/onFrame\(frame\)/);
    expect(byId["first-light"]).toMatch(/onEvent\(hook,/);
    expect(byId["duet"]).toMatch(/say\(line, \{ voice: VOICE \}\)/);
    expect(byId["duet"]).toMatch(/onTap\(tp =>/);
    expect(byId["duet"]).toMatch(/tp\.next\(16\)/);
    expect(byId["petri-dish"]).toMatch(/onTap\(tp =>/);
    expect(byId["lossy-terminal"]).toMatch(/onFrame\(draw\)/);
  });

  // A single-quoted mask string is NOT parsed as mini-notation in every
  // evaluator — the first draft played every line in every bar. Pin the bars.
  it("DUET speaks each line on its own bar of the 32-bar loop, and only there", async () => {
    await setupStrudel();
    const duet = STRUDEL_GALLERY.find((p) => p.id === "duet")!.code;
    const { pattern, error } = await evalStrudelSandboxed(duet, { timeoutMs: 8000 });
    expect(error).toBeUndefined();
    const bars = new Set<number>();
    for (const hap of queryHaps(pattern!, 64).haps as any[]) {
      const s = hap.value?.s;
      if (typeof s === "string" && s.startsWith("say_") && hap.hasOnset()) bars.add(Number(hap.whole.begin));
    }
    expect([...bars].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 20, 28, 30, 32, 33, 34, 35, 52, 60, 62]);
  });

  it("ids and the index agree", () => {
    expect(STRUDEL_GALLERY.map((p) => p.id)).toEqual([...GALLERY_IDS]);
    const index = galleryIndex();
    for (const id of GALLERY_IDS) expect(index).toContain(`id: ${id}`);
    expect(index).toContain('get-strudel-guide({ topic: "gallery", piece: "<id>" })');
  });
});

describe("get-strudel-guide serves the gallery", () => {
  it("lists the pieces in topic 'gallery' and hands back one piece's full code with `piece`", async () => {
    const { buildStrudelGuideResult } = await import("../src/shared/tool-defs");
    const index = buildStrudelGuideResult({ topic: "gallery" }).content[0] as { text: string };
    expect(index.text).toContain('piece: "first-light"');
    const duet = buildStrudelGuideResult({ topic: "gallery", piece: "duet" }).content[0] as { text: string };
    expect(duet.text).toContain("# DUET");
    expect(duet.text).toContain("say(");
    expect(duet.text).toContain("onTap(");
  });
});
