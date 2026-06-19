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
  PLAY_SHEET_NEUTRAL_TEXT,
  playSheetInputSchema,
  PLAY_LIVE_BASE_DESCRIPTION,
  PLAY_LIVE_EXT_APPS_SUFFIX,
  playLiveInputSchema,
  buildPlayLiveResult,
  GET_MUSIC_GUIDE_DESCRIPTION,
  GET_MUSIC_GUIDE_TOPIC_DESCRIPTION,
  GET_STRUDEL_GUIDE_DESCRIPTION,
  GET_STRUDEL_GUIDE_TOPIC_DESCRIPTION,
  SEARCH_DOCS_DESCRIPTION,
  searchDocsInputSchema,
  searchMusicDocs,
  registerMusicPrompts,
} from "../../src/shared/tool-defs.js";

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
// Server factory — creates a fresh McpServer per request (stateless)
// =============================================================================

function createMusicServer(env: Env): McpServer {
  const server = new McpServer(
    { name: "Music Studio", version: VERSION },
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
  // Note: ABC is parsed/rendered client-side in the widget, so the worker does
  // not assert a parse result here — neutral wording avoids a false success.
  server.registerTool(
    "play-sheet-music",
    {
      title: "Play Sheet Music",
      description: PLAY_SHEET_BASE_DESCRIPTION + PLAY_SHEET_EXT_APPS_SUFFIX,
      inputSchema: playSheetInputSchema,
      annotations: PLAY_TOOL_ANNOTATIONS,
      _meta: {
        ui: { resourceUri: SHEET_RESOURCE_URI },
        "ui/resourceUri": SHEET_RESOURCE_URI,
      },
    },
    async () => ({
      content: [{ type: "text" as const, text: PLAY_SHEET_NEUTRAL_TEXT }],
    }),
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
      _meta: {
        ui: { resourceUri: STRUDEL_RESOURCE_URI },
        "ui/resourceUri": STRUDEL_RESOURCE_URI,
      },
    },
    async (args) => buildPlayLiveResult(args),
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
      return new Response(JSON.stringify({ status: "ok", version: VERSION }), {
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
      trackRequest(env, ctx, request);

      // New McpServer per request — stateless, like the official ext-apps examples.
      // enableJsonResponse is required for Claude Desktop Connectors to render
      // ext-apps UI — the default SSE response format isn't parsed correctly
      // by the Connector client for resources/read calls.
      const server = createMusicServer(env);
      // `agents` bundles its own @modelcontextprotocol/sdk copy, so its McpServer
      // type is nominally distinct from ours (separate private fields). Safe at runtime.
      const handler = createMcpHandler(
        server as unknown as Parameters<typeof createMcpHandler>[0],
        {
          route: null as unknown as string,
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        },
      );
      return handler(request, env, ctx);
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
