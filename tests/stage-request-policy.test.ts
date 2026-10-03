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

  it("B8: a piece that asks while the stage is open becomes the one it's open for — leaving declines IT, not the earlier piece", () => {
    const p = createPieceStagePolicy();
    expect(p.requested("A", false)).toBe(true);
    p.opened("A");
    expect(p.requested("B", true)).toBe(false); // already open: nothing to open
    p.left();
    expect(p.shouldOpen("B")).toBe(false); // B was declined
    expect(p.requested("B", false)).toBe(false); // and B's next request doesn't reopen it
    expect(p.requested("A", false)).toBe(true); // A asks afresh
  });

  it("requested() honours an earlier decline of the same piece", () => {
    const p = createPieceStagePolicy();
    p.opened("A");
    p.left();
    expect(p.requested("A", false)).toBe(false);
    expect(p.requested("A", true)).toBe(false);
  });

  it("leaving a stage the listener opened themselves declines nothing", () => {
    const p = createPieceStagePolicy();
    p.left();
    expect(p.shouldOpen("grid v1")).toBe(true);
  });
});
