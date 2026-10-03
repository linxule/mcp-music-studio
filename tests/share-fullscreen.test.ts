import { describe, expect, it, vi } from "vitest";
import {
  enterStageFullscreen,
  leaveStageFullscreen,
  stageIsFullscreen,
  VIEWPORT_FILL_CLASS,
  type FullscreenStage,
} from "../src/share-fullscreen";

function stage(requestFullscreen?: FullscreenStage["requestFullscreen"]): FullscreenStage & { classes: Set<string> } {
  const classes = new Set<string>();
  return {
    classes,
    requestFullscreen,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
  };
}

describe("share page fullscreen", () => {
  it("uses Element Fullscreen where the browser has it", async () => {
    const s = stage(vi.fn(async () => {}));
    expect(await enterStageFullscreen(s, { fullscreenEnabled: true })).toBe("native");
    expect(s.classes.has(VIEWPORT_FILL_CLASS)).toBe(false);
  });

  it("fills the viewport where the API is missing (iPhone Safari)", async () => {
    const s = stage(undefined);
    expect(await enterStageFullscreen(s, {})).toBe("viewport");
    expect(stageIsFullscreen(s, {})).toBe(true);
    await leaveStageFullscreen(s, {});
    expect(stageIsFullscreen(s, {})).toBe(false);
  });

  it("fills the viewport where fullscreen is disabled or refused", async () => {
    const disabled = stage(vi.fn(async () => {}));
    expect(await enterStageFullscreen(disabled, { fullscreenEnabled: false })).toBe("viewport");
    expect(disabled.requestFullscreen).not.toHaveBeenCalled();
    const refused = stage(vi.fn(async () => Promise.reject(new TypeError("not allowed"))));
    expect(await enterStageFullscreen(refused, { fullscreenEnabled: true })).toBe("viewport");
    expect(refused.classes.has(VIEWPORT_FILL_CLASS)).toBe(true);
  });

  it("leaving exits native fullscreen too", async () => {
    const s = stage(vi.fn(async () => {}));
    const exitFullscreen = vi.fn(async () => {});
    await leaveStageFullscreen(s, { fullscreenElement: {}, exitFullscreen });
    expect(exitFullscreen).toHaveBeenCalled();
  });
});
