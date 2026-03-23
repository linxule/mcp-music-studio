// =============================================================================
// MCP Music Studio — Cloudflare Worker
//
// Remote MCP server for one-paste setup. Stateless handler (new server per
// request) using createMcpHandler + WorkerTransport — matches the official
// ext-apps example pattern for reliable UI rendering in Claude Desktop.
// =============================================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";

// Shared guide content (pure data, no Node.js deps)
import {
  ABC_GUIDE_TOPICS,
  ABC_GUIDES,
  DEFAULT_ABC_NOTATION,
} from "../../src/abc-guide.js";
import {
  STRUDEL_GUIDE_TOPICS,
  STRUDEL_GUIDES,
} from "../../src/strudel-guide.js";
import { STYLE_NAMES } from "../../src/music-logic.js";

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

function parseClient(ua: string): string {
  const lower = ua.toLowerCase();
  if (lower === "claude-user") return "claude-ai";
  if (lower.includes("claude-ai") || lower.includes("claude.ai"))
    return "claude-ai";
  if (lower.includes("claude-code") || lower.includes("claude code"))
    return "claude-code";
  if (lower.includes("cursor")) return "cursor";
  if (lower.includes("gemini")) return "gemini";
  if (lower.includes("windsurf")) return "windsurf";
  if (lower.includes("cline")) return "cline";
  if (lower.includes("smithery")) return "smithery";
  if (lower.includes("mcp-remote")) return "mcp-remote";
  return "unknown";
}

function trackRequest(
  env: Env,
  ctx: ExecutionContext,
  request: Request,
) {
  const rawUA = request.headers.get("user-agent") ?? "";
  const client = parseClient(rawUA);
  const truncUA = rawUA.substring(0, 200);

  if (request.method === "GET") {
    track(env, {
      blobs: ["session", "", "", truncUA],
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

        // Track all JSON-RPC methods for debugging ext-apps lifecycle
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
            blobs: ["tool_call", tool, detail, truncUA],
            indexes: [client],
          });
        } else if (method === "resources/read") {
          const uri = body.params?.uri ?? "";
          track(env, {
            blobs: ["resource_read", uri, "", truncUA],
            indexes: [client],
          });
        } else {
          // initialize, tools/list, resources/list, etc.
          track(env, {
            blobs: ["mcp_method", method, "", truncUA],
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
const SHEET_RESOURCE_URI = "ui://sheet-music/mcp-app.html";
const STRUDEL_RESOURCE_URI = "ui://strudel/strudel-app.html";

// =============================================================================
// Server factory — creates a fresh McpServer per request (stateless)
// =============================================================================

function createMusicServer(env: Env): McpServer {
  const server = new McpServer({
    name: "Music Studio",
    version: "0.2.1",
  });

  // Advertise ext-apps support so clients know to render UI widgets
  server.server.registerCapabilities({
    extensions: {
      "io.modelcontextprotocol/ui": {},
    },
  });

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
          _meta: {
            ui: {
              csp: {
                connectDomains: ["https://paulrosen.github.io"],
              },
            },
          },
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
          _meta: {
            ui: {
              csp: {
                resourceDomains: [
                  "https://unpkg.com",
                  "https://cdn.jsdelivr.net",
                ],
                connectDomains: [
                  "https://unpkg.com",
                  "https://raw.githubusercontent.com",
                  "https://cdn.jsdelivr.net",
                  "https://felixroos.github.io",
                  "https://tidalcycles.github.io",
                ],
              },
            },
          },
        },
      ],
    }),
  );

  // ===========================================================================
  // Tool: play-sheet-music (registerTool for _meta support)
  // ===========================================================================

  server.registerTool(
    "play-sheet-music",
    {
      title: "Play Sheet Music",
      description:
        "Compose and play sheet music with visual notation, multi-instrument audio, " +
        "and style presets. Write ABC notation for melodies, arrangements, harmonized " +
        "pieces, or well-known tunes. Add a style (rock, jazz, bossa, waltz, folk...) " +
        "for automatic drums, bass, and chord accompaniment. " +
        "Use get-music-guide for genre templates, instrument lists, and ABC syntax reference." +
        "\n\nThe music player renders inline with interactive playback controls.",
      inputSchema: z.object({
        abcNotation: z
          .string()
          .default(DEFAULT_ABC_NOTATION)
          .describe(
            'ABC notation string. Include chord symbols ("C", "Am7") above notes for auto-accompaniment with style presets.',
          ),
        title: z
          .string()
          .optional()
          .describe(
            "Piece title (overrides T: in ABC). Displayed in the widget header.",
          ),
        instrument: z
          .string()
          .optional()
          .describe(
            "Default instrument (e.g. 'Flute', 'Cello', 'Acoustic Grand Piano', 'Alto Sax'). " +
              "Use get-music-guide with topic 'instruments' for the full list.",
          ),
        style: z
          .enum(STYLE_NAMES)
          .optional()
          .describe(
            "Accompaniment style. Adds drums, bass, and chord patterns automatically. " +
              'Your ABC needs chord symbols ("C", "Am") for accompaniment to work. ' +
              "Options: rock, jazz, bossa, waltz, march, reggae, folk, classical.",
          ),
        tempo: z
          .number()
          .min(40)
          .max(240)
          .optional()
          .describe("Tempo in BPM (40-240). Overrides Q: in ABC notation."),
        swing: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe(
            "Swing percentage (0-100). 0=straight, 33=light swing, 66=heavy swing. Great for jazz and blues.",
          ),
        transpose: z
          .number()
          .min(-12)
          .max(12)
          .optional()
          .describe(
            "Transpose by semitones (-12 to 12). Positive=higher, negative=lower.",
          ),
      }),
      _meta: {
        ui: { resourceUri: SHEET_RESOURCE_URI },
        "ui/resourceUri": SHEET_RESOURCE_URI,
      },
    },
    async () => ({
      content: [
        { type: "text" as const, text: "Music parsed successfully. Playing!" },
      ],
    }),
  );

  // ===========================================================================
  // Tool: get-music-guide
  // ===========================================================================

  server.tool(
    "get-music-guide",
    "Returns detailed reference material for music composition. " +
      "Topics: instruments (GM instrument list + combos), drums (patterns + percussion notes), " +
      "abc-syntax (notation reference), arrangements (multi-voice patterns), " +
      "genres (complete ABC templates for jazz/blues/folk/rock/bossa/classical), " +
      "styles (what each style preset does), midi-directives (%%MIDI reference).",
    {
      topic: z
        .enum(ABC_GUIDE_TOPICS)
        .describe(
          "Reference topic. Start with 'genres' for complete examples, 'styles' to understand presets, or 'instruments' for the full instrument list.",
        ),
    },
    async ({ topic }) => ({
      content: [{ type: "text" as const, text: ABC_GUIDES[topic] }],
    }),
  );

  // ===========================================================================
  // Tool: play-live-pattern (registerTool for _meta support)
  // ===========================================================================

  server.registerTool(
    "play-live-pattern",
    {
      title: "Play Live Pattern",
      description:
        "Live-code music patterns using TidalCycles mini-notation in JavaScript. " +
        "Layer drums, synths, and bass with stack(). Choose from 72 drum machine banks, " +
        "128 GM instruments, built-in synths, and a full effects chain. " +
        "Patterns play in a REPL the user can edit directly. " +
        "Use get-strudel-guide for genre templates, sound references, and advanced features " +
        "like visualization, arrangement, and sample loading." +
        "\n\nThe Strudel REPL renders inline with an editable code editor, " +
        "visualizations, and playback controls.",
      inputSchema: z.object({
        code: z
          .string()
          .describe(
            "Strudel pattern code. Uses TidalCycles mini-notation in JavaScript. " +
              "Use stack() to layer drums, bass, and melody. " +
              "Set tempo with setcps(bpm/60/4) or use the bpm parameter.",
          ),
        title: z
          .string()
          .optional()
          .describe(
            "Pattern title displayed in the widget header (e.g. 'Midnight Rain').",
          ),
        bpm: z
          .number()
          .min(40)
          .max(300)
          .optional()
          .describe(
            "Tempo in BPM (40-300). Converts to setcps() automatically.",
          ),
        autoplay: z
          .boolean()
          .optional()
          .describe(
            "Start playing immediately (default: true). May require user click due to browser autoplay policy.",
          ),
      }),
      _meta: {
        ui: { resourceUri: STRUDEL_RESOURCE_URI },
        "ui/resourceUri": STRUDEL_RESOURCE_URI,
      },
    },
    async (args) => {
      const label = args.title ? `"${args.title}" — ` : "";
      return {
        content: [
          { type: "text" as const, text: `${label}Strudel pattern playing.` },
        ],
      };
    },
  );

  // ===========================================================================
  // Tool: get-strudel-guide
  // ===========================================================================

  server.tool(
    "get-strudel-guide",
    "Reference material for Strudel live coding (performance mode). " +
      "Topics: mini-notation (pattern syntax), sounds (synths, 72 drum banks, 128 GM instruments), " +
      "effects (filters, reverb, delay, FM synthesis, envelopes), " +
      "patterns (transformations, probability, euclidean, arrangement), " +
      "genres (complete templates: techno/house/dnb/ambient/jazz/lofi/synthwave), " +
      "tips (tempo, common mistakes, ABC↔Strudel crossover), " +
      "advanced (visualization, sample loading, wavetables, ZZFX, continuous signals, chord voicings).",
    {
      topic: z
        .enum(STRUDEL_GUIDE_TOPICS)
        .describe(
          "Reference topic. Start with 'genres' for working templates, " +
            "'sounds' for instruments, 'advanced' for visualization and sample loading.",
        ),
    },
    async ({ topic }) => ({
      content: [{ type: "text" as const, text: STRUDEL_GUIDES[topic] }],
    }),
  );

  // ===========================================================================
  // Tool: search-music-docs (Context7-powered semantic search)
  // ===========================================================================

  server.tool(
    "search-music-docs",
    "Search detailed documentation for Strudel live coding or ABC/ABCJS notation. " +
      "Returns relevant code examples and explanations from the official docs. " +
      "Use this when the curated guides (get-strudel-guide, get-music-guide) don't " +
      "cover what you need — for specific functions, advanced techniques, or when " +
      "you're unsure about syntax. Powered by semantic search over strudel.cc and ABCJS docs.",
    {
      query: z
        .string()
        .describe(
          "What you want to know. Be specific. " +
            "Good: 'how to use FM synthesis with envelope' or 'chop and slice sample manipulation'. " +
            "Bad: 'effects' or 'help'.",
        ),
      library: z
        .enum(["strudel", "abcjs"])
        .default("strudel")
        .describe(
          "Which library to search: 'strudel' for live coding patterns, 'abcjs' for sheet music notation.",
        ),
    },
    async ({ query, library }) => {
      const libraryId =
        library === "strudel"
          ? "/websites/strudel_cc"
          : "/paulrosen/abcjs";

      // Check KV cache first
      const cacheKey = `ctx7:${library}:${query}`;
      try {
        const cached = await env.DOCS_CACHE.get(cacheKey);
        if (cached) {
          return { content: [{ type: "text" as const, text: cached }] };
        }
      } catch {}

      const params = new URLSearchParams({ libraryId, query, type: "txt" });
      const url = `https://context7.com/api/v2/context?${params}`;
      const apiKey = env.CONTEXT7_API_KEY ?? "";

      try {
        let res = await fetch(url);
        if (res.status === 429 && apiKey && apiKey.startsWith("ctx7sk")) {
          res = await fetch(url, {
            headers: { Authorization: `Bearer ${apiKey}` },
          });
        }

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Documentation search failed (${res.status}). ${errText}\n\nTry the curated guides instead.`,
              },
            ],
          };
        }

        const text = await res.text();
        if (!text || text.trim().length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No results found for "${query}" in ${library} docs. Try rephrasing or use the curated guides.`,
              },
            ],
          };
        }

        try {
          await env.DOCS_CACHE.put(cacheKey, text, { expirationTtl: 86400 });
        } catch {}

        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Documentation search error: ${(err as Error).message}\n\nUse get-strudel-guide or get-music-guide as fallback.`,
            },
          ],
        };
      }
    },
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
        contents: [
          { uri, mimeType: "text/plain" as const, text: ABC_GUIDES[topic] },
        ],
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
        contents: [
          {
            uri,
            mimeType: "text/plain" as const,
            text: STRUDEL_GUIDES[topic],
          },
        ],
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

    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
      trackRequest(env, ctx, request);

      // New McpServer per request — stateless, like the official ext-apps examples.
      // enableJsonResponse is required for Claude Desktop Connectors to render
      // ext-apps UI — the default SSE response format isn't parsed correctly
      // by the Connector client for resources/read calls.
      const server = createMusicServer(env);
      const handler = createMcpHandler(server, {
        route: null as unknown as string,
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      return handler(request, env, ctx);
    }

    // Favicon — redirect to GitHub raw (no proxy subrequests)
    if (url.pathname === "/favicon.ico" || url.pathname === "/favicon.png") {
      return new Response(null, {
        status: 301,
        headers: {
          Location: "https://raw.githubusercontent.com/linxule/mcp-music-studio/main/assets/logo.png",
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
<h1>MCP Music Studio v0.2.1</h1>
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
