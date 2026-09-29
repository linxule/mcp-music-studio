import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// Exercise the actual editor's early-return path, before its browser-only
// renderer. Returning a corrected draft must reach validation again.
const source = readFileSync(new URL("../src/mcp-app.ts", import.meta.url), "utf8");
const start = source.indexOf("async function applyEditorAbc(forcePlay: boolean): Promise<void> {");
const preflight = source.slice(source.indexOf("\n", start), source.indexOf("  const effective = effectiveAbc(abc);", start));
const check = new Function("feedbackVisible", "statusError", `
  const editorEl = { value: 'X:1\\nK:C\\nCDEF|' };
  const lastEditRendered = editorEl.value;
  const editorMessageEl = { hidden: !feedbackVisible };
  const statusEl = { classList: { contains: () => statusError } };
  const forcePlay = false;
  ${preflight}
  return 'revalidate';
`);

describe("ABC corrections back to the last rendered source", () => {
  it("skips an unchanged valid draft without feedback", () => {
    expect(check(false, false)).toBeUndefined();
  });
  it("revalidates after a broken intermediate draft even if restored text matches the last score", () => {
    expect(check(true, true)).toBe("revalidate");
  });
  it("revalidates a transport error or a notation warning independently", () => {
    expect(check(false, true)).toBe("revalidate");
    expect(check(true, false)).toBe("revalidate");
  });
});

const engraving = source.slice(source.indexOf("function engraveEdit("), source.indexOf("/** The audio half"));
const feedbackUpdate = engraving.slice(engraving.indexOf("  setEditorMessage("), engraving.indexOf("  return visualObj;"));
const updateFeedback = new Function("setEditorMessage", "setStatus", "messages", "withTransposeNote", feedbackUpdate);

it("clears stale error status as soon as corrected notation renders, before audio finishes", () => {
  const message = vi.fn();
  const status = vi.fn();
  updateFeedback(message, status, [], (text: string) => text);
  expect(message).toHaveBeenCalledWith(null, "warn");
  expect(status).toHaveBeenCalledWith("Score updated — preparing audio…");
});
