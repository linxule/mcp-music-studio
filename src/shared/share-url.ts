// =============================================================================
// Share URLs — "Tier 3" click-to-play links for clients that can't render the
// ext-apps widget (Claude Code, CLIs, mobile web, anyone hitting the remote
// Worker from a terminal).
//
// A play tool's result normally says "…nothing has played yet" on those hosts.
// With a share URL it can hand over a link that actually plays: the Worker
// serves the very same standalone page `--render-mode browser` writes to disk.
//
// Two shapes, same page:
//
//   short  →  GET /play?c=<base64url>&bpm=&title=&autoplay=      (stateless)
//   long   →  POST /share → KV → GET /p/<id>                     (30-day TTL)
//
// Everything here is pure: no KV, no fetch, no node: imports, no DOM. It is
// imported by the Worker, by the local stdio server, and by the tests.
// =============================================================================

/** Largest payload a share param may decode to. Anything bigger is a 413. */
export const SHARE_PARAM_MAX_BYTES = 64 * 1024;

/**
 * Longest encoded payload we are willing to put in a query string.
 *
 * Practical URL ceilings vary (browsers cope with ~64 KB, but chat clients,
 * terminals and link unfurlers truncate far earlier), so the query-string form
 * is reserved for patterns that stay comfortably short and everything else goes
 * through KV. ~1.5 KB of base64 ≈ 1.1 KB of source, which covers the great
 * majority of Strudel patterns and short ABC tunes.
 */
export const SHARE_QUERY_MAX_CHARS = 1536;

/** KV TTL for a stored share, in seconds (30 days). */
export const SHARE_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Fallback origin when a share URL is built outside a request context. */
export const DEFAULT_SHARE_ORIGIN = "https://mcp-music-studio.linxule.workers.dev";

/** Titles are cosmetic; cap them so a link can't carry a payload in the label. */
export const SHARE_TITLE_MAX_CHARS = 200;

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/**
 * A bad share param. `status` is the HTTP status the Worker should answer with:
 * 400 for malformed input, 413 for input that is merely too big.
 */
export class ShareParamError extends Error {
  readonly status: 400 | 413;

  constructor(message: string, status: 400 | 413 = 400) {
    super(message);
    this.name = "ShareParamError";
    this.status = status;
  }
}

// -----------------------------------------------------------------------------
// base64url codec
// -----------------------------------------------------------------------------
//
// btoa/atob are byte-oriented and TextEncoder/TextDecoder are the portable way
// to bridge them to UTF-16 strings. Both pairs exist in workerd, in Node >= 18
// and in browsers, so this needs no Buffer and no polyfill.

const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;

function bytesToBase64(bytes: Uint8Array): string {
  // String.fromCharCode(...bytes) blows the argument limit on large inputs;
  // 0x8000 per chunk is the usual safe stride.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * UTF-8 → base64url, unpadded. Safe to drop straight into a query string: the
 * output alphabet is `A-Za-z0-9-_`, none of which URL-encodes.
 */
export function encodeShareParam(value: string): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > SHARE_PARAM_MAX_BYTES) {
    throw new ShareParamError(
      `Share payload is ${bytes.length} bytes; the limit is ${SHARE_PARAM_MAX_BYTES}.`,
      413,
    );
  }
  return bytesToBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * base64url → UTF-8, the inverse of {@link encodeShareParam}.
 *
 * Throws {@link ShareParamError} with status 413 when the payload is oversized
 * (checked from the encoded length first, so a hostile 10 MB param is rejected
 * without ever being decoded) and 400 for a malformed alphabet, bad padding or
 * invalid UTF-8.
 */
export function decodeShareParam(param: string): string {
  if (!BASE64URL_RE.test(param)) {
    throw new ShareParamError("Share payload is not valid base64url.", 400);
  }
  // Every 4 base64 chars carry 3 bytes. Reject on the estimate before decoding.
  if (Math.floor((param.length * 3) / 4) > SHARE_PARAM_MAX_BYTES) {
    throw new ShareParamError(
      `Share payload exceeds the ${SHARE_PARAM_MAX_BYTES}-byte limit.`,
      413,
    );
  }

  const padded = param.replace(/-/g, "+").replace(/_/g, "/");
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new ShareParamError("Share payload is not valid base64url.", 400);
  }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  if (bytes.length > SHARE_PARAM_MAX_BYTES) {
    throw new ShareParamError(
      `Share payload exceeds the ${SHARE_PARAM_MAX_BYTES}-byte limit.`,
      413,
    );
  }

  try {
    // fatal: a mangled param must fail loudly rather than decode to U+FFFD soup.
    // ignoreBOM: keep the bytes as written, so encode→decode is exact. (Both
    // flags are spelled out because workerd's types require ignoreBOM.)
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new ShareParamError("Share payload is not valid UTF-8.", 400);
  }
}

// -----------------------------------------------------------------------------
// Share payloads
// -----------------------------------------------------------------------------

/** Arguments for the Strudel player page (`/play`). */
export interface PlayShareArgs {
  code: string;
  bpm?: number;
  title?: string;
  autoplay?: boolean;
}

/** Arguments for the ABC sheet-music page (`/score`). */
export interface ScoreShareArgs {
  abcNotation: string;
  title?: string;
  instrument?: string;
  style?: string;
  tempo?: number;
  swing?: number;
  drumIntro?: number;
  transpose?: number;
}

export type ShareKind = "play" | "score";

export type SharePayload =
  | { kind: "play"; args: PlayShareArgs }
  | { kind: "score"; args: ScoreShareArgs };

// -----------------------------------------------------------------------------
// Query-string encoding
// -----------------------------------------------------------------------------
//
// Only the code/notation payload is base64url-encoded — it is the part that
// contains quotes, newlines, `&`, `-->` and arbitrary unicode. The scalar
// options travel as plain readable values (URLSearchParams percent-escapes the
// title), which keeps a share link legible and hand-editable.

function putNumber(q: URLSearchParams, key: string, value: number | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) {
    q.set(key, String(value));
  }
}

function putTitle(q: URLSearchParams, title: string | undefined) {
  const trimmed = title?.trim();
  if (trimmed) q.set("title", trimmed.slice(0, SHARE_TITLE_MAX_CHARS));
}

/** `?c=…&bpm=…&title=…&autoplay=…` for the Strudel page. */
export function playSearchParams(args: PlayShareArgs): URLSearchParams {
  const q = new URLSearchParams();
  q.set("c", encodeShareParam(args.code));
  putNumber(q, "bpm", args.bpm);
  putTitle(q, args.title);
  if (args.autoplay === false) q.set("autoplay", "0");
  return q;
}

/** `?a=…&instrument=…&style=…&…` for the ABC page. */
export function scoreSearchParams(args: ScoreShareArgs): URLSearchParams {
  const q = new URLSearchParams();
  q.set("a", encodeShareParam(args.abcNotation));
  putTitle(q, args.title);
  if (args.instrument) q.set("instrument", args.instrument);
  if (args.style) q.set("style", args.style);
  putNumber(q, "tempo", args.tempo);
  putNumber(q, "swing", args.swing);
  putNumber(q, "drumIntro", args.drumIntro);
  putNumber(q, "transpose", args.transpose);
  return q;
}

function parseNumber(q: URLSearchParams, key: string): number | undefined {
  const raw = q.get(key);
  if (raw === null || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new ShareParamError(`Query parameter "${key}" must be a number.`, 400);
  }
  return n;
}

function requiredPayload(q: URLSearchParams, key: string): string {
  const raw = q.get(key);
  if (raw === null) {
    throw new ShareParamError(`Missing required query parameter "${key}".`, 400);
  }
  return decodeShareParam(raw);
}

function parseTitle(q: URLSearchParams): string | undefined {
  const raw = q.get("title")?.trim();
  return raw ? raw.slice(0, SHARE_TITLE_MAX_CHARS) : undefined;
}

/** Inverse of {@link playSearchParams}. Throws {@link ShareParamError}. */
export function parsePlaySearchParams(q: URLSearchParams): PlayShareArgs {
  const autoplayRaw = q.get("autoplay");
  return {
    code: requiredPayload(q, "c"),
    bpm: parseNumber(q, "bpm"),
    title: parseTitle(q),
    autoplay:
      autoplayRaw === null
        ? undefined
        : !(autoplayRaw === "0" || autoplayRaw.toLowerCase() === "false"),
  };
}

/** Inverse of {@link scoreSearchParams}. Throws {@link ShareParamError}. */
export function parseScoreSearchParams(q: URLSearchParams): ScoreShareArgs {
  return {
    abcNotation: requiredPayload(q, "a"),
    title: parseTitle(q),
    instrument: q.get("instrument") ?? undefined,
    style: q.get("style") ?? undefined,
    tempo: parseNumber(q, "tempo"),
    swing: parseNumber(q, "swing"),
    drumIntro: parseNumber(q, "drumIntro"),
    transpose: parseNumber(q, "transpose"),
  };
}

// -----------------------------------------------------------------------------
// URL builders
// -----------------------------------------------------------------------------

function normalizeOrigin(origin: string | undefined): string {
  return (origin || DEFAULT_SHARE_ORIGIN).replace(/\/+$/, "");
}

/**
 * Build the query-string share URL, or `null` when the encoded payload is too
 * long to travel in a URL — the caller should fall back to KV (`/p/<id>`), or
 * simply omit the link when it has no KV (the local stdio server).
 */
export function buildShareQueryUrl(
  payload: SharePayload,
  origin?: string,
): string | null {
  let q: URLSearchParams;
  try {
    q =
      payload.kind === "play"
        ? playSearchParams(payload.args)
        : scoreSearchParams(payload.args);
  } catch (err) {
    if (err instanceof ShareParamError) return null;
    throw err;
  }

  const encoded = q.get(payload.kind === "play" ? "c" : "a") ?? "";
  if (encoded.length > SHARE_QUERY_MAX_CHARS) return null;

  const path = payload.kind === "play" ? "/play" : "/score";
  return `${normalizeOrigin(origin)}${path}?${q.toString()}`;
}

/** The URL a stored share is served from. */
export function buildStoredShareUrl(id: string, origin?: string): string {
  return `${normalizeOrigin(origin)}/p/${id}`;
}

// -----------------------------------------------------------------------------
// KV identity
// -----------------------------------------------------------------------------

/**
 * Content-addressed id for a stored share: the first 32 hex chars of the
 * SHA-256 of the canonical payload. Two identical patterns collapse onto one
 * key (a re-run refreshes the TTL instead of filling KV with duplicates), and
 * the id leaks nothing about the content.
 */
export async function shareId(payload: SharePayload): Promise<string> {
  const canonical = JSON.stringify([payload.kind, payload.args]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/** KV key for a stored share. Namespaced so it can share the docs-cache KV. */
export function shareKvKey(id: string): string {
  return `share:${id}`;
}

/** Ids are our own hex digests — reject anything else before touching KV. */
export function isValidShareId(id: string): boolean {
  return /^[0-9a-f]{32}$/.test(id);
}

// -----------------------------------------------------------------------------
// CSP for the hosted player pages
// -----------------------------------------------------------------------------

/**
 * Response CSP for a hosted player page, derived from the same domain lists the
 * ext-apps widgets declare (`SHEET_CSP` / `STRUDEL_CSP` in tool-defs) so the two
 * cannot drift.
 *
 * `'unsafe-inline'` and `'unsafe-eval'` are unavoidable here: both pages carry
 * inline bootstrap scripts, and Strudel *is* a JavaScript evaluator — a pattern
 * is code by definition. The value of the header is therefore not script
 * containment but egress containment: `connect-src` pins where a page may talk
 * to, and `frame-ancestors 'none'` stops the page being framed elsewhere.
 */
export function buildPlayerCsp(domains: {
  resourceDomains?: string[];
  connectDomains?: string[];
}): string {
  const resource = domains.resourceDomains ?? [];
  const connect = domains.connectDomains ?? [];
  const join = (...parts: (string | string[])[]) =>
    parts.flat().filter(Boolean).join(" ");

  return [
    "default-src 'none'",
    join("script-src 'self' 'unsafe-inline' 'unsafe-eval'", resource),
    join("style-src 'self' 'unsafe-inline'", resource),
    join("font-src 'self' data:", resource),
    "img-src 'self' data: blob:",
    join("connect-src 'self' data: blob:", resource, connect),
    join("media-src 'self' data: blob:", resource, connect),
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}
