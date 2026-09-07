/**
 * Command-line parsing for the local server, kept as pure functions so the
 * argument handling can be tested without starting a listener.
 *
 * Two things this module is deliberately strict about:
 *
 * 1. **Token normalisation.** Some MCP clients build the argv array by joining
 *    configured args with a space, so a flag can arrive as `"--stdio "` or even
 *    `"--render-mode browser"` in a single token (see CLAUDE.md → Client Quirks,
 *    Cherry Studio). `--stdio` used to be matched with a raw
 *    `process.argv.includes("--stdio")`, which those spellings miss — the server
 *    then silently started an HTTP listener instead of speaking stdio.
 *    Everything here runs off one normalised token list.
 *
 * 2. **Bind address.** The HTTP transport is unauthenticated. It must default to
 *    loopback, and exposing it beyond loopback must be a deliberate, noisy act.
 */

export type RenderMode = "auto" | "html" | "browser";

/** Default HTTP bind address — loopback, never all interfaces. */
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3001;

/**
 * Hosts the MCP SDK treats as loopback: `createMcpExpressApp({ host })` turns on
 * Host-header (DNS-rebinding) validation automatically for exactly these.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Origins allowed by default: a browser page served from this machine. */
const LOOPBACK_ORIGIN_RE =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

export interface CliOptions {
  stdio: boolean;
  renderMode: RenderMode;
  outputDir?: string;
  host: string;
  port: number;
  /** Explicit CORS allowlist from `--allow-origin`; empty means "loopback only". */
  allowedOrigins: string[];
  /** Messages the caller should print to stderr (bad values, risky bindings). */
  warnings: string[];
}

/**
 * One normalised token list for flags AND values.
 *
 * Every token is trimmed and blanks are dropped, so `"--stdio "` and `" --stdio"`
 * are the same flag as `"--stdio"`.
 */
export function normalizeArgv(argv: readonly string[]): string[] {
  return argv.map((a) => a.trim()).filter((a) => a.length > 0);
}

/**
 * The value carried inside a single joined `"--name value"` token.
 *
 * Stops at the next ` --`, so `"--render-mode browser --stdio"` yields
 * `"browser"` rather than swallowing the following flag. A path containing
 * ` --` is pathological and not worth protecting.
 */
function joinedValue(rest: string): string {
  const next = rest.indexOf(" --");
  return (next >= 0 ? rest.slice(0, next) : rest).trim();
}

/**
 * True when the value-less flag `name` is present, in any spelling.
 *
 * Splitting on whitespace catches it wherever a client joined it into a bigger
 * token — `"--stdio "`, `"--stdio --render-mode browser"`, or trailing in
 * `"--render-mode browser --stdio"`.
 */
export function hasFlag(tokens: readonly string[], name: string): boolean {
  return tokens.some((t) => t.split(/\s+/).includes(name));
}

/** Every value given for `name` (`--n v`, `--n=v`, or one joined `"--n v"` token). */
export function argValues(
  tokens: readonly string[],
  name: string,
): string[] {
  const values: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === name) {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith("--")) values.push(next);
      continue;
    }
    if (token.startsWith(`${name}=`)) {
      values.push(token.slice(name.length + 1).trim());
      continue;
    }
    if (token.startsWith(`${name} `)) {
      const value = joinedValue(token.slice(name.length));
      if (value) values.push(value);
    }
  }
  return values;
}

/** The last value given for `name`, or undefined. */
export function argValue(
  tokens: readonly string[],
  name: string,
): string | undefined {
  return argValues(tokens, name).at(-1);
}

/** Is this bind address loopback-only? */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

/**
 * CORS policy. Called per request with the browser's `Origin`.
 *
 * - No `Origin` (curl, an MCP CLI, any non-browser client) → allowed; CORS is a
 *   browser-side control and there is nothing to guard.
 * - An explicit `--allow-origin` list → exact matches only (`*` opts back into
 *   the old wildcard, deliberately).
 * - Otherwise → loopback pages only. The previous default was bare `cors()`,
 *   i.e. every website the user visits could drive this server.
 */
export function isOriginAllowed(
  origin: string | undefined,
  policy: { allowedOrigins?: readonly string[] } = {},
): boolean {
  if (!origin) return true;
  const list = policy.allowedOrigins ?? [];
  if (list.length > 0) return list.includes("*") || list.includes(origin);
  return LOOPBACK_ORIGIN_RE.test(origin);
}

function parsePort(raw: string | undefined, warnings: string[]): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_PORT;
  const port = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    warnings.push(`Invalid PORT "${raw}", using ${DEFAULT_PORT}.`);
    return DEFAULT_PORT;
  }
  return port;
}

export function parseCliOptions(
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
): CliOptions {
  const tokens = normalizeArgv(argv);
  const warnings: string[] = [];

  const rawMode = argValue(tokens, "--render-mode");
  let renderMode: RenderMode = "auto";
  if (rawMode) {
    if (rawMode === "auto" || rawMode === "html" || rawMode === "browser") {
      renderMode = rawMode;
    } else {
      warnings.push(`Unknown render mode "${rawMode}", using "auto".`);
    }
  }

  const host = argValue(tokens, "--host") ?? DEFAULT_HOST;
  const allowedOrigins = argValues(tokens, "--allow-origin")
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);

  if (!isLoopbackHost(host)) {
    warnings.push(
      `Binding to ${host}: the MCP endpoint is UNAUTHENTICATED and reachable ` +
        "beyond this machine. Anyone who can reach it can drive the server " +
        "(in --render-mode browser that means writing files here and launching " +
        "a browser). Put it behind a proxy that authenticates, or drop --host.",
    );
    if (allowedOrigins.includes("*")) {
      warnings.push(
        "--allow-origin '*' on a non-loopback bind allows every website the " +
          "user visits to call this server.",
      );
    }
  }

  return {
    stdio: hasFlag(tokens, "--stdio"),
    renderMode,
    outputDir: argValue(tokens, "--output-dir"),
    host,
    port: parsePort(env.PORT, warnings),
    allowedOrigins,
    warnings,
  };
}

/**
 * The URL a human should paste, given the bind address. `0.0.0.0`/`::` are not
 * connectable addresses, so print loopback for those rather than lying twice.
 */
export function displayUrl(host: string, port: number): string {
  const hostname =
    host === "0.0.0.0" || host === "::" || host === "[::]"
      ? "localhost"
      : host === "::1"
        ? "[::1]"
        : host;
  return `http://${hostname}:${port}/mcp`;
}
