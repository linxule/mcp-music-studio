/**
 * Entry point for running the MCP server.
 * Run with: npx mcp-music-studio [--stdio] [--render-mode auto|html|browser]
 *                                [--output-dir DIR] [--host ADDR] [--allow-origin ORIGIN]
 *
 * Argument parsing lives in src/cli-args.ts (pure + unit-tested).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import type { Request, Response } from "express";
import { createServer } from "./server.js";
import {
  displayUrl,
  isLoopbackHost,
  isOriginAllowed,
  parseCliOptions,
  type CliOptions,
} from "./src/cli-args.js";

/**
 * Starts an MCP server with Streamable HTTP transport in stateless mode.
 *
 * The endpoint is unauthenticated, so the defaults matter:
 *
 * - **Bind address** is loopback unless `--host` says otherwise. Passing a
 *   loopback host to `createMcpExpressApp` is also what switches on the SDK's
 *   Host-header (DNS-rebinding) validation, so the two must stay in sync — the
 *   old code bound `0.0.0.0`, lost that protection, and still logged
 *   "localhost".
 * - **CORS** is no longer a bare `cors()` wildcard; see `isOriginAllowed`.
 *
 * @param createServer - Factory function that creates a new McpServer instance per request.
 * @param options - Parsed CLI options (bind address, CORS allowlist, port).
 */
export async function startStreamableHTTPServer(
  createServer: () => McpServer,
  options: Pick<CliOptions, "host" | "port" | "allowedOrigins">,
): Promise<void> {
  const { host, port, allowedOrigins } = options;

  // Passing the real bind address is what enables the SDK's Host-header
  // validation for loopback hosts (and makes it warn loudly for 0.0.0.0/::).
  const app = createMcpExpressApp({ host });

  app.use(
    cors({
      origin(origin, callback) {
        callback(null, isOriginAllowed(origin, { allowedOrigins }));
      },
      // Streamable HTTP clients need to read the session id back off the response.
      exposedHeaders: ["mcp-session-id", "mcp-protocol-version"],
    }),
  );

  app.all("/mcp", async (req: Request, res: Response) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const httpServer = app.listen(port, host, () => {
    // Print the address actually bound, not a hopeful "localhost".
    console.log(
      `MCP server listening on ${displayUrl(host, port)} (bound to ${host}:${port})`,
    );
    if (!isLoopbackHost(host)) {
      console.warn(
        `WARNING: bound to ${host} — this MCP endpoint is unauthenticated and ` +
          "reachable beyond this machine.",
      );
    }
  });
  httpServer.on("error", (err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });

  const shutdown = () => {
    console.log("\nShutting down...");
    httpServer.close(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Starts an MCP server with stdio transport.
 *
 * @param createServer - Factory function that creates a new McpServer instance.
 */
export async function startStdioServer(
  createServer: () => McpServer,
): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}

async function main() {
  const options = parseCliOptions(process.argv, process.env);
  // stderr, so a stdio transport's stdout stays pure JSON-RPC.
  for (const warning of options.warnings) console.error(warning);

  const factory = () =>
    createServer({
      defaultRenderMode: options.renderMode,
      outputDir: options.outputDir,
    });

  if (options.stdio) {
    await startStdioServer(factory);
  } else {
    await startStreamableHTTPServer(factory, options);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
