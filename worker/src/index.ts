import { SOURCE_URL } from "../../src/source-info.js";
// =============================================================================
// MCP Music Studio — Cloudflare Worker
//
// Remote MCP server for one-paste setup. Stateless handler (new server per
// request) using createLegacyMcpHandler + WorkerTransport — matches the official
// ext-apps example pattern for reliable UI rendering in Claude Desktop.
//
// Tool names, schemas, descriptions, annotations, _meta, instructions, and the
// search-music-docs behavior are imported from ../../src/shared/tool-defs so
// they never drift from the local stdio/HTTP server (server.ts).
// =============================================================================

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createLegacyMcpHandler } from "agents/mcp";
import { z } from "zod";
// abcjs runs parse-only here (no DOM touched at import time — its one browser
// polyfill is wrapped in try/catch), which is what convert-abc-to-strudel needs.
import ABCJS from "abcjs";

// Shared guide content (pure data, no Node.js deps)
import { ABC_GUIDE_TOPICS, ABC_GUIDES } from "../../src/abc-guide.js";
import { STRUDEL_GUIDE_TOPICS, STRUDEL_GUIDES } from "../../src/strudel-guide.js";
import { VERSION } from "../../src/version.js";
import { staticCheckStrudel } from "../../src/shared/strudel-static-check.js";
import { TTS_MAX_BYTES, TTS_MODEL, normalizeTts, type TtsRequest } from "../../src/shared/tts.js";
import { extractSayLines } from "../../src/shared/say-lines.js";
import { budgetMicro, dayCapMicro, lineChars, usd, type VoiceLedger } from "../../src/shared/voice-budget.js";
import { parseClient } from "../../src/shared/parse-client.js";
import { mintSessionId, SESSION_ID_RE } from "../../src/shared/session.js";
import { attachSession, httpSessionBackend, registerSessionTools, type SessionBackend } from "../../src/shared/session-tools.js";
import {
  SHEET_RESOURCE_URI,
  LEGACY_SHEET_RESOURCE_URI,
  STRUDEL_RESOURCE_URI,
  LEGACY_STRUDEL_RESOURCE_URI,
  SHEET_RESOURCE_TEMPLATE,
  STRUDEL_RESOURCE_TEMPLATE,
  isReleaseVersion,
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
  getStrudelGuideInputSchema,
  buildStrudelGuideResult,
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
  withViewId,
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
  type ScoreShareArgs,
  type SharePayload,
} from "../../src/shared/share-url.js";
import { ABCJS_CDN_BASE } from "../../src/abcjs-version.js";
// The two standalone player pages `--render-mode browser` writes to disk. Both
// generators are node-free (see src/open-in-browser.ts for the half that isn't).
import { generatePlayerHtml } from "../../src/browser-fallback.js";
import { generateStrudelPlayerHtml } from "../../src/strudel-browser-fallback.js";
import { CREATE_SHARE_ANNOTATIONS, CREATE_SHARE_DESCRIPTION, createShareInputSchema, createShareResult } from "../../src/shared/share-tool.js";

// Bundled ext-apps HTML (wrangler imports as text via rules config)
import sheetMusicHtml from "../../dist/mcp-app.html";
import strudelHtml from "../../dist/strudel-app.html";
import shareHostHtml from "../../dist/share-host.html";
import { safeJsonForScript } from "../../src/shared/safe-json.js";
import { injectTempo } from "../../src/shared/tempo.js";
import privacyHtml from "../../privacy.html";

// =============================================================================
// Types
// =============================================================================

type Env = {
  ANALYTICS: AnalyticsEngineDataset;
  DOCS_CACHE: KVNamespace;
  CONTEXT7_API_KEY: string;
  /** Workers AI — renders say() lines (GET /tts). */
  AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
  /** Cloudflare rate-limit bindings for /tts misses (see wrangler.jsonc). */
  TTS_IP_LIMITER?: RateLimiterBinding;
  TTS_GLOBAL_LIMITER?: RateLimiterBinding;
  /** The month's voice spend — one VoiceBudget Durable Object (worker/src/voice-budget-do.ts). */
  VOICE_BUDGET?: DurableObjectNamespace;
  /** Dollars per month new spoken lines may cost (src/shared/voice-budget.ts). */
  VOICE_BUDGET_USD_PER_MONTH?: string;
  /** Live sessions — one JamSession Durable Object per id (worker/src/session-do.ts). */
  JAM?: DurableObjectNamespace;
  SESSION_NEW_LIMITER?: RateLimiterBinding;
  SESSION_EVENTS_LIMITER?: RateLimiterBinding;
};

type RateLimiterBinding = { limit(options: { key: string }): Promise<{ success: boolean }> };

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
// Playback only returns stateless links for short pieces. Persistent links are
// created explicitly by create-share-link or POST /share, never by playback.

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
const STRUDEL_PAGE_CSP = buildPlayerCsp(STRUDEL_CSP, { dataScripts: true });
const SHEET_PAGE_CSP = buildPlayerCsp({
  resourceDomains: [new URL(ABCJS_CDN_BASE).origin],
  connectDomains: SHEET_CSP.connectDomains,
});

function renderSharePayload(payload: SharePayload, url?: URL): Response {
  if (url && url.searchParams.get("classic") !== "1") {
    return payload.kind === "play" ? renderFullPlayer(payload.args, url) : renderFullScorePlayer(payload.args, url);
  }
  return payload.kind === "play"
    ? playerResponse(generateStrudelPlayerHtml(payload.args), STRUDEL_PAGE_CSP)
    : playerResponse(generatePlayerHtml(payload.args), SHEET_PAGE_CSP);
}

// -----------------------------------------------------------------------------
// The full player: the real widget, hosted by a page of our own
// (src/share-host.ts), for patterns and scores alike. The standalone page
// stays behind ?classic=1 — and is still what the local --render-mode browser
// path writes to disk.
// -----------------------------------------------------------------------------

/** The share page only frames our widget and talks to nothing itself. */
const SHARE_HOST_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** The widget's own CSP, as a host derives it from _meta.ui.csp — framed only by our page. */
function widgetPageCsp(origin: string): string {
  return buildPlayerCsp(
    { resourceDomains: STRUDEL_CSP.resourceDomains, connectDomains: withOrigin(STRUDEL_CSP.connectDomains, origin) },
    { dataScripts: true, frameAncestors: "'self'" },
  );
}

/** The sheet widget's CSP, from SHEET_CSP: it bundles abcjs and fetches only soundfonts. */
const SHEET_WIDGET_CSP = buildPlayerCsp({ connectDomains: SHEET_CSP.connectDomains }, { frameAncestors: "'self'" });

/** A widget page for the full player to frame (same origin). */
function widgetResponse(html: string, csp: string): Response {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp,
      "x-robots-tag": "noindex, nofollow",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "cache-control": "public, max-age=300",
    },
  });
}

export interface FullPlayerInit {
  /** Absent = "play". */
  kind?: "play" | "score";
  code?: string;
  score?: ScoreShareArgs;
  title?: string;
  bpm?: number;
  session?: { id: string; origin: string; rev?: number };
  widget: string;
  classic?: string;
}

export function fullPlayerHtml(init: FullPlayerInit): string {
  return shareHostHtml.replace("__SHARE_INIT__", () => safeJsonForScript(init));
}

function renderFullPlayer(
  args: { code: string; title?: string; bpm?: number },
  url: URL,
  session?: { id: string; origin: string; rev?: number },
): Response {
  const classic = new URL(url);
  classic.searchParams.set("classic", "1");
  // The same tempo policy the standalone page and the widget run
  // (src/shared/tempo.ts), applied once here so the code the page shows is
  // the code that plays. Only "unchanged-ambiguous" (the pattern owns its
  // setcps) leaves the bpm for the widget to apply at runtime.
  const tempo = typeof args.bpm === "number" ? injectTempo(args.code, args.bpm) : null;
  const runtimeBpm = tempo && (tempo.policy as string) === "unchanged-ambiguous" ? args.bpm : undefined;
  const html = fullPlayerHtml({
    code: tempo ? tempo.code : args.code,
    ...(args.title ? { title: args.title } : {}),
    ...(runtimeBpm !== undefined ? { bpm: runtimeBpm } : {}),
    ...(session ? { session } : {}),
    widget: "/widget/strudel",
    ...(session ? {} : { classic: `${classic.pathname}${classic.search}` }),
  });
  const res = playerResponse(html, SHARE_HOST_CSP);
  // A session page shows whatever the session plays now: never cache it.
  if (session) res.headers.set("cache-control", "no-store");
  return res;
}

/**
 * A score's full player: the sheet widget framed from /widget/sheet. Its
 * arguments go to the widget as play-sheet-music's, so it applies tempo,
 * style, swing and transpose exactly as it does for a tool call.
 */
function renderFullScorePlayer(args: ScoreShareArgs, url: URL): Response {
  const classic = new URL(url);
  classic.searchParams.set("classic", "1");
  const { title, ...score } = args;
  const html = fullPlayerHtml({
    kind: "score",
    // JSON drops the absent options; the title travels on its own, as for a pattern.
    score,
    ...(title ? { title } : {}),
    widget: "/widget/sheet",
    classic: `${classic.pathname}${classic.search}`,
  });
  return playerResponse(html, SHARE_HOST_CSP);
}

/** Placeholder for a session page that has nothing to show yet. */
const SESSION_WAITING_CODE =
  "// This live session has no pattern yet.\n// It loads the next one Claude sends, or the code the performer runs.\nsilence";

async function renderSessionPage(env: Env, url: URL, id: string): Promise<Response> {
  if (!env.JAM) return new Response("Live sessions are not available here.", { status: 503 });
  const res = await env.JAM.get(env.JAM.idFromName(id)).fetch("https://session/current");
  if (res.status === 404 || res.status === 410) {
    return new Response(
      res.status === 410
        ? "The listener ended this live session."
        : "This live session has ended (sessions close after 2 hours idle).",
      { status: res.status, headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex" } },
    );
  }
  const current = res.status === 200 ? ((await res.json()) as { code?: string; rev?: number }) : {};
  return renderFullPlayer(
    { code: typeof current.code === "string" && current.code.trim() ? current.code : SESSION_WAITING_CODE },
    url,
    // The page already shows rev N (or a newer edit): the player must not
    // re-apply an older update over it (Codex review).
    { id, origin: url.origin, rev: typeof current.rev === "number" ? current.rev : 0 },
  );
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
// The explicit share tool uses this same limiter before storing anything.

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
  return enforceRateLimit(env, request, {
    key: shareRateLimitKey,
    max: SHARE_RATE_LIMIT_MAX,
    message: "Too many share links from this address. Try again later.",
  });
}

/** The same fixed window, for any route: a bucket name, a budget, a message. */
async function enforceRateLimit(
  env: Env,
  request: Request,
  limit: { key: (ip: string) => string; max: number; message: string },
): Promise<Response | null> {
  const kv = env.DOCS_CACHE;
  if (!kv) return null;

  // Cloudflare sets CF-Connecting-IP on every edge request; the fallback bucket
  // only matters for local `wrangler dev` and tests.
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const key = limit.key(ip);
  const now = Math.floor(Date.now() / 1000);

  let bucket: ShareRateBucket | null;
  try {
    bucket = parseBucket(await kv.get(key), now);
  } catch {
    return null; // KV is unwell — don't take the route down with it.
  }

  if (bucket && bucket.n >= limit.max) {
    const retryAfter = Math.max(1, bucket.reset - now);
    return new Response(
      limit.message,
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
 * dead the moment it was minted. Reject before writing; the explicit share
 * operation reports the error instead of returning a broken URL.
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
  request?: Request,
  /** Lets play-live-pattern / update-session warm say() lines after replying. */
  ctx?: ExecutionContext,
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

  // The tools reach sessions through the same routes the widget uses, with the
  // caller's address passed on for the creation limit.
  const sessions: SessionBackend = httpSessionBackend((path, init) => {
    const headers = new Headers(init?.headers);
    const ip = request?.headers.get("CF-Connecting-IP");
    if (ip) headers.set("CF-Connecting-IP", ip);
    return handleSessionRoute(new Request(new URL(path, origin), { ...init, headers }), env);
  });

  // Slash-command prompts: compose-beat, harmonize-melody, arrange-tune.
  registerMusicPrompts(server);

  server.registerTool("create-share-link", {
    title: "Create Music Share Link",
    description: CREATE_SHARE_DESCRIPTION,
    inputSchema: createShareInputSchema,
    annotations: CREATE_SHARE_ANNOTATIONS,
  }, (args) => createShareResult(args, async (payload) => {
    if (!env.DOCS_CACHE) throw new Error("Share storage is unavailable. Try again later.");
    if (request) {
      const limited = await enforceShareRateLimit(env, request);
      if (limited) throw new Error("Too many share requests. Try again later.");
    }
    return storeShare(env, payload, origin);
  }));

  // ===========================================================================
  // Ext-Apps UI Resources
  // ===========================================================================

  // Any earlier release's URI resolves too — see SHEET_RESOURCE_TEMPLATE.
  server.resource(
    "sheet-music-any-version",
    new ResourceTemplate(SHEET_RESOURCE_TEMPLATE, { list: undefined }),
    { mimeType: EXT_APPS_MIME, description: "Sheet Music Viewer UI (any release's URI)" },
    async (uri, { version }) => {
      if (!isReleaseVersion(version)) throw new Error(`Resource ${uri.href} not found`);
      return { contents: [{ uri: uri.href, mimeType: EXT_APPS_MIME, text: sheetMusicHtml, _meta: { ui: { csp: { ...SHEET_CSP } } } }] };
    },
  );
  server.resource(
    "strudel-any-version",
    new ResourceTemplate(STRUDEL_RESOURCE_TEMPLATE, { list: undefined }),
    { mimeType: EXT_APPS_MIME, description: "Strudel Live Pattern REPL (any release's URI)" },
    async (uri, { version }) => {
      if (!isReleaseVersion(version)) throw new Error(`Resource ${uri.href} not found`);
      return {
        contents: [{
          uri: uri.href, mimeType: EXT_APPS_MIME, text: strudelHtml,
          _meta: { ui: { csp: { ...STRUDEL_CSP, connectDomains: withOrigin(STRUDEL_CSP.connectDomains, origin) } } },
        }],
      };
    },
  );

  for (const uri of [SHEET_RESOURCE_URI, LEGACY_SHEET_RESOURCE_URI]) {
    server.resource(
      uri,
      uri,
      { mimeType: EXT_APPS_MIME, description: "Sheet Music Viewer UI" },
      async () => ({
        contents: [
          {
            uri,
            mimeType: EXT_APPS_MIME,
            text: sheetMusicHtml,
            _meta: { ui: { csp: { ...SHEET_CSP } } },
          },
        ],
      }),
    );
  }

  for (const uri of [STRUDEL_RESOURCE_URI, LEGACY_STRUDEL_RESOURCE_URI]) {
    server.resource(
      uri,
      uri,
      { mimeType: EXT_APPS_MIME, description: "Strudel Live Pattern REPL" },
      async () => ({
        contents: [
          {
            uri,
            mimeType: EXT_APPS_MIME,
            text: strudelHtml,
            // A preview/lab deployment's widget joins sessions on ITS origin.
            _meta: { ui: { csp: { ...STRUDEL_CSP, connectDomains: withOrigin(STRUDEL_CSP.connectDomains, origin) } } },
          },
        ],
      }),
    );
  }

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
      return withViewId(
        attachPlayLink(
          result,
          buildShareQueryUrl({ kind: "score", args }, origin),
        ),
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
    async (args) => {
      // Parse-only: no evaluation in workerd, but a syntax or mini-notation
      // error comes back with its line:column in the code the model sent.
      const syntaxError = staticCheckStrudel(args.code);
      if (syntaxError) return withViewId(buildPlayLiveResult(args, { ok: false, error: syntaxError }));
      warmSayLines(env, ctx, args.code);
      const played = withViewId(
        attachPlayLink(
          buildPlayLiveResult(args, undefined, PLAY_LIVE_UNVALIDATED_REMOTE),
          // toPlayShareArgs folds the `visuals` preset into the code (and drops
          // `theme`, which is editor chrome the standalone page doesn't have), so
          // the linked page shows the animation the tool call asked for.
          buildShareQueryUrl({
            kind: "play",
            args: toPlayShareArgs(args),
          }, origin),
        ),
      );
      return args.session ? attachSession(played, sessions, origin, toPlayShareArgs(args).code) : played;
    },
  );

  // Live sessions: get-session / update-session (src/shared/session-tools.ts).
  // Code that parses is about to be sent to the player: warm its say() lines.
  registerSessionTools(server, sessions, async (code) => {
    const problem = staticCheckStrudel(code);
    if (!problem) warmSayLines(env, ctx, code);
    return problem;
  });

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
      inputSchema: getStrudelGuideInputSchema,
      annotations: GUIDE_TOOL_ANNOTATIONS,
    },
    async (args) => buildStrudelGuideResult(args),
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
// GET /tts — say() lines, rendered once and cached
// =============================================================================
//
// The widget's say(text) registers `/tts?voice=&text=` as a sample, so speech
// is a sound in the mix: on the beat, recordable, the same on every host
// (browser speechSynthesis never played in the Claude mobile app). This route
// is unauthenticated and each MISS costs a Workers AI call, so: lines are
// capped (TTS_MAX_CHARS), voices are an allowlist of the model's synthetic
// voices, clips are cached in KV by a digest of voice + text (a repeat is a KV
// read), and only misses cost anything: each is charged against the month's
// voice budget (VoiceBudget DO) after the per-address rate limits.
/** How long a rendered clip stays cached. */
export const TTS_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * The address a budget belongs to. IPv6 is bucketed by /64 — one subscriber
 * line usually gets a whole /64, so keying on the full address would hand a
 * single client 2^64 budgets (Opus, 0.7.0 gauntlet).
 */
export function clientBucket(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head] = ip.split("%");
  const parts = head.split("::");
  const left = parts[0] ? parts[0].split(":") : [];
  const right = parts.length > 1 && parts[1] ? parts[1].split(":") : [];
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

export async function ttsCacheKey(request: TtsRequest): Promise<string> {
  const bytes = new TextEncoder().encode(`${request.voice}\u0000${request.text}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `tts:v1:${hex}`;
}

/** Workers AI hands audio back as a stream, raw bytes, or base64 JSON, by model. */
async function audioBytes(output: unknown): Promise<Uint8Array> {
  if (output instanceof ReadableStream) return new Uint8Array(await new Response(output).arrayBuffer());
  if (output instanceof ArrayBuffer) return new Uint8Array(output);
  if (output instanceof Uint8Array) return output;
  const audio = (output as { audio?: unknown } | null)?.audio;
  if (typeof audio === "string") return Uint8Array.from(atob(audio), (c) => c.charCodeAt(0));
  throw new Error("text-to-speech returned no audio");
}

const TTS_HEADERS = {
  "content-type": "audio/mpeg",
  // The URL names the content (voice + text), so the clip never changes.
  "cache-control": "public, max-age=31536000, immutable",
  // superdough fetch()es samples from the widget's sandboxed origin.
  "access-control-allow-origin": "*",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex",
};

const budgetStub = (ns: DurableObjectNamespace) => ns.get(ns.idFromName("global"));

/** GET /tts/budget — how much of the month's voice budget is spent (public, numbers only). */
async function handleVoiceBudgetStatus(env: Env): Promise<Response> {
  const headers = { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" };
  const monthBudget = budgetMicro(env.VOICE_BUDGET_USD_PER_MONTH);
  if (!env.VOICE_BUDGET) return new Response(JSON.stringify({ error: "no voice budget bound" }), { status: 503, headers });
  const res = await budgetStub(env.VOICE_BUDGET).fetch(`https://voice-budget/status?budgetMicro=${monthBudget}`);
  const { ledger } = (await res.json()) as { ledger: VoiceLedger };
  return new Response(
    JSON.stringify({
      month: ledger.month,
      spentUsd: usd(ledger.monthMicro),
      budgetUsd: usd(monthBudget),
      today: ledger.day,
      spentTodayUsd: usd(ledger.dayMicro),
      todayCapUsd: usd(dayCapMicro(monthBudget)),
    }),
    { headers },
  );
}

/**
 * The clip another caller is rendering: one KV read (free when it rendered in
 * this colo), then the VoiceBudget DO, which holds us until that render posts
 * its bytes (≤ 3 s). KV alone can't do it across colos — this colo may keep
 * reading a cached miss. Null when the render failed or ran long.
 */
async function waitForClip(env: Env, budget: DurableObjectStub, key: string): Promise<ArrayBuffer | Uint8Array | null> {
  try {
    const cached = await env.DOCS_CACHE?.get(key, "arrayBuffer");
    if (cached) return cached;
  } catch {
    /* ask the DO */
  }
  try {
    const res = await budget.fetch("https://voice-budget/wait", { method: "POST", body: JSON.stringify({ key }) });
    if (res.status !== 200) return null;
    const clip = new Uint8Array(await res.arrayBuffer());
    return clip.byteLength > 0 ? clip : null;
  } catch {
    return null;
  }
}

/** What became of one line: the clip, or the status and reason the player is told. */
type LineOutcome =
  | { ok: true; bytes: ArrayBuffer | Uint8Array; cached: boolean; stored?: Promise<void> }
  | { ok: false; status: number; message: string; retryAfter?: string };

/**
 * Who is asking for a line. `ip` is the player's address (GET /tts); null is a
 * tool call warming its own lines (say-lines prerender), which skips the
 * per-address limiter: a tool call's address is the MCP client's — for
 * claude.ai, servers every user shares — so per-address fairness means nothing
 * there. The global limiter and the voice budget apply to both.
 */
type LineCaller = { ip: string | null; renderOnMiss: boolean; label: "" | "prerender-" };

/**
 * One line, start to finish: cache → fairness limits → voice budget → model →
 * cache. GET /tts and the tool-time prerender both come through here, so the
 * gates cannot drift apart. `stored` settles once a fresh clip is in KV.
 */
async function renderLine(env: Env, ctx: ExecutionContext, line: TtsRequest, caller: LineCaller): Promise<LineOutcome> {
  const key = await ttsCacheKey(line);
  try {
    const cached = await env.DOCS_CACHE?.get(key, "arrayBuffer");
    if (cached) {
      track(env, { blobs: ["tts", `${caller.label}hit`, line.voice], doubles: [line.text.length], indexes: ["tts"] });
      return { ok: true, bytes: cached, cached: true };
    }
  } catch {
    /* KV unwell — render instead */
  }
  // A miss on HEAD renders nothing: HEAD only answers "is it cached?".
  if (!caller.renderOnMiss) return { ok: false, status: 404, message: "" };
  // A miss costs a model call. First gate: Cloudflare's rate-limit bindings
  // (per address, then everyone). They are about FAIRNESS — one client can't
  // take the whole budget in a minute. Cost is the voice budget below.
  const tooMany = (message: string, retryAfter = "60"): LineOutcome => ({ ok: false, status: 429, message, retryAfter });
  try {
    if (caller.ip !== null && env.TTS_IP_LIMITER && !(await env.TTS_IP_LIMITER.limit({ key: caller.ip })).success) {
      return tooMany("Too many new spoken lines from this address. Try again in a minute.");
    }
    if (env.TTS_GLOBAL_LIMITER && !(await env.TTS_GLOBAL_LIMITER.limit({ key: "all" })).success) {
      return tooMany("Speech rendering is busy. Try again in a minute.");
    }
  } catch {
    return tooMany("Speech rendering is busy. Try again in a minute.");
  }
  // Cost: reserve this line's exact price against the month (and the day's
  // share of it). Fails CLOSED — no budget bound, or a budget that can't be
  // checked, renders nothing; the piece plays without the line and says so.
  const chars = lineChars(line.text);
  if (!env.VOICE_BUDGET) return tooMany("Speech rendering is not available here (no voice budget).", "3600");
  const budget = budgetStub(env.VOICE_BUDGET);
  const monthBudget = budgetMicro(env.VOICE_BUDGET_USD_PER_MONTH);
  type Verdict = { ok?: boolean; reason?: "month" | "day" | "inflight"; ledger?: VoiceLedger };
  // With the key, the DO also marks the line in flight — or answers "inflight"
  // without charging when another caller is rendering it right now.
  const reserveLine = async (withKey: boolean): Promise<Verdict> => {
    const res = await budget.fetch("https://voice-budget/reserve", {
      method: "POST",
      body: JSON.stringify({ chars, budgetMicro: monthBudget, ...(withKey ? { key } : {}) }),
    });
    return (await res.json()) as Verdict;
  };
  let chargedIn: { month: string; day: string };
  let marked = true;
  try {
    let verdict = await reserveLine(true);
    if (verdict.reason === "inflight") {
      // The tool-time prerender and the player ask for the same line at once:
      // wait for the other render's clip instead of paying for it twice.
      const clip = await waitForClip(env, budget, key);
      if (clip) {
        track(env, { blobs: ["tts", `${caller.label}hit`, line.voice], doubles: [line.text.length], indexes: ["tts"] });
        return { ok: true, bytes: clip, cached: true };
      }
      track(env, { blobs: ["tts", "inflight-timeout", line.voice], doubles: [chars], indexes: ["tts"] });
      // No clip: render it ourselves (the first render may have failed and
      // freed the key; if it is still going, this pays twice).
      verdict = await reserveLine(true);
      if (verdict.reason === "inflight") {
        marked = false;
        verdict = await reserveLine(false);
      }
    }
    if (!verdict.ok || !verdict.ledger) {
      track(env, { blobs: ["tts", "budget", verdict.reason ?? "unknown"], doubles: [chars], indexes: ["tts"] });
      return verdict.reason === "day"
        ? tooMany("Today's share of the voice budget is used up. New spoken lines return tomorrow; lines already heard still play.", "3600")
        : tooMany("This month's voice budget is used up. New spoken lines return next month; lines already heard still play.", "86400");
    }
    chargedIn = { month: verdict.ledger.month, day: verdict.ledger.day };
  } catch {
    return tooMany("Speech rendering is busy. Try again in a minute.");
  }
  // However the render ends, the line is no longer in flight: /done hands the
  // clip (empty on failure) to anyone waiting on it. A lost /done only means
  // the DO forgets the key at its TTL and its waiters render the line too.
  const done = (clip?: Uint8Array) =>
    marked
      ? budget
          .fetch("https://voice-budget/done", { method: "POST", headers: { "x-line-key": key }, body: clip ?? new Uint8Array(0) })
          .then(() => undefined, () => undefined)
      : Promise.resolve();
  // Refund ONLY when the model refused the call. Once it has returned output
  // the render may be billed, so a failure on our side keeps the charge.
  // The refund also clears the in-flight key.
  const giveBack = () =>
    ctx.waitUntil(
      budget
        .fetch("https://voice-budget/refund", {
          method: "POST",
          body: JSON.stringify({ chars, ...chargedIn, ...(marked ? { key } : {}) }),
        })
        .then(() => undefined, () => undefined),
    );
  if (!env.AI) {
    giveBack(); // nothing was called
    return { ok: false, status: 503, message: "Speech rendering is unavailable." };
  }
  let output: unknown;
  try {
    output = await env.AI.run(TTS_MODEL, { text: line.text, speaker: line.voice, encoding: "mp3" });
  } catch (err) {
    giveBack();
    return { ok: false, status: 502, message: `Speech rendering failed: ${(err as Error)?.message ?? "unknown error"}` };
  }
  let bytes: Uint8Array;
  try {
    bytes = await audioBytes(output);
  } catch (err) {
    ctx.waitUntil(done());
    return { ok: false, status: 502, message: `Speech rendering failed: ${(err as Error)?.message ?? "unknown error"}` };
  }
  if (bytes.byteLength === 0 || bytes.byteLength > TTS_MAX_BYTES) {
    ctx.waitUntil(done());
    return { ok: false, status: 502, message: "Speech rendering returned an unusable clip." };
  }
  // Waiters get the bytes from the DO straight away, in whatever colo they are.
  const stored = Promise.all([
    (async () => {
      try {
        await env.DOCS_CACHE?.put(key, bytes, { expirationTtl: TTS_TTL_SECONDS });
      } catch {
        /* the next request renders again */
      }
    })(),
    done(bytes),
  ]).then(() => undefined);
  track(env, { blobs: ["tts", `${caller.label}miss`, line.voice], doubles: [line.text.length], indexes: ["tts"] });
  return { ok: true, bytes, cached: false, stored };
}

async function handleTts(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const params = new URL(request.url).searchParams;
  const parsed = normalizeTts(params.get("text"), params.get("voice") ?? undefined);
  if ("error" in parsed) {
    return new Response(parsed.error, {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" },
    });
  }
  const outcome = await renderLine(env, ctx, parsed, {
    ip: clientBucket(request.headers.get("CF-Connecting-IP") ?? "unknown"),
    renderOnMiss: request.method === "GET",
    label: "",
  });
  if (outcome.ok) {
    if (outcome.stored) ctx.waitUntil(outcome.stored);
    return new Response(request.method === "HEAD" ? null : outcome.bytes, { headers: TTS_HEADERS });
  }
  if (outcome.status === 404) return new Response(null, { status: 404, headers: { "access-control-allow-origin": "*" } });
  return new Response(outcome.message, {
    status: outcome.status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...(outcome.retryAfter ? { "retry-after": outcome.retryAfter } : {}),
      "access-control-allow-origin": "*",
    },
  });
}

// =============================================================================
// say() prerender — warm /tts at tool time
// =============================================================================
//
// A voiced piece used to start late: the player loads (~1–3 s), evaluates, and
// only then asks /tts for each line, and a miss is ~1.5 s of model time. The
// Worker already parses the code at tool time, so it renders the say() lines
// it can read (src/shared/say-lines.ts) while the reply travels and the widget
// loads; the player's fetch is then a cache hit.
//
// Run under ctx.waitUntil, never awaited: the tool reply is the model's turn,
// and 8 lines at ~1.5 s each, 3 at a time, is ~4.5 s it would otherwise wait.
// Starting before the reply is what matters; the first lines finish while the
// widget is still loading. A line the player asks for mid-render waits for
// this render's clip, handed over by the VoiceBudget DO, instead of paying for
// it twice. Never fails the tool call.

/** Lines rendered at once per tool call. */
const PRERENDER_PARALLEL = 3;

export async function prerenderSayLines(env: Env, ctx: ExecutionContext, code: string): Promise<void> {
  const { lines, overCap } = extractSayLines(code);
  if (overCap) track(env, { blobs: ["tts", "prerender-skipped", "cap"], doubles: [overCap], indexes: ["tts"] });
  let next = 0;
  const worker = async () => {
    while (next < lines.length) {
      const line = lines[next++];
      try {
        const outcome = await renderLine(env, ctx, line, { ip: null, renderOnMiss: true, label: "prerender-" });
        if (!outcome.ok) {
          track(env, { blobs: ["tts", "prerender-skipped", String(outcome.status)], doubles: [1], indexes: ["tts"] });
          // Refused by a limit or the budget: the rest would be too.
          if (outcome.status === 429) next = lines.length;
        } else if (outcome.stored) {
          await outcome.stored;
        }
      } catch {
        /* warming is best effort */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PRERENDER_PARALLEL, lines.length) }, worker));
}

/** Start warming without holding the reply; no-op without a context (tests, local). */
function warmSayLines(env: Env, ctx: ExecutionContext | undefined, code: string): void {
  if (!ctx) return;
  try {
    ctx.waitUntil(prerenderSayLines(env, ctx, code).catch(() => undefined));
  } catch {
    /* never fail the tool call */
  }
}

// =============================================================================
// Live sessions — routes in front of the JamSession Durable Object
// =============================================================================

/** The widget's frame has an opaque origin; the id is the capability. */
const SESSION_CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
  "access-control-expose-headers": "x-session-listening",
};
const SESSION_OPS = new Set(["events", "next", "state", "update", "current", "end"]);
const SESSION_EVENTS_MAX_BYTES = 256 * 1024;
const SESSION_UPDATE_MAX_BYTES = 64 * 1024 * 4 + 1024;

function sessionJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SESSION_CORS },
  });
}

/** connect-src plus this deployment's own origin (a lab or preview Worker). */
export function withOrigin(domains: string[], origin: string): string[] {
  return domains.includes(origin) ? [...domains] : [...domains, origin];
}

/**
 * POST /session/new                → { id }
 * POST /session/<id>/events        widget → log
 * GET  /session/<id>/next          widget long-poll (also its heartbeat)
 * GET  /session/<id>/state         model read
 * POST /session/<id>/update        model write (waits for the widget's answer)
 */
export async function handleSessionRoute(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: SESSION_CORS });
  if (!env.JAM) return sessionJson({ error: "live sessions are not available on this deployment" }, 503);
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const ip = clientBucket(request.headers.get("CF-Connecting-IP") ?? "unknown");
  const limit = async (binding: RateLimiterBinding | undefined): Promise<boolean> => {
    if (!binding) return true;
    try {
      return (await binding.limit({ key: ip })).success;
    } catch {
      return true;
    }
  };

  if (parts.length === 2 && parts[1] === "new") {
    if (request.method !== "POST") return sessionJson({ error: "method not allowed" }, 405);
    if (!(await limit(env.SESSION_NEW_LIMITER))) {
      track(env, { blobs: ["session", "limited", "new"], indexes: ["session"] });
      return sessionJson({ error: "too many new sessions" }, 429);
    }
    const id = mintSessionId();
    const stub = env.JAM.get(env.JAM.idFromName(id));
    let seed: string | undefined;
    try {
      const raw = await readBodyWithinLimit(request, SESSION_UPDATE_MAX_BYTES);
      const parsed = raw ? (JSON.parse(raw) as { seed?: unknown }) : null;
      if (typeof parsed?.seed === "string") seed = parsed.seed;
    } catch { /* a session without a seed */ }
    const res = await stub.fetch(`https://session/init?id=${id}`, {
      method: "POST",
      body: seed ? JSON.stringify({ seed }) : undefined,
    });
    if (!res.ok) return sessionJson({ error: "could not open a session" }, 502);
    // Counts only, never the id (it works like a password). Cost watch: each
    // open session is a Durable Object awake while its player polls.
    track(env, { blobs: ["session", "new", seed ? "seeded" : "empty"], indexes: ["session"] });
    return sessionJson({ id });
  }

  const [, id, op] = parts;
  if (parts.length !== 3 || !SESSION_ID_RE.test(id ?? "") || !SESSION_OPS.has(op ?? "")) {
    return sessionJson({ error: "not found" }, 404);
  }
  // Every op is metered (Codex review): a widget polls ~3×/min and posts
  // events every ~1.5 s at most, far under the limit.
  if (!(await limit(env.SESSION_EVENTS_LIMITER))) {
    track(env, { blobs: ["session", "limited", "ops"], indexes: ["session"] });
    return sessionJson({ error: "too many requests" }, 429);
  }
  // Read the body under its cap HERE, before the Durable Object (and before a
  // chunked multi-MB body is buffered whole) — the /share rule (Kimi review).
  let body: string | undefined;
  if (request.method === "POST") {
    try {
      body = await readBodyWithinLimit(request, op === "update" ? SESSION_UPDATE_MAX_BYTES : SESSION_EVENTS_MAX_BYTES);
    } catch {
      return sessionJson({ error: "body too large" }, 413);
    }
  }
  const stub = env.JAM.get(env.JAM.idFromName(id));
  const forwarded = await stub.fetch(`https://session/${op}${url.search}`, { method: request.method, body, signal: request.signal });
  const headers = new Headers(forwarded.headers);
  for (const [k, v] of Object.entries(SESSION_CORS)) headers.set(k, v);
  return new Response(forwarded.body, { status: forwarded.status, headers });
}

// =============================================================================
// Worker fetch handler — stateless createLegacyMcpHandler
// =============================================================================

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/privacy") {
      return new Response(privacyHtml, { headers: {
        "content-type": "text/html; charset=utf-8",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      } });
    }

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
    // The widget, served for the full player page to frame (same origin).
    if (url.pathname === "/widget/strudel") {
      return widgetResponse(strudelHtml, widgetPageCsp(url.origin));
    }
    // The sheet widget, for a score's full player (/score, /p/<id> kind score).
    if (url.pathname === "/widget/sheet") {
      return widgetResponse(sheetMusicHtml, SHEET_WIDGET_CSP);
    }

    // GET /s/<id> — a live session's second screen: the full player, joined.
    if (url.pathname.startsWith("/s/")) {
      const id = url.pathname.slice(3);
      if (!SESSION_ID_RE.test(id)) return shareError(new ShareParamError("Not a session id.", 400));
      return renderSessionPage(env, url, id);
    }

    if (url.pathname === "/play") {
      try {
        return renderSharePayload({
          kind: "play",
          args: parsePlaySearchParams(url.searchParams),
        }, url);
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
        }, url);
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
        return renderSharePayload(coerceSharePayload(JSON.parse(stored)), url);
      } catch (err) {
        return shareError(err);
      }
    }

    // POST /share — explicitly store a piece and return a 30-day link.
    // The local create-share-link tool uses this route. It is unauthenticated,
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
      // Before the body is read: the cheapest place to shed a flood.
      const limited = await enforceShareRateLimit(env, request);
      if (limited) return limited;
      try {
        const body = await readBodyWithinLimit(request, SHARE_PARAM_MAX_BYTES);
        const payload = coerceSharePayload(JSON.parse(body));
        const shareUrl = await storeShare(env, payload, url.origin);
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

    if (url.pathname === "/tts") {
      return handleTts(request, env, ctx);
    }
    if (url.pathname === "/tts/budget") {
      return handleVoiceBudgetStatus(env);
    }

    if (url.pathname.startsWith("/session/")) {
      return handleSessionRoute(request, env);
    }

    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
      trackRequest(env, ctx, request);

      // New McpServer per request — stateless, like the official ext-apps examples.
      // enableJsonResponse is required for Claude Desktop Connectors to render
      // ext-apps UI — the default SSE response format isn't parsed correctly
      // by the Connector client for resources/read calls.
      const server = createMusicServer(env, url.origin, request, ctx);
      // Keep the SDK v1 server on Agents' explicit legacy adapter. The default
      // createMcpHandler now accepts SDK v2 servers with a different context API.
      const handler = createLegacyMcpHandler(
        server as unknown as Parameters<typeof createLegacyMcpHandler>[0],
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
<p><a href="${SOURCE_URL}">Source &amp; licenses</a></p>
<p><a href="/privacy">Privacy policy</a></p>
</body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    }

    return new Response("Not found", { status: 404 });
  },
};
