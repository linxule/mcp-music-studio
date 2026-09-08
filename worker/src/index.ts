// =============================================================================
// MCP Music Studio — Cloudflare Worker
//
// Remote MCP server for one-paste setup. Stateless handler (new server per
// request) using createMcpHandler + WorkerTransport — matches the official
// ext-apps example pattern for reliable UI rendering in Claude Desktop.
//
// Tool names, schemas, descriptions, annotations, _meta, instructions, and the
// search-music-docs behavior are imported from ../../src/shared/tool-defs so
// they never drift from the local stdio/HTTP server (server.ts).
// =============================================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
// abcjs runs parse-only here (no DOM touched at import time — its one browser
// polyfill is wrapped in try/catch), which is what convert-abc-to-strudel needs.
import ABCJS from "abcjs";

// Shared guide content (pure data, no Node.js deps)
import { ABC_GUIDE_TOPICS, ABC_GUIDES } from "../../src/abc-guide.js";
import { STRUDEL_GUIDE_TOPICS, STRUDEL_GUIDES } from "../../src/strudel-guide.js";
import { VERSION } from "../../src/version.js";
import { parseClient } from "../../src/shared/parse-client.js";
import {
  SHEET_RESOURCE_URI,
  STRUDEL_RESOURCE_URI,
  SERVER_INSTRUCTIONS,
  advertiseUiExtension,
  PLAY_TOOL_ANNOTATIONS,
  GUIDE_TOOL_ANNOTATIONS,
  SEARCH_TOOL_ANNOTATIONS,
  SHEET_CSP,
  STRUDEL_CSP,
  PLAY_SHEET_BASE_DESCRIPTION,
  PLAY_SHEET_EXT_APPS_SUFFIX,
  playSheetInputSchema,
  PLAY_LIVE_BASE_DESCRIPTION,
  PLAY_LIVE_EXT_APPS_SUFFIX,
  playLiveInputSchema,
  buildPlayLiveResult,
  PLAY_LIVE_UNVALIDATED_REMOTE,
  GET_MUSIC_GUIDE_DESCRIPTION,
  GET_MUSIC_GUIDE_TOPIC_DESCRIPTION,
  GET_STRUDEL_GUIDE_DESCRIPTION,
  GET_STRUDEL_GUIDE_TOPIC_DESCRIPTION,
  SEARCH_DOCS_DESCRIPTION,
  searchDocsInputSchema,
  searchMusicDocs,
  ANALYZE_HARMONY_ANNOTATIONS,
  ANALYZE_HARMONY_DESCRIPTION,
  analyzeHarmonyInputSchema,
  buildAnalyzeHarmonyResult,
  CONVERT_ABC_ANNOTATIONS,
  CONVERT_ABC_DESCRIPTION,
  convertAbcInputSchema,
  buildConvertAbcResult,
  registerMusicPrompts,
  WORKER_SERVER_ICONS,
  WEBSITE_URL,
  uiToolMeta,
  attachPlayLink,
} from "../../src/shared/tool-defs.js";
import type { ParseOnlyFn } from "../../src/shared/abc-to-strudel.js";
// Same ABC validation as the local server: abcjs is already in this bundle for
// convert-abc-to-strudel and the /score share route, so there is no new weight.
import {
  createPlaySheetMusicResult,
  type ParseOnlyFn as SheetParseOnlyFn,
} from "../../src/server-logic.js";
import {
  DEFAULT_SHARE_ORIGIN,
  SHARE_PARAM_MAX_BYTES,
  SHARE_TTL_SECONDS,
  ShareParamError,
  clampShareNumber,
  type ShareNumberKey,
  buildPlayerCsp,
  buildShareQueryUrl,
  buildStoredShareUrl,
  isValidShareId,
  parsePlaySearchParams,
  parseScoreSearchParams,
  shareId,
  shareKvKey,
  toPlayShareArgs,
  type SharePayload,
} from "../../src/shared/share-url.js";
import { ABCJS_CDN_BASE } from "../../src/abcjs-version.js";
// The two standalone player pages `--render-mode browser` writes to disk. Both
// generators are node-free (see src/open-in-browser.ts for the half that isn't).
import { generatePlayerHtml } from "../../src/browser-fallback.js";
import { generateStrudelPlayerHtml } from "../../src/strudel-browser-fallback.js";

// Bundled ext-apps HTML (wrangler imports as text via rules config)
import sheetMusicHtml from "../../dist/mcp-app.html";
import strudelHtml from "../../dist/strudel-app.html";

// =============================================================================
// Types
// =============================================================================

type Env = {
  ANALYTICS: AnalyticsEngineDataset;
  DOCS_CACHE: KVNamespace;
  CONTEXT7_API_KEY: string;
};

// =============================================================================
// Analytics
// =============================================================================

function track(
  env: Env,
  data: { blobs: string[]; doubles?: number[]; indexes: string[] },
) {
  try {
    env.ANALYTICS?.writeDataPoint(data);
  } catch {}
}

function trackRequest(env: Env, ctx: ExecutionContext, request: Request) {
  const rawUA = request.headers.get("user-agent") ?? "";
  const client = parseClient(rawUA);
  // Only retain the raw UA for clients we don't recognize (to discover new ones);
  // the coarse `client` label already covers known clients. Data minimization.
  const uaForLog = client === "unknown" ? rawUA.substring(0, 200) : "";

  if (request.method === "GET") {
    // A bare GET /mcp is not a real session in stateless mode (it 406s) — label
    // it "probe" so it isn't conflated with POST-initiated sessions.
    track(env, {
      blobs: ["probe", "", "", uaForLog],
      indexes: [client],
    });
    return;
  }

  if (request.method !== "POST") return;

  const cloned = request.clone();
  ctx.waitUntil(
    cloned
      .json()
      .then((body: any) => {
        const method = body?.method ?? "unknown";

        if (method === "tools/call") {
          const tool = body.params?.name ?? "";
          const args = body.params?.arguments ?? {};
          let detail = "";
          if (tool === "get-music-guide" || tool === "get-strudel-guide") {
            detail = args.topic ?? "";
          } else if (tool === "search-music-docs") {
            detail = args.library ?? "strudel";
          }
          track(env, {
            blobs: ["tool_call", tool, detail, uaForLog],
            indexes: [client],
          });
        } else if (method === "resources/read") {
          const uri = body.params?.uri ?? "";
          track(env, {
            blobs: ["resource_read", uri, "", uaForLog],
            indexes: [client],
          });
        } else {
          // initialize, tools/list, resources/list, etc.
          track(env, {
            blobs: ["mcp_method", method, "", uaForLog],
            indexes: [client],
          });
        }
      })
      .catch(() => {}),
  );
}

// =============================================================================
// Constants
// =============================================================================

const EXT_APPS_MIME = "text/html;profile=mcp-app" as const;

// =============================================================================
// Widget build identity
// =============================================================================
//
// The worker inlines dist/mcp-app.html and dist/strudel-app.html at BUILD time,
// so a deploy that skipped `bun run build` serves stale widgets while VERSION
// still reads current. /health therefore reports a fingerprint of the HTML that
// is actually bundled, letting a stale deploy be spotted from outside.
//
// FNV-1a: a few lines, synchronous (crypto.subtle is async and can't run at
// module scope), and identity is all that's wanted here — not collision
// resistance against an adversary.

function widgetFingerprint(html: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < html.length; i++) {
    hash ^= html.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, "0")}-${html.length}`;
}

export const WIDGET_BUILD = {
  abc: widgetFingerprint(sheetMusicHtml),
  strudel: widgetFingerprint(strudelHtml),
} as const;

// =============================================================================
// Share links ("Tier 3") — a URL that actually plays
// =============================================================================
//
// Hosts without ext-apps (Claude Code, CLIs, mobile web, anything hitting this
// Worker from a terminal) never render the widget, so a play tool used to end
// at "nothing has played yet". These routes serve the same standalone pages the
// local `--render-mode browser` path writes to disk, and the tool results link
// to them.
//
// Short patterns travel in the query string — stateless, no storage, and the
// link keeps working across a KV wipe. Anything longer is stored in KV under a
// content digest and served from /p/<id>. The namespace is the existing
// DOCS_CACHE, keyed under a `share:` prefix, so no new binding is needed.

/** Response headers shared by every hosted player page. */
function playerResponse(html: string, csp: string): Response {
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp,
      // A share link is somebody's scratch pattern, not a page to index.
      "x-robots-tag": "noindex, nofollow",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      // Content-addressed, or fully self-describing — safe to cache.
      "cache-control": "public, max-age=3600",
    },
  });
}

// Derived from the very constants the widgets declare, so a domain added for a
// widget reaches the hosted page too. The sheet page additionally loads abcjs
// itself from jsDelivr (the widget bundles it, hence no resourceDomains there).
const STRUDEL_PAGE_CSP = buildPlayerCsp(STRUDEL_CSP);
const SHEET_PAGE_CSP = buildPlayerCsp({
  resourceDomains: [new URL(ABCJS_CDN_BASE).origin],
  connectDomains: SHEET_CSP.connectDomains,
});

function renderSharePayload(payload: SharePayload): Response {
  return payload.kind === "play"
    ? playerResponse(generateStrudelPlayerHtml(payload.args), STRUDEL_PAGE_CSP)
    : playerResponse(generatePlayerHtml(payload.args), SHEET_PAGE_CSP);
}

function shareError(err: unknown): Response {
  const status = err instanceof ShareParamError ? err.status : 400;
  const message =
    err instanceof ShareParamError ? err.message : "Malformed share link.";
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-robots-tag": "noindex",
    },
  });
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Read a request body, refusing it the moment it passes `maxBytes`.
 *
 * `await request.text()` buffered the WHOLE body before the size check, so the
 * 64 KiB cap on POST /share only described what was accepted, not what was
 * read: a chunked 2 MiB upload with no `Content-Length` was pulled into the
 * isolate in full and only then answered with a 413. A `Content-Length` header
 * over the cap is still rejected earlier and more cheaply — this is the floor
 * for the case where the sender simply doesn't declare one.
 *
 * The stream is cancelled on the same iteration that crosses the cap, so the
 * sender stops rather than being drained politely.
 *
 * Exported for tests/worker-share-hardening.test.ts, which drives it with a
 * stream that records whether it was cancelled and how much it handed over.
 */
export async function readBodyWithinLimit(
  request: Request,
  maxBytes: number,
): Promise<string> {
  const body = request.body;
  if (!body) return "";

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // Don't await forever on a peer that won't acknowledge the cancel.
        void reader.cancel().catch(() => {});
        throw new ShareParamError("Share body is too large.", 413);
      }
      chunks.push(value as Uint8Array);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released by cancel() — nothing to undo */
    }
  }

  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  // Non-fatal: mangled bytes become U+FFFD and JSON.parse then answers 400,
  // which is the same outcome request.text() produced.
  return new TextDecoder().decode(joined);
}

/**
 * Validate an untrusted share payload down to the exact fields the generators
 * read. Anything else is dropped rather than stored — a share must never become
 * a way to smuggle extra keys into a page generator.
 */
function coerceSharePayload(raw: unknown): SharePayload {
  const body = raw as { kind?: unknown; args?: unknown } | null;
  const args = (body?.args ?? {}) as Record<string, unknown>;

  const str = (
    v: unknown,
    field: string,
    required = false,
  ): string | undefined => {
    if (v === undefined || v === null) {
      if (required) throw new ShareParamError(`Missing "${field}".`, 400);
      return undefined;
    }
    if (typeof v !== "string") {
      throw new ShareParamError(`"${field}" must be a string.`, 400);
    }
    if (byteLength(v) > SHARE_PARAM_MAX_BYTES) {
      throw new ShareParamError(`"${field}" exceeds the size limit.`, 413);
    }
    return v;
  };
  // Finiteness was the only check here, so a stored share could carry
  // `bpm: 1e9` (baked as setcps(4166666)) or `tempo: -1e9`. Clamp to the same
  // ranges the tool schemas declare — see SHARE_NUMBER_BOUNDS.
  const num = (v: unknown, field: ShareNumberKey): number | undefined => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new ShareParamError(`"${field}" must be a number.`, 400);
    }
    return clampShareNumber(field, v);
  };

  if (body?.kind === "play") {
    return {
      kind: "play",
      args: {
        code: str(args.code, "code", true)!,
        bpm: num(args.bpm, "bpm"),
        title: str(args.title, "title"),
        autoplay: typeof args.autoplay === "boolean" ? args.autoplay : undefined,
      },
    };
  }
  if (body?.kind === "score") {
    return {
      kind: "score",
      args: {
        abcNotation: str(args.abcNotation, "abcNotation", true)!,
        title: str(args.title, "title"),
        instrument: str(args.instrument, "instrument"),
        style: str(args.style, "style"),
        tempo: num(args.tempo, "tempo"),
        swing: num(args.swing, "swing"),
        drumIntro: num(args.drumIntro, "drumIntro"),
        transpose: num(args.transpose, "transpose"),
      },
    };
  }
  throw new ShareParamError('"kind" must be "play" or "score".', 400);
}

// -----------------------------------------------------------------------------
// Rate limiting the public POST /share route
// -----------------------------------------------------------------------------
//
// /share is unauthenticated and each accepted request can write a 30-day KV
// entry. The per-request caps (64 KiB body, coerced fields) bound the SIZE of
// one share but not the NUMBER of them, so one address could fill the namespace
// at whatever rate it liked.
//
// A fixed window per IP is enough here: this is anti-flood, not a quota system,
// and the ids are content digests, so the same pattern posted repeatedly
// rewrites one key rather than consuming the budget's worth of storage. The
// limiter is deliberately best-effort — if KV can't answer, the request goes
// through rather than the route going down.
//
// The tool handlers reach the same logic IN-PROCESS via shareUrlFor(), which
// never passes through here: they are not the public route, and their rate is
// already bounded by whatever is calling the MCP server.

/** Accepted POST /share requests per IP per window. */
export const SHARE_RATE_LIMIT_MAX = 30;

/** Length of the fixed window, in seconds. */
export const SHARE_RATE_LIMIT_WINDOW_SECONDS = 60 * 60;

/** KV key for one address's bucket. Namespaced alongside `share:` and the docs cache. */
export function shareRateLimitKey(ip: string): string {
  return `ratelimit:share:${ip}`;
}

interface ShareRateBucket {
  /** Requests counted so far in this window. */
  n: number;
  /** Unix seconds at which the window ends. */
  reset: number;
}

function parseBucket(raw: string | null, now: number): ShareRateBucket | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ShareRateBucket>;
    if (typeof parsed?.n !== "number" || typeof parsed?.reset !== "number") {
      return null;
    }
    // Expired windows are treated as absent — KV's own TTL is the backstop,
    // not the source of truth, so a clock skew can't lock anyone out.
    return parsed.reset <= now ? null : { n: parsed.n, reset: parsed.reset };
  } catch {
    return null;
  }
}

/**
 * Count this request against the caller's bucket.
 *
 * Returns a 429 when the window is already full, `null` when the request may
 * proceed. The counter is NOT incremented once the limit is hit, so the window
 * expires on schedule instead of sliding forward under a sustained flood.
 */
async function enforceShareRateLimit(
  env: Env,
  request: Request,
): Promise<Response | null> {
  const kv = env.DOCS_CACHE;
  if (!kv) return null;

  // Cloudflare sets CF-Connecting-IP on every edge request; the fallback bucket
  // only matters for local `wrangler dev` and tests.
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const key = shareRateLimitKey(ip);
  const now = Math.floor(Date.now() / 1000);

  let bucket: ShareRateBucket | null;
  try {
    bucket = parseBucket(await kv.get(key), now);
  } catch {
    return null; // KV is unwell — don't take the route down with it.
  }

  if (bucket && bucket.n >= SHARE_RATE_LIMIT_MAX) {
    const retryAfter = Math.max(1, bucket.reset - now);
    return new Response(
      "Too many share links from this address. Try again later.",
      {
        status: 429,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "retry-after": String(retryAfter),
          "x-robots-tag": "noindex",
        },
      },
    );
  }

  const next: ShareRateBucket = bucket
    ? { n: bucket.n + 1, reset: bucket.reset }
    : { n: 1, reset: now + SHARE_RATE_LIMIT_WINDOW_SECONDS };
  try {
    await kv.put(key, JSON.stringify(next), {
      // TTL tracks the window, so a bucket never outlives the limit it encodes.
      // KV's floor is 60s; the window is an hour, so the max() is belt and braces.
      expirationTtl: Math.max(60, next.reset - now),
    });
  } catch {
    /* best effort — a lost increment costs one extra request, not correctness */
  }
  return null;
}

/**
 * Store a payload under its content digest. Returns its /p/<id> URL.
 *
 * The payload is put through `coerceSharePayload` FIRST — the very check
 * `/p/<id>` applies on the way out. Without it, writer and reader disagreed:
 * the tool schemas cap `code`/`abcNotation` in CHARACTERS, so a multibyte
 * pattern of 23 011 chars is 69 011 bytes, sailed past the schema, wrote fine to
 * KV, and then made `/p/<id>` answer 413 — the tool handed back a link that was
 * dead the moment it was minted. Throwing here is what `shareUrlFor` turns into
 * "no link at all", which leaves the result's honest tail standing instead of a
 * broken URL.
 */
async function storeShare(
  env: Env,
  payload: SharePayload,
  origin: string,
): Promise<string> {
  const storable = coerceSharePayload(payload);
  const id = await shareId(storable);
  await env.DOCS_CACHE.put(shareKvKey(id), JSON.stringify(storable), {
    expirationTtl: SHARE_TTL_SECONDS,
  });
  return buildStoredShareUrl(id, origin);
}

/**
 * The URL a tool result should link to: the stateless query-string form when the
 * pattern fits, otherwise a stored share. Never throws — a share link is a bonus,
 * and a KV hiccup must not turn a working tool call into a failed one.
 */
async function shareUrlFor(
  env: Env,
  origin: string,
  payload: SharePayload,
): Promise<string | undefined> {
  try {
    const direct = buildShareQueryUrl(payload, origin);
    if (direct) return direct;
    if (!env.DOCS_CACHE) return undefined;
    return await storeShare(env, payload, origin);
  } catch {
    return undefined;
  }
}

// =============================================================================
// Server factory — creates a fresh McpServer per request (stateless)
// =============================================================================

/**
 * Exported so tests/transport-parity.test.ts can build it over InMemoryTransport.
 *
 * `origin` is the incoming request's own origin, so a share link points at the
 * host the caller actually reached (a custom domain, a preview deployment, or
 * localhost during `wrangler dev`) instead of a hard-coded one. It only affects
 * tool RESULTS — every listing is origin-independent, which is what keeps the
 * two transports comparable in the parity test.
 */
export function createMusicServer(
  env: Env,
  origin: string = DEFAULT_SHARE_ORIGIN,
): McpServer {
  const server = new McpServer(
    {
      name: "Music Studio",
      version: VERSION,
      icons: WORKER_SERVER_ICONS,
      websiteUrl: WEBSITE_URL,
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  // Advertise ext-apps support so clients know to render UI widgets
  advertiseUiExtension(server.server);

  // Slash-command prompts: compose-beat, harmonize-melody, arrange-tune.
  registerMusicPrompts(server);

  // ===========================================================================
  // Ext-Apps UI Resources
  // ===========================================================================

  server.resource(
    SHEET_RESOURCE_URI,
    SHEET_RESOURCE_URI,
    { mimeType: EXT_APPS_MIME, description: "Sheet Music Viewer UI" },
    async () => ({
      contents: [
        {
          uri: SHEET_RESOURCE_URI,
          mimeType: EXT_APPS_MIME,
          text: sheetMusicHtml,
          _meta: { ui: { csp: { ...SHEET_CSP } } },
        },
      ],
    }),
  );

  server.resource(
    STRUDEL_RESOURCE_URI,
    STRUDEL_RESOURCE_URI,
    { mimeType: EXT_APPS_MIME, description: "Strudel Live Pattern REPL" },
    async () => ({
      contents: [
        {
          uri: STRUDEL_RESOURCE_URI,
          mimeType: EXT_APPS_MIME,
          text: strudelHtml,
          _meta: { ui: { csp: { ...STRUDEL_CSP } } },
        },
      ],
    }),
  );

  // ===========================================================================
  // Tool: play-sheet-music
  // ===========================================================================
  // The worker used to return an unconditional receipt while the local server
  // validated the same ABC through abcjs `parseOnly` — so a remote caller was
  // told "sheet music ready" for notation that renders as an error in the
  // widget. Both transports now run the identical check; the only difference is
  // the trailing hint, since `--render-mode` is a local flag (`hint: ""`).
  server.registerTool(
    "play-sheet-music",
    {
      title: "Play Sheet Music",
      description: PLAY_SHEET_BASE_DESCRIPTION + PLAY_SHEET_EXT_APPS_SUFFIX,
      inputSchema: playSheetInputSchema,
      annotations: PLAY_TOOL_ANNOTATIONS,
      _meta: uiToolMeta(SHEET_RESOURCE_URI),
    },
    async (args) => {
      const result = createPlaySheetMusicResult(
        args,
        ABCJS.parseOnly as unknown as SheetParseOnlyFn,
        { hint: "" },
      );
      // attachPlayLink is already a no-op on errors — don't mint a share URL
      // for notation that won't render.
      if (result.isError) return result;
      return attachPlayLink(
        result,
        await shareUrlFor(env, origin, { kind: "score", args }),
      );
    },
  );

  // ===========================================================================
  // Tool: play-live-pattern
  // ===========================================================================
  server.registerTool(
    "play-live-pattern",
    {
      title: "Play Live Pattern",
      description: PLAY_LIVE_BASE_DESCRIPTION + PLAY_LIVE_EXT_APPS_SUFFIX,
      inputSchema: playLiveInputSchema,
      annotations: PLAY_TOOL_ANNOTATIONS,
      _meta: uiToolMeta(STRUDEL_RESOURCE_URI),
    },
    // No server-side validation here, and it is not a bundling problem: the
    // @strudel packages bundle into the isolate fine (+1024 KiB raw / +215 KiB
    // gzip, well inside budget). Strudel's evaluate() transpiles the pattern
    // and runs it through `new Function`, and workerd refuses — "EvalError:
    // Code generation from strings disallowed for this context" — as a
    // platform rule with no flag to lift it. So the remote transport returns
    // the honest unchecked receipt and names the local server as the place
    // that does check. See src/shared/strudel-validate.ts.
    async (args) =>
      attachPlayLink(
        buildPlayLiveResult(args, undefined, PLAY_LIVE_UNVALIDATED_REMOTE),
        // toPlayShareArgs folds the `visuals` preset into the code (and drops
        // `theme`, which is editor chrome the standalone page doesn't have), so
        // the linked page shows the animation the tool call asked for.
        await shareUrlFor(env, origin, {
          kind: "play",
          args: toPlayShareArgs(args),
        }),
      ),
  );

  // ===========================================================================
  // Tool: get-music-guide
  // ===========================================================================
  server.registerTool(
    "get-music-guide",
    {
      title: "Music Reference Guide",
      description: GET_MUSIC_GUIDE_DESCRIPTION,
      inputSchema: z.object({
        topic: z.enum(ABC_GUIDE_TOPICS).describe(GET_MUSIC_GUIDE_TOPIC_DESCRIPTION),
      }),
      annotations: GUIDE_TOOL_ANNOTATIONS,
    },
    async ({ topic }) => ({
      content: [{ type: "text" as const, text: ABC_GUIDES[topic] }],
    }),
  );

  // ===========================================================================
  // Tool: get-strudel-guide
  // ===========================================================================
  server.registerTool(
    "get-strudel-guide",
    {
      title: "Strudel Reference Guide",
      description: GET_STRUDEL_GUIDE_DESCRIPTION,
      inputSchema: z.object({
        topic: z
          .enum(STRUDEL_GUIDE_TOPICS)
          .describe(GET_STRUDEL_GUIDE_TOPIC_DESCRIPTION),
      }),
      annotations: GUIDE_TOOL_ANNOTATIONS,
    },
    async ({ topic }) => ({
      content: [{ type: "text" as const, text: STRUDEL_GUIDES[topic] }],
    }),
  );

  // ===========================================================================
  // Tool: search-music-docs (Context7-powered, KV-cached)
  // ===========================================================================
  server.registerTool(
    "search-music-docs",
    {
      title: "Search Music Documentation",
      description: SEARCH_DOCS_DESCRIPTION,
      inputSchema: searchDocsInputSchema,
      annotations: SEARCH_TOOL_ANNOTATIONS,
    },
    async ({ query, library }) =>
      searchMusicDocs(query, library, {
        apiKey: env.CONTEXT7_API_KEY,
        cacheGet: (key) => env.DOCS_CACHE.get(key),
        cachePut: (key, value) =>
          env.DOCS_CACHE.put(key, value, { expirationTtl: 86400 }),
      }),
  );

  // ===========================================================================
  // Tool: analyze-harmony (pure music theory, no UI)
  // ===========================================================================
  server.registerTool(
    "analyze-harmony",
    {
      title: "Analyze Harmony",
      description: ANALYZE_HARMONY_DESCRIPTION,
      inputSchema: analyzeHarmonyInputSchema,
      annotations: ANALYZE_HARMONY_ANNOTATIONS,
    },
    async (args) => buildAnalyzeHarmonyResult(args),
  );

  // ===========================================================================
  // Tool: convert-abc-to-strudel (scored composition → live pattern)
  // ===========================================================================
  server.registerTool(
    "convert-abc-to-strudel",
    {
      title: "Convert ABC to Strudel",
      description: CONVERT_ABC_DESCRIPTION,
      inputSchema: convertAbcInputSchema,
      annotations: CONVERT_ABC_ANNOTATIONS,
    },
    async (args) =>
      buildConvertAbcResult(args, ABCJS.parseOnly as unknown as ParseOnlyFn),
  );

  // ===========================================================================
  // Guide Resources (mirrors tools for resource-capable clients)
  // ===========================================================================

  for (const topic of ABC_GUIDE_TOPICS) {
    const uri = `music://guide/${topic}`;
    server.resource(
      `Music Guide: ${topic}`,
      uri,
      { mimeType: "text/plain", description: `Music reference: ${topic}` },
      async () => ({
        contents: [{ uri, mimeType: "text/plain" as const, text: ABC_GUIDES[topic] }],
      }),
    );
  }

  for (const topic of STRUDEL_GUIDE_TOPICS) {
    const uri = `music://strudel-guide/${topic}`;
    server.resource(
      `Strudel Guide: ${topic}`,
      uri,
      { mimeType: "text/plain", description: `Strudel reference: ${topic}` },
      async () => ({
        contents: [{ uri, mimeType: "text/plain" as const, text: STRUDEL_GUIDES[topic] }],
      }),
    );
  }

  return server;
}

// =============================================================================
// Worker fetch handler — stateless createMcpHandler
// =============================================================================

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Lightweight liveness probe — keeps uptime checks off the MCP transport.
    if (url.pathname === "/health" || url.pathname === "/healthz") {
      return new Response(
        JSON.stringify({ status: "ok", version: VERSION, widgets: WIDGET_BUILD }),
        { headers: { "content-type": "application/json" } },
      );
    }

    // -------------------------------------------------------------------------
    // Hosted player pages
    // -------------------------------------------------------------------------

    // GET /play?c=<base64url>&bpm=&title=&autoplay=  — Strudel live pattern
    if (url.pathname === "/play") {
      try {
        return renderSharePayload({
          kind: "play",
          args: parsePlaySearchParams(url.searchParams),
        });
      } catch (err) {
        return shareError(err);
      }
    }

    // GET /score?a=<base64url>&instrument=&style=&…  — ABC sheet music
    if (url.pathname === "/score") {
      try {
        return renderSharePayload({
          kind: "score",
          args: parseScoreSearchParams(url.searchParams),
        });
      } catch (err) {
        return shareError(err);
      }
    }

    // GET /p/<id> — a share too long for a query string, read back from KV.
    if (url.pathname.startsWith("/p/")) {
      const id = url.pathname.slice(3);
      if (!isValidShareId(id)) {
        return shareError(new ShareParamError("Not a share id.", 400));
      }
      if (!env.DOCS_CACHE) {
        return new Response("Share storage unavailable.", { status: 503 });
      }
      const stored = await env.DOCS_CACHE.get(shareKvKey(id));
      if (stored === null) {
        // Either never stored, or the 30-day TTL expired.
        return new Response("This share link has expired.", {
          status: 404,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      try {
        // Re-validated on the way out: KV holds what we wrote, but a payload
        // that reaches a page generator should never be trusted on provenance.
        return renderSharePayload(coerceSharePayload(JSON.parse(stored)));
      } catch (err) {
        return shareError(err);
      }
    }

    // POST /share — store a payload too long for a query string, get its URL.
    //
    // The play tools reach this logic in-process (`shareUrlFor`); the route
    // exists so a non-MCP caller can mint the same link. It is unauthenticated,
    // so it is capped hard: 64 KiB of body, and only the handful of fields the
    // generators read survive `coerceSharePayload`. Ids are content digests, so
    // repeated posts of the same pattern rewrite one key rather than growing KV.
    if (url.pathname === "/share") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", {
          status: 405,
          headers: { allow: "POST" },
        });
      }
      // Cheapest rejection available: an honest sender declares its size.
      // A missing or bogus header is not a pass — readBodyWithinLimit() below
      // enforces the same cap against the bytes that actually arrive.
      const declared = Number(request.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > SHARE_PARAM_MAX_BYTES) {
        return shareError(new ShareParamError("Share body is too large.", 413));
      }
      if (!env.DOCS_CACHE) {
        return new Response("Share storage unavailable.", { status: 503 });
      }
      // Before the body is read: the cheapest place to shed a flood. Only the
      // public route is limited — the tool handlers call shareUrlFor() directly.
      const limited = await enforceShareRateLimit(env, request);
      if (limited) return limited;
      try {
        const body = await readBodyWithinLimit(request, SHARE_PARAM_MAX_BYTES);
        const payload = coerceSharePayload(JSON.parse(body));
        const shareUrl =
          buildShareQueryUrl(payload, url.origin) ??
          (await storeShare(env, payload, url.origin));
        return new Response(JSON.stringify({ url: shareUrl }), {
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        if (err instanceof SyntaxError) {
          return shareError(new ShareParamError("Body is not JSON.", 400));
        }
        return shareError(err);
      }
    }

    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
      trackRequest(env, ctx, request);

      // New McpServer per request — stateless, like the official ext-apps examples.
      // enableJsonResponse is required for Claude Desktop Connectors to render
      // ext-apps UI — the default SSE response format isn't parsed correctly
      // by the Connector client for resources/read calls.
      const server = createMusicServer(env, url.origin);
      // `agents` bundles its own @modelcontextprotocol/sdk copy, so its McpServer
      // type is nominally distinct from ours (separate private fields). Safe at runtime.
      const handler = createMcpHandler(
        server as unknown as Parameters<typeof createMcpHandler>[0],
        {
          // `route` is optional and defaults to "/mcp"; the handler 404s
          // anything else. We already matched, and we accept the trailing-slash
          // form too, so hand it the path we actually dispatched on.
          route: url.pathname,
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        },
      );
      return handler(request, env, ctx);
    }

    // Server icon for MCP client UIs (serverInfo.icons → this URL). Proxies the
    // 256px variant as DIRECT bytes — no 301, since some icon-fetchers won't
    // follow redirects — and same-origin as /mcp so domain-restricted clients
    // accept it. Distinct from /favicon.* below, which stays a redirect for
    // browsers/crawlers.
    if (url.pathname === "/icon.png") {
      try {
        const upstream = await fetch(
          "https://raw.githubusercontent.com/linxule/mcp-music-studio/main/assets/icons/logo-256.png",
        );
        if (!upstream.ok) {
          // Don't relay a 404 HTML/text page under content-type: image/png.
          return new Response("icon unavailable", { status: 502 });
        }
        return new Response(upstream.body, {
          status: 200,
          headers: {
            "content-type": "image/png",
            "cache-control": "public, max-age=86400",
            "access-control-allow-origin": "*",
          },
        });
      } catch {
        // fetch can throw (DNS/timeout) — keep the worker from crashing.
        return new Response("icon unavailable", { status: 502 });
      }
    }

    // Favicon — redirect to GitHub raw (no proxy subrequests)
    if (url.pathname === "/favicon.ico" || url.pathname === "/favicon.png") {
      return new Response(null, {
        status: 301,
        headers: {
          Location:
            "https://raw.githubusercontent.com/linxule/mcp-music-studio/main/assets/logo.png",
          "cache-control": "public, max-age=604800",
        },
      });
    }

    // Landing page (HTML so Google's favicon crawler finds the <link rel="icon">)
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>MCP Music Studio</title>
<link rel="icon" type="image/png" href="/favicon.png">
</head><body style="font-family:system-ui;max-width:520px;margin:40px auto;color:#333">
<h1>MCP Music Studio v${VERSION}</h1>
<p>Two-mode creative music studio: scored composition (ABC notation) and live performance (Strudel live coding).</p>
<h3>Connect</h3>
<ul>
<li><strong>claude.ai / Claude Desktop:</strong> Add as Connector: <code>${url.origin}/mcp</code></li>
<li><strong>Claude Code:</strong> <code>claude mcp add --transport http music-studio ${url.origin}/mcp</code></li>
<li><strong>npm:</strong> <code>npx -y mcp-music-studio</code></li>
</ul>
<p><a href="https://github.com/linxule/mcp-music-studio">Source on GitHub</a></p>
</body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    }

    return new Response("Not found", { status: 404 });
  },
};
