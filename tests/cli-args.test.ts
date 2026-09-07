import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  argValue,
  argValues,
  displayUrl,
  hasFlag,
  isLoopbackHost,
  isOriginAllowed,
  normalizeArgv,
  parseCliOptions,
} from "../src/cli-args";

// argv as a real launcher hands it over: [node, script, ...flags].
const argv = (...flags: string[]) => ["/usr/bin/node", "/app/index.js", ...flags];

describe("argv normalisation", () => {
  it("trims every token and drops blanks", () => {
    expect(normalizeArgv(["  --stdio ", "", "  ", " x "])).toEqual([
      "--stdio",
      "x",
    ]);
  });

  // Cherry Studio joins configured args with a trailing space (CLAUDE.md →
  // Client Quirks). `process.argv.includes("--stdio")` missed that spelling, so
  // the server quietly started an HTTP listener and the client saw no server.
  it("detects --stdio however the client spelled it", () => {
    for (const raw of ["--stdio", "--stdio ", " --stdio", "  --stdio  "]) {
      expect(parseCliOptions(argv(raw)).stdio, raw).toBe(true);
    }
  });

  it("detects --stdio inside a single joined token", () => {
    expect(parseCliOptions(argv("--stdio --render-mode browser")).stdio).toBe(
      true,
    );
  });

  it("does not fire on a lookalike flag", () => {
    expect(parseCliOptions(argv("--stdiox")).stdio).toBe(false);
    expect(hasFlag(["--stdio-mode"], "--stdio")).toBe(false);
  });

  it("stays false when no transport flag is given (HTTP mode)", () => {
    expect(parseCliOptions(argv()).stdio).toBe(false);
  });
});

describe("flag values", () => {
  it("reads all three spellings", () => {
    expect(argValue(["--render-mode", "html"], "--render-mode")).toBe("html");
    expect(argValue(["--render-mode=html"], "--render-mode")).toBe("html");
    expect(argValue(["--render-mode html"], "--render-mode")).toBe("html");
  });

  it("reads a value whose token carries trailing whitespace", () => {
    expect(parseCliOptions(argv("--render-mode ", " browser ")).renderMode).toBe(
      "browser",
    );
  });

  it("stops a joined value at the next flag", () => {
    const options = parseCliOptions(argv("--render-mode browser --stdio"));
    expect(options.renderMode).toBe("browser");
    expect(options.stdio).toBe(true);
  });

  it("never swallows the following flag as a value", () => {
    expect(argValue(["--output-dir", "--stdio"], "--output-dir")).toBeUndefined();
  });

  it("collects repeated occurrences", () => {
    expect(
      argValues(["--allow-origin", "a", "--allow-origin=b"], "--allow-origin"),
    ).toEqual(["a", "b"]);
  });

  it("falls back to auto and warns on an unknown render mode", () => {
    const options = parseCliOptions(argv("--render-mode", "hologram"));
    expect(options.renderMode).toBe("auto");
    expect(options.warnings.join(" ")).toContain("hologram");
  });

  it("passes --output-dir through", () => {
    expect(parseCliOptions(argv("--output-dir", "/tmp/scores")).outputDir).toBe(
      "/tmp/scores",
    );
  });
});

describe("bind address", () => {
  // The HTTP transport is unauthenticated. It used to bind 0.0.0.0 while
  // logging "localhost", so a LAN caller could reach it — and in
  // --render-mode browser make this machine write HTML and launch a browser.
  it("defaults to loopback", () => {
    const options = parseCliOptions(argv());
    expect(options.host).toBe(DEFAULT_HOST);
    expect(isLoopbackHost(options.host)).toBe(true);
    expect(options.warnings).toEqual([]);
  });

  it("honours an explicit --host and warns loudly about exposure", () => {
    const options = parseCliOptions(argv("--host", "0.0.0.0"));
    expect(options.host).toBe("0.0.0.0");
    expect(options.warnings.join(" ")).toMatch(/UNAUTHENTICATED/);
  });

  it("stays quiet for other loopback spellings", () => {
    for (const host of ["localhost", "::1", "127.0.0.1"]) {
      expect(parseCliOptions(argv("--host", host)).warnings, host).toEqual([]);
    }
  });

  it("prints an address a human can actually open", () => {
    expect(displayUrl("127.0.0.1", 3001)).toBe("http://127.0.0.1:3001/mcp");
    // 0.0.0.0 is a bind address, not a destination.
    expect(displayUrl("0.0.0.0", 3001)).toBe("http://localhost:3001/mcp");
    expect(displayUrl("::1", 3001)).toBe("http://[::1]:3001/mcp");
  });
});

describe("port", () => {
  it("defaults when PORT is absent", () => {
    expect(parseCliOptions(argv(), {}).port).toBe(DEFAULT_PORT);
  });

  it("reads PORT from the environment", () => {
    expect(parseCliOptions(argv(), { PORT: "8080" }).port).toBe(8080);
  });

  it("falls back and warns on a nonsense PORT instead of listening on NaN", () => {
    const options = parseCliOptions(argv(), { PORT: "not-a-port" });
    expect(options.port).toBe(DEFAULT_PORT);
    expect(options.warnings.join(" ")).toContain("Invalid PORT");
  });

  it("rejects out-of-range ports", () => {
    expect(parseCliOptions(argv(), { PORT: "99999" }).port).toBe(DEFAULT_PORT);
  });
});

describe("CORS policy", () => {
  // The old middleware was a bare cors(), i.e. Access-Control-Allow-Origin: *
  // on an unauthenticated endpoint: any page the user visited could drive it.
  it("allows loopback pages by default", () => {
    for (const origin of [
      "http://localhost:6274",
      "http://127.0.0.1:3000",
      "https://localhost",
      "http://[::1]:8080",
    ]) {
      expect(isOriginAllowed(origin), origin).toBe(true);
    }
  });

  it("rejects arbitrary websites by default", () => {
    for (const origin of [
      "https://evil.example.com",
      "http://localhost.evil.com",
      "https://notlocalhost",
    ]) {
      expect(isOriginAllowed(origin), origin).toBe(false);
    }
  });

  it("allows requests with no Origin (curl, CLI clients)", () => {
    expect(isOriginAllowed(undefined)).toBe(true);
  });

  it("honours an explicit allowlist, exactly", () => {
    const policy = { allowedOrigins: ["https://studio.example.com"] };
    expect(isOriginAllowed("https://studio.example.com", policy)).toBe(true);
    expect(isOriginAllowed("https://studio.example.com.evil.net", policy)).toBe(
      false,
    );
    // An explicit list replaces the loopback default rather than extending it.
    expect(isOriginAllowed("http://localhost:6274", policy)).toBe(false);
  });

  it("still supports an opt-in wildcard", () => {
    expect(isOriginAllowed("https://anything", { allowedOrigins: ["*"] })).toBe(
      true,
    );
  });

  it("splits a comma-separated --allow-origin", () => {
    const options = parseCliOptions(
      argv("--allow-origin", "https://a.test,https://b.test"),
    );
    expect(options.allowedOrigins).toEqual(["https://a.test", "https://b.test"]);
  });

  it("warns when a wildcard is combined with a non-loopback bind", () => {
    const options = parseCliOptions(
      argv("--host", "0.0.0.0", "--allow-origin", "*"),
    );
    expect(options.warnings.join(" ")).toContain("every website");
  });
});
