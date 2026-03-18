/**
 * Entry point for running the MCP server.
 * Run with: npx mcp-music-studio [--stdio] [--render-mode auto|html|browser]
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import type { Request, Response } from "express";
import { createServer, type RenderMode } from "./server.js";

/**
 * Starts an MCP server with Streamable HTTP transport in stateless mode.
 *
 * @param createServer - Factory function that creates a new McpServer instance per request.
 */
export async function startStreamableHTTPServer(
  createServer: () => McpServer,
): Promise<void> {
  const port = parseInt(process.env.PORT ?? "3001", 10);

  const app = createMcpExpressApp({ host: "0.0.0.0" });
  app.use(cors());

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

  const httpServer = app.listen(port, () => {
    console.log(`MCP server listening on http://localhost:${port}/mcp`);
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

function parseArg(name: string): string | undefined {
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i].trim();
    // --name value
    if (arg === name && i + 1 < process.argv.length) return process.argv[i + 1].trim();
    // --name=value
    if (arg.startsWith(name + "=")) return arg.slice(name.length + 1).trim();
    // "--name value" (joined with space by some clients)
    if (arg.startsWith(name + " ")) return arg.slice(name.length).trim();
  }
  return undefined;
}

function parseRenderMode(): RenderMode {
  const val = parseArg("--render-mode");
  if (!val) return "auto";
  if (val === "html" || val === "browser" || val === "auto") return val;
  console.error(`Unknown render mode "${val}", using "auto"`);
  return "auto";
}

function parseOutputDir(): string | undefined {
  return parseArg("--output-dir");
}

async function main() {
  const defaultRenderMode = parseRenderMode();
  const outputDir = parseOutputDir();
  const factory = () => createServer({ defaultRenderMode, outputDir });

  if (process.argv.includes("--stdio")) {
    await startStdioServer(factory);
  } else {
    await startStreamableHTTPServer(factory);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
