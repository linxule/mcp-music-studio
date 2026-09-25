// =============================================================================
// Autoplay once per tool call. Reported from Claude iOS after 0.5.8: scrolling
// a conversation restarted tunes — even paused ones — because a host that
// rebuilds a widget replays its tool input, and every fresh widget autoplayed.
// =============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  AUTOPLAY_MEMORY_KEY,
  AUTOPLAY_MEMORY_MAX,
  AutoplayMemory,
  ViewIdChannel,
  claimAutoplay,
  fnv1a,
  toolCallKey,
  viewIdOf,
  type KeyValueStore,
} from "../src/view-memory";
import { withViewId } from "../src/shared/tool-defs";

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

describe("AutoplayMemory", () => {
  it("remembers keys across instances sharing a store (a rebuilt widget)", () => {
    const store = memoryStore();
    new AutoplayMemory(() => store).remember(["view:a"]);
    expect(new AutoplayMemory(() => store).has("view:a")).toBe(true);
    expect(new AutoplayMemory(() => store).has("view:b")).toBe(false);
  });

  it("keeps only the newest entries", () => {
    const store = memoryStore();
    const memory = new AutoplayMemory(() => store);
    for (let i = 0; i < AUTOPLAY_MEMORY_MAX + 5; i++) memory.remember([`view:${i}`], i);
    const kept = JSON.parse(store.data.get(AUTOPLAY_MEMORY_KEY)!);
    expect(Object.keys(kept)).toHaveLength(AUTOPLAY_MEMORY_MAX);
    expect(memory.has("view:0")).toBe(false);
    expect(memory.has(`view:${AUTOPLAY_MEMORY_MAX + 4}`)).toBe(true);
  });

  it("survives a missing, throwing or corrupt store by remembering nothing", () => {
    expect(new AutoplayMemory(() => null).has("view:a")).toBe(false);
    const throwing: KeyValueStore = {
      getItem: () => { throw new Error("SecurityError"); },
      setItem: () => { throw new Error("QuotaExceededError"); },
    };
    const memory = new AutoplayMemory(() => throwing);
    expect(() => memory.remember(["view:a"])).not.toThrow();
    expect(memory.has("view:a")).toBe(false);
    const corrupt = memoryStore();
    corrupt.data.set(AUTOPLAY_MEMORY_KEY, "{not json");
    expect(new AutoplayMemory(() => corrupt).has("view:a")).toBe(false);
  });
});

describe("keys", () => {
  it("pairs a tool-call id with a digest of its input", () => {
    expect(toolCallKey(7, { abc: "X:1" })).toBe(`tool:7:${fnv1a('{"abc":"X:1"}')}`);
    expect(toolCallKey("7", { abc: "X:1" })).not.toBe(toolCallKey("7", { abc: "X:2" }));
    expect(toolCallKey(undefined, { abc: "X:1" })).toBeNull();
  });

  it("reads the viewUUID from a result's _meta", () => {
    expect(viewIdOf({ _meta: { viewUUID: "u1" } })).toBe("view:u1");
    expect(viewIdOf({ _meta: {} })).toBeUndefined();
    expect(viewIdOf({ _meta: { viewUUID: 3 } })).toBeUndefined();
    expect(viewIdOf(null)).toBeUndefined();
  });
});

describe("ViewIdChannel", () => {
  it("pairs a result that arrives before its input (a replay)", async () => {
    const channel = new ViewIdChannel();
    channel.put("view:a");
    await expect(channel.take()).resolves.toBe("view:a");
  });

  it("pairs a result that arrives after its input (a fresh call)", async () => {
    const channel = new ViewIdChannel();
    const taken = channel.take();
    channel.put("view:a");
    await expect(taken).resolves.toBe("view:a");
  });

  it("a cancelled input lets go, so the next result pairs with the next input (Codex review)", async () => {
    const channel = new ViewIdChannel();
    const cancelled = channel.take();
    channel.abandon();
    await expect(cancelled).resolves.toBeUndefined();
    const next = channel.take();
    channel.put("view:next");
    await expect(next).resolves.toBe("view:next");
  });

  it("keeps successive calls in order", async () => {
    const channel = new ViewIdChannel();
    const first = channel.take();
    channel.put("view:1");
    channel.put("view:2");
    await expect(first).resolves.toBe("view:1");
    await expect(channel.take()).resolves.toBe("view:2");
  });
});

describe("claimAutoplay", () => {
  it("a fresh view autoplays once; its rebuild does not", async () => {
    const store = memoryStore();
    const first = new AutoplayMemory(() => store);
    await expect(claimAutoplay(first, null, Promise.resolve("view:a"))).resolves.toBe(true);
    const rebuilt = new AutoplayMemory(() => store);
    await expect(claimAutoplay(rebuilt, null, Promise.resolve("view:a"))).resolves.toBe(false);
    await expect(claimAutoplay(rebuilt, null, Promise.resolve("view:b"))).resolves.toBe(true);
  });

  it("a known tool call is refused when its result names no view", async () => {
    const store = memoryStore();
      const memory = new AutoplayMemory(() => store);
    await claimAutoplay(memory, "tool:1:x", Promise.resolve(undefined));
    await expect(claimAutoplay(memory, "tool:1:x", Promise.resolve(undefined))).resolves.toBe(false);
  });

  it("a fresh viewUUID wins over a reused tool-call id (Codex review)", async () => {
    // Another connection may reuse JSON-RPC id 1 with the same arguments.
    const store = memoryStore();
      const memory = new AutoplayMemory(() => store);
    await claimAutoplay(memory, "tool:1:x", Promise.resolve("view:a"));
    await expect(claimAutoplay(memory, "tool:1:x", Promise.resolve("view:b"))).resolves.toBe(true);
    await expect(claimAutoplay(memory, "tool:1:x", Promise.resolve("view:a"))).resolves.toBe(false);
  });

  it("a viewUUID that arrives after the timeout is still remembered (Codex review)", async () => {
    vi.useFakeTimers();
    try {
      const store = memoryStore();
      const memory = new AutoplayMemory(() => store);
      let deliver!: (id: string) => void;
      const late = new Promise<string | undefined>((resolve) => { deliver = resolve; });
      const decided = claimAutoplay(memory, null, late, 500);
      await vi.advanceTimersByTimeAsync(500);
      await expect(decided).resolves.toBe(true);
      deliver("view:slow");
      await vi.advanceTimersByTimeAsync(0);
      expect(memory.has("view:slow")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("autoplays when the result never names a view (an older server, a slow host)", async () => {
    vi.useFakeTimers();
    try {
      const memory = new AutoplayMemory(() => memoryStore());
      const decided = claimAutoplay(memory, null, new Promise(() => {}), 500);
      await vi.advanceTimersByTimeAsync(500);
      await expect(decided).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("without storage every mount autoplays, as before", async () => {
    const memory = new AutoplayMemory(() => null);
    await expect(claimAutoplay(memory, "tool:1:x", Promise.resolve("view:a"))).resolves.toBe(true);
    await expect(claimAutoplay(memory, "tool:1:x", Promise.resolve("view:a"))).resolves.toBe(true);
  });
});

describe("withViewId", () => {
  it("adds a viewUUID and keeps existing _meta", () => {
    const result = withViewId(
      { content: [{ type: "text", text: "ok" }], _meta: { other: 1 } },
      "fixed",
    );
    expect(result._meta).toEqual({ other: 1, viewUUID: "fixed" });
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("mints a different id per call", () => {
    const a = withViewId({ content: [] })._meta?.viewUUID;
    const b = withViewId({ content: [] })._meta?.viewUUID;
    expect(typeof a).toBe("string");
    expect(a).not.toBe(b);
  });
});

describe("widget wiring", () => {
  const read = (file: string) =>
    readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), "utf8");

  for (const file of ["mcp-app.ts", "strudel-app.ts"]) {
    it(`${file} feeds results to the channel and claims every tool input`, () => {
      const src = read(file);
      expect(src).toMatch(/app\.ontoolresult = \(result\) => \{\s*viewIds\.put\(viewIdOf\(result\)\);/);
      const input = src.slice(src.indexOf("app.ontoolinput = "));
      expect(input.slice(0, 900)).toMatch(
        /const permit = claimAutoplay\(\s*autoplayMemory,\s*toolCallKey\(app\.getHostContext\(\)\?\.toolInfo\?\.id, args\),\s*viewIds\.take\(\),\s*\);/,
      );
    });
  }

  for (const file of ["mcp-app.ts", "strudel-app.ts"]) {
    it(`${file}: a cancel abandons waiting inputs, and a Play press during the wait wins`, () => {
      const src = read(file);
      const cancel = src.slice(src.indexOf("app.ontoolcancelled = "));
      expect(cancel.slice(0, 200)).toContain("viewIds.abandon();");
      expect(src).toContain("if (playPresses !== pressesAtRender) return;");
    });
  }

  it("the sheet widget's tool-call render waits on the permit before play()", () => {
    const src = read("mcp-app.ts");
    expect(src).toContain("renderAbc(abc, preparedInput.synthOptions, { autoplay: true, permit })");
    const render = src.slice(src.indexOf("async function renderAbc("));
    const permit = render.indexOf("await transport.permit");
    expect(permit).toBeGreaterThan(0);
    expect(render.indexOf("synthControl.play()")).toBeGreaterThan(permit);
  });

  it("the Strudel widget evaluates only when permitted", () => {
    const src = read("strudel-app.ts");
    expect(src).toMatch(
      /const mayAutoplay = autoplay !== false && \(permit \? await permit : true\);\s*if \(superseded\(\)\) return;[\s\S]{0,200}?if \(mayAutoplay\) \{/,
    );
  });
});
