import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
  getUiCapability,
} from "@modelcontextprotocol/ext-apps/server";
import { STYLE_NAMES } from "./src/music-logic.js";
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
import {
  ABC_GUIDE_TOPICS,
  ABC_GUIDES,
  DEFAULT_ABC_NOTATION,
} from "./src/abc-guide.js";
import {
  generateStrudelPlayerHtml,
  openStrudelInBrowser,
} from "./src/strudel-browser-fallback.js";

const DIST_DIR = import.meta.filename.endsWith(".ts")
  ? path.join(import.meta.dirname, "dist")
  : import.meta.dirname;

const GUIDE_TOPICS = ABC_GUIDE_TOPICS;
const GUIDES = ABC_GUIDES;

// =============================================================================
// Server
// =============================================================================

export async function handlePlaySheetMusic({
  abcNotation,
}: {
  abcNotation: string;
}, parseOnly?: ParseOnlyFn): Promise<CallToolResult> {
  return createPlaySheetMusicResult(abcNotation, parseOnly);
}

export async function handleGetMusicGuide({
  topic,
}: {
  topic: (typeof GUIDE_TOPICS)[number];
}): Promise<CallToolResult> {
  return {
    content: [{ type: "text", text: GUIDES[topic] }],
  };
}

export async function handlePlayLivePattern(args: {
  code: string;
  title?: string;
}): Promise<CallToolResult> {
  const label = args.title ? `"${args.title}" — ` : "";
  return {
    content: [
      {
        type: "text",
        text: `${label}Strudel pattern playing.`,
      },
    ],
  };
}

export async function handleGetStrudelGuide({
  topic,
}: {
  topic: StrudelGuideTopic;
}): Promise<CallToolResult> {
  return {
    content: [{ type: "text", text: STRUDEL_GUIDES[topic] }],
  };
}

export type RenderMode = "auto" | "html" | "browser";

export interface ServerOptions {
  defaultRenderMode?: RenderMode;
  outputDir?: string;
}

export function createServer(options?: ServerOptions): McpServer {
  const defaultRenderMode = options?.defaultRenderMode ?? "auto";
  const outputDir = options?.outputDir;
  let clientSupportsExtApps = false;

  const server = new McpServer({
    name: "Music Studio",
    version: "0.2.0",
  });

  const resourceUri = "ui://sheet-music/mcp-app.html";

  // ---------------------------------------------------------------------------
  // Shared schema + handler for play-sheet-music (description adapts to client)
  // ---------------------------------------------------------------------------
  const playInputSchema = z.object({
    abcNotation: z
      .string()
      .default(DEFAULT_ABC_NOTATION)
      .describe(
        "ABC notation string. Include chord symbols (\"C\", \"Am7\") above notes for auto-accompaniment with style presets.",
      ),
    title: z
      .string()
      .optional()
      .describe("Piece title (overrides T: in ABC). Displayed in the widget header."),
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
        "Your ABC needs chord symbols (\"C\", \"Am\") for accompaniment to work. " +
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
  });

  const BASE_DESCRIPTION =
    "Compose and play sheet music with visual notation, multi-instrument audio, " +
    "and style presets. Write ABC notation for melodies, arrangements, harmonized " +
    "pieces, or well-known tunes. Add a style (rock, jazz, bossa, waltz, folk...) " +
    "for automatic drums, bass, and chord accompaniment. " +
    "Use get-music-guide for genre templates, instrument lists, and ABC syntax reference.";

  const EXT_APPS_SUFFIX =
    "\n\nThe music player renders inline with interactive playback controls.";

  const FALLBACK_SUFFIX =
    "\n\nThe music player is delivered as HTML or opened in the browser automatically.";

  const playHandler = async (
    args: z.infer<typeof playInputSchema>,
  ): Promise<CallToolResult> => {
    const result = await handlePlaySheetMusic(args);

    if (result.isError) return result;

    // Explicit --render-mode flag always wins; auto-detect only affects description
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
              uri: `music://player/${Date.now()}.html`,
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
            text: `${text}\n\nMusic player saved and opening in browser.\nFile: ${fileUrl}`,
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

  // Register tool statically (works in HTTP stateless mode where each request
  // is a new server instance and oninitialized may not fire before tools/list).
  // Uses fallback description by default; upgraded to ext-apps in oninitialized.
  registerAppTool(
    server,
    "play-sheet-music",
    {
      title: "Play Sheet Music",
      description: BASE_DESCRIPTION + FALLBACK_SUFFIX,
      inputSchema: playInputSchema,
      _meta: { ui: { resourceUri } },
    },
    playHandler,
  );

  // Detect ext-apps capability and upgrade tool description for capable clients
  server.server.oninitialized = () => {
    const caps = server.server.getClientCapabilities();
    const uiCap = getUiCapability(caps);
    clientSupportsExtApps = !!uiCap?.mimeTypes?.includes(RESOURCE_MIME_TYPE);

    if (clientSupportsExtApps) {
      // Re-register with ext-apps-specific description
      registerAppTool(
        server,
        "play-sheet-music",
        {
          title: "Play Sheet Music",
          description: BASE_DESCRIPTION + EXT_APPS_SUFFIX,
          inputSchema: playInputSchema,
          _meta: { ui: { resourceUri } },
        },
        playHandler,
      );
    }
  };

  // ---------------------------------------------------------------------------
  // Tool: get-music-guide
  // ---------------------------------------------------------------------------
  server.registerTool(
    "get-music-guide",
    {
      title: "Music Reference Guide",
      description:
        "Returns detailed reference material for music composition. " +
        "Topics: instruments (GM instrument list + combos), drums (patterns + percussion notes), " +
        "abc-syntax (notation reference), arrangements (multi-voice patterns), " +
        "genres (complete ABC templates for jazz/blues/folk/rock/bossa/classical), " +
        "styles (what each style preset does), midi-directives (%%MIDI reference).",
      inputSchema: z.object({
        topic: z
          .enum(GUIDE_TOPICS)
          .describe(
            "Reference topic. Start with 'genres' for complete examples, 'styles' to understand presets, or 'instruments' for the full instrument list.",
          ),
      }),
    },
    handleGetMusicGuide,
  );

  // ---------------------------------------------------------------------------
  // Resources: music://guide/* (mirrors get-music-guide for resource-capable clients)
  // ---------------------------------------------------------------------------
  for (const topic of GUIDE_TOPICS) {
    const uri = `music://guide/${topic}`;
    server.registerResource(
      `Music Guide: ${topic}`,
      uri,
      { mimeType: "text/plain", description: `Music reference: ${topic}` },
      async (): Promise<ReadResourceResult> => ({
        contents: [{ uri, mimeType: "text/plain", text: GUIDES[topic] }],
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Resource: UI (bundled HTML/JS/CSS) — Sheet Music
  // ---------------------------------------------------------------------------
  registerAppResource(
    server,
    resourceUri,
    resourceUri,
    { mimeType: RESOURCE_MIME_TYPE, description: "Sheet Music Viewer UI" },
    async (): Promise<ReadResourceResult> => {
      const html = await fs.readFile(
        path.join(DIST_DIR, "mcp-app.html"),
        "utf-8",
      );

      return {
        contents: [
          {
            uri: resourceUri,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            _meta: {
              ui: {
                csp: {
                  connectDomains: ["https://paulrosen.github.io"],
                },
              },
            },
          },
        ],
      };
    },
  );

  // ===========================================================================
  // STRUDEL — Live Pattern Tool
  // ===========================================================================

  const strudelResourceUri = "ui://strudel/strudel-app.html";

  const strudelInputSchema = z.object({
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
      .describe("Pattern title displayed in the widget header (e.g. 'Midnight Rain')."),
    bpm: z
      .number()
      .min(40)
      .max(300)
      .optional()
      .describe("Tempo in BPM (40-300). Converts to setcps() automatically."),
    autoplay: z
      .boolean()
      .optional()
      .describe("Start playing immediately (default: true). May require user click due to browser autoplay policy."),
  });

  const STRUDEL_BASE_DESCRIPTION =
    "Live-code music patterns using TidalCycles mini-notation in JavaScript. " +
    "Layer drums, synths, and bass with stack(). Choose from 72 drum machine banks, " +
    "128 GM instruments, built-in synths, and a full effects chain. " +
    "Patterns play in a REPL the user can edit directly. " +
    "Use get-strudel-guide for genre templates, sound references, and advanced features " +
    "like visualization, arrangement, and sample loading.";

  const STRUDEL_EXT_APPS_SUFFIX =
    "\n\nThe Strudel REPL renders inline with an editable code editor, " +
    "visualizations, and playback controls.";

  const STRUDEL_FALLBACK_SUFFIX =
    "\n\nThe Strudel REPL is delivered as HTML or opened in the browser.";

  const strudelPlayHandler = async (
    args: z.infer<typeof strudelInputSchema>,
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
              uri: `music://strudel/${Date.now()}.html`,
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
            text: `${text}\n\nStrudel player saved and opening in browser.\nFile: ${fileUrl}`,
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

  // Register play-live-pattern with fallback description (upgraded in oninitialized)
  registerAppTool(
    server,
    "play-live-pattern",
    {
      title: "Play Live Pattern",
      description: STRUDEL_BASE_DESCRIPTION + STRUDEL_FALLBACK_SUFFIX,
      inputSchema: strudelInputSchema,
      _meta: { ui: { resourceUri: strudelResourceUri } },
    },
    strudelPlayHandler,
  );

  // Upgrade to ext-apps description if client supports it (in same oninitialized)
  const originalOnInitialized = server.server.oninitialized;
  server.server.oninitialized = () => {
    // Run the original oninitialized (which handles play-sheet-music upgrade)
    if (originalOnInitialized) originalOnInitialized.call(server.server);

    if (clientSupportsExtApps) {
      registerAppTool(
        server,
        "play-live-pattern",
        {
          title: "Play Live Pattern",
          description: STRUDEL_BASE_DESCRIPTION + STRUDEL_EXT_APPS_SUFFIX,
          inputSchema: strudelInputSchema,
          _meta: { ui: { resourceUri: strudelResourceUri } },
        },
        strudelPlayHandler,
      );
    }
  };

  // ---------------------------------------------------------------------------
  // Tool: get-strudel-guide
  // ---------------------------------------------------------------------------
  server.registerTool(
    "get-strudel-guide",
    {
      title: "Strudel Reference Guide",
      description:
        "Reference material for Strudel live coding (performance mode). " +
        "Topics: mini-notation (pattern syntax), sounds (synths, 72 drum banks, 128 GM instruments), " +
        "effects (filters, reverb, delay, FM synthesis, envelopes), " +
        "patterns (transformations, probability, euclidean, arrangement), " +
        "genres (complete templates: techno/house/dnb/ambient/jazz/lofi/synthwave), " +
        "tips (tempo, common mistakes, ABC↔Strudel crossover), " +
        "advanced (visualization, sample loading, wavetables, ZZFX, continuous signals, chord voicings).",
      inputSchema: z.object({
        topic: z
          .enum(STRUDEL_GUIDE_TOPICS)
          .describe(
            "Reference topic. Start with 'genres' for working templates, " +
            "'sounds' for instruments, 'advanced' for visualization and sample loading.",
          ),
      }),
    },
    handleGetStrudelGuide,
  );

  // ---------------------------------------------------------------------------
  // Tool: search-music-docs (Context7-powered semantic search)
  // ---------------------------------------------------------------------------
  const CONTEXT7_LIBRARY_IDS: Record<string, string> = {
    strudel: "/websites/strudel_cc",
    abcjs: "/paulrosen/abcjs",
  };

  server.registerTool(
    "search-music-docs",
    {
      title: "Search Music Documentation",
      description:
        "Search detailed documentation for Strudel live coding or ABC/ABCJS notation. " +
        "Returns relevant code examples and explanations from the official docs. " +
        "Use this when the curated guides (get-strudel-guide, get-music-guide) don't " +
        "cover what you need — for specific functions, advanced techniques, or when " +
        "you're unsure about syntax. Powered by semantic search over strudel.cc and ABCJS docs.",
      inputSchema: z.object({
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
      }),
    },
    async ({ query, library }) => {
      const libraryId = CONTEXT7_LIBRARY_IDS[library] ?? CONTEXT7_LIBRARY_IDS.strudel;
      const params = new URLSearchParams({ libraryId, query, type: "txt" });

      try {
        const res = await fetch(
          `https://context7.com/api/v2/context?${params}`,
        );

        if (!res.ok) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Documentation search failed (${res.status}). Try the curated guides instead.`,
              },
            ],
          };
        }

        const text = await res.text();
        if (!text || text.trim().length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No results for "${query}" in ${library} docs. Try rephrasing or use the curated guides.`,
              },
            ],
          };
        }

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Search error: ${(err as Error).message}. Use get-strudel-guide or get-music-guide as fallback.`,
            },
          ],
        };
      }
    },
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
    strudelResourceUri,
    strudelResourceUri,
    { mimeType: RESOURCE_MIME_TYPE, description: "Strudel Live Pattern REPL" },
    async (): Promise<ReadResourceResult> => {
      const html = await fs.readFile(
        path.join(DIST_DIR, "strudel-app.html"),
        "utf-8",
      );

      return {
        contents: [
          {
            uri: strudelResourceUri,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
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
      };
    },
  );

  return server;
}
