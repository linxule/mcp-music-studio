// openStage(): when a piece's request is honoured (Kimi review, 0.11).
import { describe, expect, it } from "vitest";
import { createPieceStagePolicy } from "../src/stage-request-policy";

describe("createPieceStagePolicy", () => {
  it("honours a piece's request until the listener leaves the stage it opened", () => {
    const p = createPieceStagePolicy();
    expect(p.shouldOpen("grid v1")).toBe(true);
    p.opened("grid v1");
    p.left();
    expect(p.shouldOpen("grid v1")).toBe(false); // the same piece again: respect the decline
  });

  it("a different piece asks afresh — one decline doesn't silence every later piece", () => {
    const p = createPieceStagePolicy();
    p.opened("grid v1");
    p.left();
    expect(p.shouldOpen("a chord wheel")).toBe(true);
  });

  it("leaving a stage the listener opened themselves declines nothing", () => {
    const p = createPieceStagePolicy();
    p.left();
    expect(p.shouldOpen("grid v1")).toBe(true);
  });
});
