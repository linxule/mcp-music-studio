// =============================================================================
// WebMCP relay — a widget's MCP Apps tools, offered to the browser's agent
//
// A widget registers its tools on the App (`registerStudioAppTools`) and only
// the HOST can call them (`AppBridge.callTool`). A browser agent never sees
// iframe tools: WebMCP (https://webmachinelearning.github.io/webmcp/) exposes
// the TOP-LEVEL document's tools only. So the page that hosts the widget lists
// the widget's tools over the bridge and re-registers each one on
// `document.modelContext`, forwarding every call back through the bridge.
//
// Generic on purpose: whatever the widget lists is mirrored — name,
// description, inputSchema, annotations — so a new widget tool appears here
// with no change. The widget's own guards (instanceId, expectedRevision) stay
// in the widget; the relay adds none and removes none.
//
// WebMCP details this relies on (spec read 2026-10-02, then measured against
// Chromium 153 with --enable-experimental-web-platform-features):
//   - `document.modelContext` (a SecureContext; `navigator.modelContext` was
//     the early-preview home, so both are tried);
//   - `registerTool(tool, { signal })` — there is no unregisterTool: aborting
//     the signal unregisters, and the tool is gone synchronously. Older
//     previews returned a handle / had `unregisterTool(name)`; both are used
//     when present, each guarded;
//   - `execute(input, { signal })` may resolve to any value; objects are
//     JSON-stringified for the agent, strings pass through;
//   - a REJECTED execute reaches the agent as a generic "Tool was executed but
//     the invocation failed" — the message is dropped. Failures here therefore
//     RESOLVE to `{ isError: true, error }` by default (`errors: "throw"` opts
//     into the spec's rejection), because a stale-revision answer is only
//     useful if the agent can read it.
// =============================================================================

export interface WidgetTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface WidgetToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

interface RequestOptions {
  signal?: AbortSignal;
  timeout?: number;
}

/** The slice of AppBridge the relay needs; a fake is enough in tests. */
export interface WidgetToolBridge {
  listTools(params: { cursor?: string }, options?: RequestOptions): Promise<{ tools: WidgetTool[]; nextCursor?: string }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }, options?: RequestOptions): Promise<WidgetToolResult>;
}

export interface WebMcpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  execute: (input: Record<string, unknown>, options?: { signal: AbortSignal }) => Promise<unknown>;
}

export interface WebMcpContext {
  registerTool(tool: WebMcpTool, options?: { signal?: AbortSignal }): unknown;
  /** Early previews only; the current spec unregisters through the signal. */
  unregisterTool?(name: string): unknown;
}

/** The page's WebMCP surface, or undefined where the browser has none. */
export function findModelContext(
  env: { document?: unknown; navigator?: unknown } = {
    document: typeof document === "undefined" ? undefined : document,
    navigator: typeof navigator === "undefined" ? undefined : navigator,
  },
): WebMcpContext | undefined {
  for (const host of [env.document, env.navigator]) {
    const candidate = (host as { modelContext?: unknown } | undefined)?.modelContext;
    if (candidate && typeof (candidate as WebMcpContext).registerTool === "function") return candidate as WebMcpContext;
  }
  return undefined;
}

/**
 * Which registration currently owns each tool name, per context. Withdrawing
 * by name (unregisterTool) is only safe for the owner: a timed-out
 * registration that settles late must not remove a newer one of the same
 * name (Codex review, 0.10).
 */
const owners = new WeakMap<object, Map<string, symbol>>();
function ownerMap(context: object): Map<string, symbol> {
  let map = owners.get(context);
  if (!map) owners.set(context, (map = new Map()));
  return map;
}

/** How long a browser's registerTool may take before the relay gives up on that tool. */
export const REGISTER_TOOL_TIMEOUT_MS = 5_000;

/**
 * Register one tool; the returned function unregisters it (idempotent, never
 * throws). A registerTool that never settles is abandoned after `ceilingMs`
 * (and aborted, so a late registration is withdrawn) instead of stalling every
 * later sync (Kimi review).
 */
export async function registerWebMcpTool(
  context: WebMcpContext,
  tool: WebMcpTool,
  ceilingMs = REGISTER_TOOL_TIMEOUT_MS,
): Promise<() => void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abandoned = false;
  const mine = Symbol(tool.name);
  const names = ownerMap(context);
  names.set(tool.name, mine);
  /** `release`: this registration is finished with the name (a late settle may still need it otherwise). */
  const unregisterByName = (release: boolean) => {
    if (names.get(tool.name) !== mine) return; // a newer registration owns the name
    if (release) names.delete(tool.name);
    try { context.unregisterTool?.(tool.name); } catch { /* never registered */ }
  };
  /** Withdraw a registration by every means a browser might offer. */
  const withdraw = (late: unknown, release: boolean) => {
    controller.abort();
    try { (late as { unregister?: () => void } | undefined)?.unregister?.(); } catch { /* already gone */ }
    unregisterByName(release);
  };
  const registration = Promise.resolve(context.registerTool(tool, { signal: controller.signal }));
  // Settled AFTER we gave up (a provider that ignores the signal, or returns a
  // handle): unregister it at once instead of leaking an untracked tool (Codex + Kimi review).
  registration.then((late) => { if (abandoned) withdraw(late, true); }, () => { /* nothing registered */ });
  const handle = await Promise.race([
    registration,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abandoned = true;
        withdraw(undefined, false);
        reject(new Error(`registerTool("${tool.name}") did not settle within ${ceilingMs} ms`));
      }, ceilingMs);
    }),
  ]).finally(() => clearTimeout(timer));
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    controller.abort();
    // Previews without signal support: a handle, or unregisterTool(name).
    try { (handle as { unregister?: () => void } | undefined)?.unregister?.(); } catch { /* already gone */ }
    unregisterByName(true);
  };
}

export interface RelayOptions {
  bridge: WidgetToolBridge;
  /** Defaults to the page's own (`findModelContext()`); without one nothing happens. */
  modelContext?: WebMcpContext;
  /**
   * Widget tools to keep off WebMCP (e.g. those that need a human review
   * panel). A function is asked on every sync, so a page can open a tool
   * later (then call refresh()).
   */
  exclude?: Iterable<string> | ((name: string) => boolean);
  /** Appended on its own line to every description. */
  descriptionSuffix?: string;
  /** Extra WebMCP annotations per tool, merged over the widget's own. */
  annotate?: (tool: WidgetTool) => Record<string, unknown> | undefined;
  /** How a failed call reaches the agent; see the header. Default "result". */
  errors?: "result" | "throw";
  /** Per-call ceiling on the widget's answer. Default 30 s. */
  callTimeoutMs?: number;
  /** A tool that could not be listed, registered or called. */
  onError?: (error: unknown, what: string) => void;
}

export interface WebMcpRelay {
  /** Names currently registered with WebMCP. */
  tools(): string[];
  /** The annotations each registered tool went to WebMCP with (diagnostics). */
  annotations(): Record<string, Record<string, unknown> | undefined>;
  /** Re-list the widget's tools and bring WebMCP in line; calls coalesce. */
  refresh(): Promise<void>;
  /** Unregister everything; later refreshes do nothing. */
  dispose(): void;
}

const MAX_PAGES = 20;

/** Text for the agent when a call fails: the widget's state carries its own `error`. */
function failureText(result: WidgetToolResult): string {
  const structured = result.structuredContent;
  if (structured && typeof structured === "object" && typeof (structured as { error?: unknown }).error === "string") {
    return (structured as { error: string }).error;
  }
  const text = (result.content ?? []).flatMap(block => (block.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("\n");
  return text || "The tool reported an error.";
}

/** What WebMCP's execute resolves to: the structured object if there is one, else the text. */
export function toWebMcpValue(result: WidgetToolResult): unknown {
  if (result.isError) {
    const structured = result.structuredContent;
    return {
      isError: true,
      error: failureText(result),
      // The widget's state after a failed edit is how the agent recovers (revision, instanceId).
      ...(structured !== undefined && structured !== null ? { structuredContent: structured } : {}),
    };
  }
  if (result.structuredContent !== undefined && result.structuredContent !== null) return result.structuredContent;
  const content = result.content ?? [];
  if (content.every(block => block.type === "text")) return content.map(block => block.text ?? "").join("\n");
  return content;
}

/**
 * Mirror the widget's tools onto the page's WebMCP context. Returns undefined
 * (and touches nothing) where the browser has no WebMCP. Call `refresh()` once
 * the widget has initialised, and again on its tools/list_changed.
 */
export function createWidgetToolRelay(options: RelayOptions): WebMcpRelay | undefined {
  const found = options.modelContext ?? findModelContext();
  if (!found) return undefined;
  const context: WebMcpContext = found;
  const { bridge } = options;
  const exclude = options.exclude;
  const excludedSet = typeof exclude === "function" ? null : new Set(exclude ?? []);
  const isExcluded = (name: string) => (typeof exclude === "function" ? exclude(name) : excludedSet!.has(name));
  const timeout = options.callTimeoutMs ?? 30_000;
  const report = options.onError ?? (() => {});
  const registered = new Map<string, { key: string; remove: () => void; annotations?: Record<string, unknown> }>();
  let disposed = false;
  let running: Promise<void> | undefined;
  let again = false;

  async function listAll(): Promise<WidgetTool[]> {
    const tools: WidgetTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const listing = await bridge.listTools(cursor ? { cursor } : {}, { timeout });
      tools.push(...listing.tools);
      cursor = listing.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  function mirror(tool: WidgetTool): WebMcpTool {
    const base = tool.description || tool.title || tool.name;
    const annotations = { ...tool.annotations, ...options.annotate?.(tool) };
    return {
      name: tool.name,
      ...(tool.title ? { title: tool.title } : {}),
      description: options.descriptionSuffix ? `${base}\n${options.descriptionSuffix}` : base,
      ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
      ...(Object.keys(annotations).length ? { annotations } : {}),
      async execute(input, executeOptions) {
        const signal = executeOptions?.signal;
        try {
          const result = await bridge.callTool({ name: tool.name, arguments: input ?? {} }, { signal, timeout });
          if (result.isError && options.errors === "throw") throw new Error(failureText(result));
          return toWebMcpValue(result);
        } catch (error) {
          // A cancelled call has no reader; a thrown error is the spec's way when asked for.
          if (signal?.aborted || options.errors === "throw") throw error;
          report(error, tool.name);
          return { isError: true, error: String((error as Error)?.message ?? error) };
        }
      },
    };
  }

  async function sync(): Promise<void> {
    const wanted = new Map<string, { tool: WidgetTool; key: string }>();
    for (const tool of await listAll()) {
      if (isExcluded(tool.name) || wanted.has(tool.name)) continue;
      wanted.set(tool.name, { tool, key: JSON.stringify([tool.title, tool.description, tool.inputSchema, tool.annotations]) });
    }
    if (disposed) return;
    for (const [name, entry] of registered) {
      if (wanted.get(name)?.key === entry.key) continue;
      entry.remove();
      registered.delete(name);
    }
    for (const [name, { tool, key }] of wanted) {
      if (registered.has(name)) continue;
      try {
        const mirrored = mirror(tool);
        const remove = await registerWebMcpTool(context, mirrored);
        if (disposed) { remove(); return; }
        registered.set(name, { key, remove, annotations: mirrored.annotations });
      } catch (error) {
        report(error, name);
      }
    }
  }

  return {
    tools: () => [...registered.keys()],
    annotations: () => Object.fromEntries([...registered].map(([name, entry]) => [name, entry.annotations])),
    refresh() {
      if (disposed) return Promise.resolve();
      if (running) { again = true; return running; }
      running = (async () => {
        try {
          do { again = false; await sync(); } while (again && !disposed);
        } finally {
          running = undefined;
        }
      })();
      return running;
    },
    dispose() {
      disposed = true;
      for (const entry of registered.values()) entry.remove();
      registered.clear();
    },
  };
}
