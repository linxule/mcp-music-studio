import { afterEach, describe, expect, it, vi } from "vitest";
import type { App } from "@modelcontextprotocol/ext-apps";
import { askAboutSelectionMessage, chatHandoff, lineRange } from "../src/studio-handoff";
import { installStudioReviewPanel, reviewPanelMode } from "../src/studio-review-panel";
import { createStudioSession, type StudioSnapshot } from "../src/studio-session";
import { studioSchemasFor } from "../src/studio-schemas";

describe("passage review: which hosts get the full panel", () => {
  it("keeps the full panel only for the dev harness, which drives the review tools", () => {
    expect(reviewPanelMode("MusicStudioDevHost")).toBe("full");
    for (const host of ["Claude", "claude-ai", "Music Studio share page", "", undefined]) {
      expect(reviewPanelMode(host)).toBe("compact");
    }
  });
});

describe("lineRange", () => {
  const src = "a\nbb\nccc\n";
  it("names the lines a selection touches", () => {
    expect(lineRange(src, 0, 1)).toEqual({ first: 1, last: 1 });
    expect(lineRange(src, 2, 8)).toEqual({ first: 2, last: 3 });
  });
  it("keeps a selection that ends on a line break on its last line", () => {
    expect(lineRange(src, 2, 5)).toEqual({ first: 2, last: 2 });
  });
  it("clamps offsets outside the source", () => {
    expect(lineRange(src, -4, 99)).toEqual({ first: 1, last: 4 });
  });
});

describe("askAboutSelectionMessage", () => {
  it("is plain: the question, the language, the lines and the passage — no studio tools or ids", () => {
    const text = askAboutSelectionMessage({ mode: "live", text: 's("bd sd")', lines: { first: 3, last: 5 } });
    expect(text).toBe('Explain this passage and suggest one small change.\n\nMusic Studio — Strudel, lines 3–5:\n\n```\ns("bd sd")\n```');
    expect(text).not.toMatch(/explain-selection|suggest-edit|requestId|instanceId/);
  });
  it("names ABC notation and a single line", () => {
    const text = askAboutSelectionMessage({ mode: "score", text: "CDEF|", lines: { first: 4, last: 4 } });
    expect(text).toContain("Music Studio — ABC notation, line 4:");
  });
  it("tells the model about update-session only in a live session", () => {
    expect(askAboutSelectionMessage({ mode: "live", text: "x", inSession: true })).toContain("update-session");
    expect(askAboutSelectionMessage({ mode: "live", text: "x" })).not.toContain("update-session");
  });
  it("uses a fence longer than any backtick run in the passage", () => {
    const text = askAboutSelectionMessage({ mode: "live", text: "note(`c e g`) // ```" });
    expect(text).toContain("\n````\nnote(`c e g`) // ```\n````");
  });
  it("leaves the dev harness's full handoff text as it was", () => {
    const passage = { instanceId: "i", mode: "live" as const, revision: 1, from: 0, to: 2, text: "bd" };
    const text = chatHandoff({ requestId: "r1", passage, question: "Why?", explanation: "", stale: false } as never);
    expect(text).toContain("explain-selection/suggest-edit");
    expect(text).toContain("Review requestId: r1");
  });
});

// --- A minimal DOM, enough for the installer (no jsdom in this package). ---
class FakeEl extends EventTarget {
  id = ""; className = ""; hidden = false; textContent = ""; innerHTML = ""; type = ""; title = ""; value = "";
  open = false; disabled = false; removed = false;
  attrs = new Map<string, string>();
  placedAfter: FakeEl | null = null;
  appendedTo: FakeEl | null = null;
  private parts = new Map<string, FakeEl>();
  classList = { toggle: () => {} };
  constructor(public tagName: string) { super(); }
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
  after(...els: FakeEl[]) { for (const el of els) el.placedAfter = this; }
  append(...els: FakeEl[]) { for (const el of els) el.appendedTo = this; }
  insertBefore(el: FakeEl) { el.appendedTo = this; }
  remove() { this.removed = true; }
  focus() {}
  select() {}
  contains() { return false; }
  querySelector(sel: string) {
    if (!this.parts.has(sel)) this.parts.set(sel, new FakeEl(sel));
    return this.parts.get(sel)!;
  }
  click() { this.dispatchEvent(new Event("click")); }
}

function fakeDocument(ids: string[]) {
  const byId = new Map(ids.map((id) => {
    const el = new FakeEl("button");
    el.id = id;
    return [id, el] as const;
  }));
  const created: FakeEl[] = [];
  const main = new FakeEl("main");
  const doc = Object.assign(new EventTarget(), {
    documentElement: { dataset: {} as Record<string, string> },
    body: new FakeEl("body"),
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: (tag: string) => {
      const el = new FakeEl(tag);
      created.push(el);
      return el;
    },
    querySelector: (sel: string) => (sel === "main" ? main : null),
  });
  return { doc, byId, created };
}

function fakeApp(hostName: string, caps: { message?: object } = { message: {} }) {
  let connected = false;
  const sendMessage = vi.fn(async (_m: unknown) => ({}));
  const app = {
    getHostVersion: () => (connected ? { name: hostName, version: "1" } : undefined),
    getHostCapabilities: () => (connected ? caps : undefined),
    connect: async () => { connected = true; },
    sendMessage,
    updateModelContext: vi.fn(async () => ({})),
  };
  return { app: app as unknown as App & typeof app, sendMessage };
}

const sessions: Array<{ dispose(): void }> = [];
afterEach(() => {
  sessions.splice(0).forEach((s) => s.dispose());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function liveSession(selection: StudioSnapshot["selection"]) {
  const code = 'setcps(0.5)\ns("bd sd")\nnote("c e g")';
  const draft: StudioSnapshot = { args: { code, title: "T" }, playback: "stopped", error: null, status: "Ready", selection };
  const session = createStudioSession(
    { read: () => structuredClone(draft), apply: async () => {}, play: async () => {}, stop: () => {} },
    { mode: "live", schemas: studioSchemasFor("live") },
  );
  sessions.push(session);
  return { session, draft, code };
}

describe("installStudioReviewPanel in a chat host", () => {
  it("waits for the handshake, then adds one button beside Send to chat — no panel, no shared review", async () => {
    const { doc, byId, created } = fakeDocument(["send-btn", "end-btn"]);
    vi.stubGlobal("document", doc);
    const { app, sendMessage } = fakeApp("Claude");
    const { session, code } = liveSession({ from: 12, to: 22, text: 's("bd sd")' });
    byId.get("end-btn")!.hidden = false; // a joined live session
    installStudioReviewPanel(app, session);
    expect(created).toHaveLength(0); // host unknown before connect()
    await app.connect();
    expect(created.some((el) => el.tagName === "details")).toBe(false);
    const button = created.find((el) => el.id === "ask-selection-btn")!;
    expect(button.placedAfter).toBe(byId.get("send-btn"));
    await vi.waitFor(() => expect(button.hidden).toBe(false));

    button.click();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    const text = (sendMessage.mock.calls[0][0] as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain('s("bd sd")');
    expect(text).toContain("Strudel, line 2:");
    expect(text).toContain("update-session");
    expect(code.slice(12, 22)).toBe('s("bd sd")');
    expect((await session({ action: "get" })).sharedReview).toBeNull();
  });

  it("stays hidden with nothing selected", async () => {
    const { doc, created } = fakeDocument(["send-btn"]);
    vi.stubGlobal("document", doc);
    const { app } = fakeApp("Claude");
    const { session } = liveSession({ from: 4, to: 4, text: "" });
    installStudioReviewPanel(app, session);
    await app.connect();
    const button = created.find((el) => el.id === "ask-selection-btn")!;
    await new Promise((r) => setTimeout(r, 20));
    expect(button.hidden).toBe(true);
  });

  it("copies inside the click when the host has no ui/message", async () => {
    const { doc, created } = fakeDocument(["send-btn"]);
    vi.stubGlobal("document", doc);
    const writeText = vi.fn(async (_t: string) => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { app, sendMessage } = fakeApp("Some host", {});
    const { session } = liveSession({ from: 12, to: 22, text: 's("bd sd")' });
    installStudioReviewPanel(app, session);
    await app.connect();
    const button = created.find((el) => el.id === "ask-selection-btn")!;
    await vi.waitFor(() => expect(button.hidden).toBe(false));
    button.click();
    expect(writeText).toHaveBeenCalledOnce(); // synchronously, within the gesture
    expect(writeText.mock.calls[0][0]).toContain('s("bd sd")');
    expect(writeText.mock.calls[0][0]).not.toContain("update-session");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("is removed with the widget's studio session", async () => {
    const { doc, created } = fakeDocument(["send-btn"]);
    vi.stubGlobal("document", doc);
    const { app } = fakeApp("Claude");
    const { session } = liveSession({ from: 0, to: 0, text: "" });
    installStudioReviewPanel(app, session);
    await app.connect();
    session.dispose();
    expect(created.find((el) => el.id === "ask-selection-btn")!.removed).toBe(true);
  });
});

describe("installStudioReviewPanel — review fixes (0.10.2)", () => {
  it("mounts nothing when the widget is torn down before its handshake, and the connection still succeeds", async () => {
    const { doc, created } = fakeDocument(["send-btn"]);
    vi.stubGlobal("document", doc);
    const { app } = fakeApp("MusicStudioDevHost");
    const { session } = liveSession({ from: 0, to: 0, text: "" });
    installStudioReviewPanel(app, session);
    session.dispose();
    await expect(app.connect()).resolves.toBeUndefined();
    expect(created).toHaveLength(0);
  });

  it("gives a host that never names itself the compact button, not nothing", async () => {
    const { doc, created } = fakeDocument(["send-btn"]);
    vi.stubGlobal("document", doc);
    const { app } = fakeApp("Claude");
    (app as { getHostVersion: () => unknown }).getHostVersion = () => undefined;
    const { session } = liveSession({ from: 0, to: 0, text: "" });
    installStudioReviewPanel(app, session);
    await app.connect();
    expect(created.some((el) => el.id === "ask-selection-btn")).toBe(true);
  });

  it("never sends after the widget is gone", async () => {
    const { doc, created } = fakeDocument(["send-btn"]);
    vi.stubGlobal("document", doc);
    const { app, sendMessage } = fakeApp("Claude");
    const { session } = liveSession({ from: 12, to: 22, text: 's("bd sd")' });
    installStudioReviewPanel(app, session);
    await app.connect();
    const button = created.find((el) => el.id === "ask-selection-btn")!;
    await vi.waitFor(() => expect(button.hidden).toBe(false));
    button.click();
    session.dispose();
    await new Promise((r) => setTimeout(r, 20));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not copy a selection it has not read back yet", async () => {
    const { doc, created } = fakeDocument(["send-btn"]);
    vi.stubGlobal("document", doc);
    const writeText = vi.fn(async (_t: string) => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { app } = fakeApp("Some host", {});
    const { session, draft } = liveSession({ from: 12, to: 22, text: 's("bd sd")' });
    installStudioReviewPanel(app, session);
    await app.connect();
    const button = created.find((el) => el.id === "ask-selection-btn")!;
    await vi.waitFor(() => expect(button.hidden).toBe(false));
    // The listener selects something else and clicks at once.
    draft.selection = { from: 23, to: 36, text: 'note("c e g")' };
    doc.dispatchEvent(new Event("selectionchange"));
    button.click();
    expect(writeText).not.toHaveBeenCalled();
    expect(button.textContent).toBe("One moment — tap again");
    // Once read back, the next click copies the NEW selection.
    await new Promise((r) => setTimeout(r, 20));
    button.click();
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText.mock.calls[0][0]).toContain('note("c e g")');
  });
});

describe("installStudioReviewPanel in the dev harness", () => {
  it("mounts the full panel and no Ask button", async () => {
    const { doc, created } = fakeDocument(["send-btn"]);
    vi.stubGlobal("document", doc);
    const { app } = fakeApp("MusicStudioDevHost");
    const { session } = liveSession({ from: 0, to: 0, text: "" });
    installStudioReviewPanel(app, session);
    await app.connect();
    const panel = created.find((el) => el.tagName === "details");
    expect(panel?.id).toBe("studio-review-panel");
    expect(created.some((el) => el.id === "ask-selection-btn")).toBe(false);
  });

  it("decides at once when installed after the handshake", async () => {
    const { doc, created } = fakeDocument(["send-btn"]);
    vi.stubGlobal("document", doc);
    const { app } = fakeApp("MusicStudioDevHost");
    await app.connect();
    const { session } = liveSession({ from: 0, to: 0, text: "" });
    installStudioReviewPanel(app, session);
    expect(created.find((el) => el.tagName === "details")?.id).toBe("studio-review-panel");
  });

  it("does nothing on the standalone studio page", async () => {
    const { doc, created } = fakeDocument(["send-btn"]);
    doc.documentElement.dataset.studio = "1";
    vi.stubGlobal("document", doc);
    const { app } = fakeApp("Claude");
    const { session } = liveSession({ from: 0, to: 0, text: "" });
    installStudioReviewPanel(app, session);
    await app.connect();
    expect(created).toHaveLength(0);
  });
});
