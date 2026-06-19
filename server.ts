import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import {
  createPlaySheetMusicResult,
  type ParseOnlyFn,
} from "./src/server-logic.js";
import {
  openPlayerInBrowser,
  generatePlayerHtml,
} from "./src/browser-fallback.js";
import {
  STRUDEL_GUIDE_TOPICS,
  STRUDEL_GUIDES,
  type StrudelGuideTopic,
} from "./src/strudel-guide.js";
import { ABC_GUIDE_TOPICS, ABC_GUIDES } from "./src/abc-guide.js";
import {
  generateStrudelPlayerHtml,
  openStrudelInBrowser,
} from "./src/strudel-browser-fallback.js";
import { VERSION } from "./src/version.js";
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
  PLAY_SHEET_FALLBACK_SUFFIX,
  playSheetInputSchema,
  PLAY_LIVE_BASE_DESCRIPTION,
  PLAY_LIVE_EXT_APPS_SUFFIX,
  PLAY_LIVE_FALLBACK_SUFFIX,
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
} from "./src/shared/tool-defs.js";

const DIST_DIR = import.meta.filename.endsWith(".ts")
  ? path.join(import.meta.dirname, "dist")
  : import.meta.dirname;

// =============================================================================
// Exported handlers (also used by the test suite)
// =============================================================================

export async function handlePlaySheetMusic(
  { abcNotation }: { abcNotation: string },
  parseOnly?: ParseOnlyFn,
): Promise<CallToolResult> {
  return createPlaySheetMusicResult(abcNotation, parseOnly);
}

export async function handleGetMusicGuide({
  topic,
}: {
  topic: (typeof ABC_GUIDE_TOPICS)[number];
}): Promise<CallToolResult> {
  return { content: [{ type: "text", text: ABC_GUIDES[topic] }] };
}

export async function handlePlayLivePattern(args: {
  code: string;
  title?: string;
}): Promise<CallToolResult> {
  return buildPlayLiveResult(args);
}

export async function handleGetStrudelGuide({
  topic,
}: {
  topic: StrudelGuideTopic;
}): Promise<CallToolResult> {
  return { content: [{ type: "text", text: STRUDEL_GUIDES[topic] }] };
}

export type RenderMode = "auto" | "html" | "browser";

export interface ServerOptions {
  defaultRenderMode?: RenderMode;
  outputDir?: string;
}

// =============================================================================
// Server
// =============================================================================

export function createServer(options?: ServerOptions): McpServer {
  const defaultRenderMode = options?.defaultRenderMode ?? "auto";
  const outputDir = options?.outputDir;

  const server = new McpServer(
    { name: "Music Studio", version: VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  // Advertise ext-apps UI support symmetrically with the remote worker so clients
  // (and registry validators) see the same capability set on both transports.
  advertiseUiExtension(server.server);

  // Slash-command prompts: compose-beat, harmonize-melody, arrange-tune.
  registerMusicPrompts(server);

  // Description is chosen once, deterministically, by the configured render mode.
  // In "auto" (default) the player renders inline for ext-apps clients; "html"/
  // "browser" are set explicitly for non-ext-apps clients. This replaces the old
  // oninitialized re-registration, which threw "already registered" (swallowed)
  // and could never fire before tools/list in stateless HTTP anyway.
  const inlineMode = defaultRenderMode === "auto";

  // ---------------------------------------------------------------------------
  // Tool: play-sheet-music
  // ---------------------------------------------------------------------------
  const playHandler = async (
    args: z.infer<typeof playSheetInputSchema>,
  ): Promise<CallToolResult> => {
    const result = await handlePlaySheetMusic(args);

    if (result.isError) return result;

    // Explicit --render-mode flag delivers HTML / opens a browser file.
    if (defaultRenderMode === "auto") return result;

    const playerOpts = {
      abcNotation: args.abcNotation,
      style: args.style,
      instrument: args.instrument,
      tempo: args.tempo,
      swing: args.swing,
      transpose: args.transpose,
    };

    if (defaultRenderMode === "html") {
      try {
        const html = generatePlayerHtml(playerOpts);
        const text =
          result.content[0]?.type === "text" ? result.content[0].text : "";
        result.content = [
          { type: "text", text },
          {
            type: "resource" as const,
            resource: {
              uri: `music://player/${randomUUID()}.html`,
              mimeType: "text/html",
              text: html,
            },
          },
        ];
      } catch (err) {
        result.content.push({
          type: "text",
          text: `\nFailed to generate HTML player: ${(err as Error).message}`,
        });
      }
    } else if (defaultRenderMode === "browser") {
      try {
        const filepath = await openPlayerInBrowser(playerOpts, outputDir);
        const fileUrl = `file://${filepath}`;
        const text =
          result.content[0]?.type === "text" ? result.content[0].text : "";
        result.content = [
          {
            type: "text",
            text: `${text}\n\nMusic player saved to: ${fileUrl}\n(Attempting to open it in your browser.)`,
          },
        ];
      } catch (err) {
        result.content.push({
          type: "text",
          text: `\nFailed to open browser: ${(err as Error).message}`,
        });
      }
    }

    return result;
  };

  registerAppTool(
    server,
    "play-sheet-music",
    {
      title: "Play Sheet Music",
      description:
        PLAY_SHEET_BASE_DESCRIPTION +
        (inlineMode ? PLAY_SHEET_EXT_APPS_SUFFIX : PLAY_SHEET_FALLBACK_SUFFIX),
      inputSchema: playSheetInputSchema,
      annotations: PLAY_TOOL_ANNOTATIONS,
      _meta: { ui: { resourceUri: SHEET_RESOURCE_URI } },
    },
    playHandler,
  );

  // ---------------------------------------------------------------------------
  // Tool: get-music-guide
  // ---------------------------------------------------------------------------
  server.registerTool(
    "get-music-guide",
    {
      title: "Music Reference Guide",
      description: GET_MUSIC_GUIDE_DESCRIPTION,
      inputSchema: z.object({
        topic: z
          .enum(ABC_GUIDE_TOPICS)
          .describe(GET_MUSIC_GUIDE_TOPIC_DESCRIPTION),
      }),
      annotations: GUIDE_TOOL_ANNOTATIONS,
    },
    handleGetMusicGuide,
  );

  // ---------------------------------------------------------------------------
  // Resources: music://guide/* (mirrors get-music-guide)
  // ---------------------------------------------------------------------------
  for (const topic of ABC_GUIDE_TOPICS) {
    const uri = `music://guide/${topic}`;
    server.registerResource(
      `Music Guide: ${topic}`,
      uri,
      { mimeType: "text/plain", description: `Music reference: ${topic}` },
      async (): Promise<ReadResourceResult> => ({
        contents: [{ uri, mimeType: "text/plain", text: ABC_GUIDES[topic] }],
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Resource: UI (bundled HTML/JS/CSS) — Sheet Music
  // ---------------------------------------------------------------------------
  registerAppResource(
    server,
    SHEET_RESOURCE_URI,
    SHEET_RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE, description: "Sheet Music Viewer UI" },
    async (): Promise<ReadResourceResult> => {
      const html = await fs.readFile(
        path.join(DIST_DIR, "mcp-app.html"),
        "utf-8",
      );
      return {
        contents: [
          {
            uri: SHEET_RESOURCE_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            _meta: { ui: { csp: { ...SHEET_CSP } } },
          },
        ],
      };
    },
  );

  // ===========================================================================
  // STRUDEL — Live Pattern Tool
  // ===========================================================================
  const strudelPlayHandler = async (
    args: z.infer<typeof playLiveInputSchema>,
  ): Promise<CallToolResult> => {
    const result = await handlePlayLivePattern(args);

    if (defaultRenderMode === "auto") return result;

    const playerOpts = {
      code: args.code,
      bpm: args.bpm,
      autoplay: args.autoplay,
    };

    if (defaultRenderMode === "html") {
      try {
        const html = generateStrudelPlayerHtml(playerOpts);
        const text =
          result.content[0]?.type === "text" ? result.content[0].text : "";
        result.content = [
          { type: "text", text },
          {
            type: "resource" as const,
            resource: {
              uri: `music://strudel/${randomUUID()}.html`,
              mimeType: "text/html",
              text: html,
            },
          },
        ];
      } catch (err) {
        result.content.push({
          type: "text",
          text: `\nFailed to generate Strudel HTML: ${(err as Error).message}`,
        });
      }
    } else if (defaultRenderMode === "browser") {
      try {
        const filepath = await openStrudelInBrowser(playerOpts, outputDir);
        const fileUrl = `file://${filepath}`;
        const text =
          result.content[0]?.type === "text" ? result.content[0].text : "";
        result.content = [
          {
            type: "text",
            text: `${text}\n\nStrudel player saved to: ${fileUrl}\n(Attempting to open it in your browser.)`,
          },
        ];
      } catch (err) {
        result.content.push({
          type: "text",
          text: `\nFailed to open browser: ${(err as Error).message}`,
        });
      }
    }

    return result;
  };

  registerAppTool(
    server,
    "play-live-pattern",
    {
      title: "Play Live Pattern",
      description:
        PLAY_LIVE_BASE_DESCRIPTION +
        (inlineMode ? PLAY_LIVE_EXT_APPS_SUFFIX : PLAY_LIVE_FALLBACK_SUFFIX),
      inputSchema: playLiveInputSchema,
      annotations: PLAY_TOOL_ANNOTATIONS,
      _meta: { ui: { resourceUri: STRUDEL_RESOURCE_URI } },
    },
    strudelPlayHandler,
  );

  // ---------------------------------------------------------------------------
  // Tool: get-strudel-guide
  // ---------------------------------------------------------------------------
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
    handleGetStrudelGuide,
  );

  // ---------------------------------------------------------------------------
  // Tool: search-music-docs (Context7-powered semantic search)
  // ---------------------------------------------------------------------------
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
        apiKey: process.env.CONTEXT7_API_KEY,
      }),
  );

  // ---------------------------------------------------------------------------
  // Resources: music://strudel-guide/* (mirrors get-strudel-guide)
  // ---------------------------------------------------------------------------
  for (const topic of STRUDEL_GUIDE_TOPICS) {
    const uri = `music://strudel-guide/${topic}`;
    server.registerResource(
      `Strudel Guide: ${topic}`,
      uri,
      { mimeType: "text/plain", description: `Strudel reference: ${topic}` },
      async (): Promise<ReadResourceResult> => ({
        contents: [{ uri, mimeType: "text/plain", text: STRUDEL_GUIDES[topic] }],
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Resource: UI (bundled HTML/JS/CSS) — Strudel REPL
  // ---------------------------------------------------------------------------
  registerAppResource(
    server,
    STRUDEL_RESOURCE_URI,
    STRUDEL_RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE, description: "Strudel Live Pattern REPL" },
    async (): Promise<ReadResourceResult> => {
      const html = await fs.readFile(
        path.join(DIST_DIR, "strudel-app.html"),
        "utf-8",
      );
      return {
        contents: [
          {
            uri: STRUDEL_RESOURCE_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            _meta: { ui: { csp: { ...STRUDEL_CSP } } },
          },
        ],
      };
    },
  );

  return server;
}
