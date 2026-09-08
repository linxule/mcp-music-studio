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
import ABCJS from "abcjs";
import {
  createPlaySheetMusicResult,
  type ParseOnlyFn,
} from "./src/server-logic.js";
import type { ParseOnlyFn as AbcParseOnlyFn } from "./src/shared/abc-to-strudel.js";
import { generatePlayerHtml } from "./src/browser-fallback.js";
import {
  STRUDEL_GUIDE_TOPICS,
  STRUDEL_GUIDES,
  type StrudelGuideTopic,
} from "./src/strudel-guide.js";
import { ABC_GUIDE_TOPICS, ABC_GUIDES } from "./src/abc-guide.js";
import { generateStrudelPlayerHtml } from "./src/strudel-browser-fallback.js";
// The disk-writing/browser-launching half now lives in its own module so the
// two generators above stay node-free (the Worker imports them for /play, /score).
import {
  openPlayerInBrowser,
  openStrudelInBrowser,
} from "./src/open-in-browser.js";
import { VERSION } from "./src/version.js";
import {
  SHEET_RESOURCE_URI,
  STRUDEL_RESOURCE_URI,
  SERVER_INSTRUCTIONS,
  advertiseUiExtension,
  playToolAnnotations,
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
  ANALYZE_HARMONY_ANNOTATIONS,
  ANALYZE_HARMONY_DESCRIPTION,
  analyzeHarmonyInputSchema,
  buildAnalyzeHarmonyResult,
  CONVERT_ABC_ANNOTATIONS,
  CONVERT_ABC_DESCRIPTION,
  convertAbcInputSchema,
  buildConvertAbcResult,
  registerMusicPrompts,
  SERVER_ICONS,
  WEBSITE_URL,
  uiToolMeta,
  attachPlayLink,
} from "./src/shared/tool-defs.js";
import { buildShareQueryUrl, toPlayShareArgs } from "./src/shared/share-url.js";
import { validateStrudelCode } from "./src/shared/strudel-validate.js";

const DIST_DIR = import.meta.filename.endsWith(".ts")
  ? path.join(import.meta.dirname, "dist")
  : import.meta.dirname;

// =============================================================================
// Exported handlers (also used by the test suite)
// =============================================================================

export async function handlePlaySheetMusic(
  args: { abcNotation: string; instrument?: string },
  parseOnly?: ParseOnlyFn,
): Promise<CallToolResult> {
  // `instrument` rides along so the result text can say which GM program the
  // requested name actually resolved to (or that it didn't).
  return createPlaySheetMusicResult(args, parseOnly);
}

export async function handleGetMusicGuide({
  topic,
}: {
  topic: (typeof ABC_GUIDE_TOPICS)[number];
}): Promise<CallToolResult> {
  return { content: [{ type: "text", text: ABC_GUIDES[topic] }] };
}

/**
 * Evaluate the pattern before answering.
 *
 * The REPL widget is the feedback in an MCP-app host, but a terminal client
 * gets only this text — so run the code headlessly and say what it does.
 *
 * "Run the code" means running what an LLM wrote, so it does NOT run here: the
 * validator forks an env-stripped, heap-capped, SIGKILL-able child and
 * evaluates inside a node:vm context there (src/shared/strudel-validate.ts and
 * the threat model in src/shared/strudel-validate-host.ts). It never throws and
 * always answers, so neither a hostile nor a non-terminating pattern can fail
 * the tool call or wedge the server. `validate: false` opts out for callers
 * that only want the neutral receipt.
 */
export async function handlePlayLivePattern(
  args: { code: string; title?: string; visuals?: string; theme?: string },
  validate = true,
): Promise<CallToolResult> {
  const validation = validate ? await validateStrudelCode(args.code) : undefined;
  return buildPlayLiveResult(args, validation);
}

export async function handleAnalyzeHarmony(
  args: z.infer<typeof analyzeHarmonyInputSchema>,
): Promise<CallToolResult> {
  return buildAnalyzeHarmonyResult(args);
}

export async function handleConvertAbcToStrudel(
  args: z.infer<typeof convertAbcInputSchema>,
  parseOnly: AbcParseOnlyFn = ABCJS.parseOnly as unknown as AbcParseOnlyFn,
): Promise<CallToolResult> {
  return buildConvertAbcResult(args, parseOnly);
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
    {
      name: "Music Studio",
      version: VERSION,
      icons: SERVER_ICONS,
      websiteUrl: WEBSITE_URL,
    },
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

  // Hints follow the mode: only --render-mode browser writes a file and opens
  // an app, and only then is the tool not read-only. See playToolAnnotations.
  const playAnnotations = playToolAnnotations(defaultRenderMode);

  /**
   * Register a play tool, with its ext-apps widget only in "auto" mode.
   *
   * `--render-mode html|browser` exists precisely because the operator knows the
   * client can't render a widget. Advertising `_meta.ui.resourceUri` anyway let
   * a *capable* host render the inline widget **as well as** receiving the HTML
   * blob / opening a browser window — two players for one call. In the explicit
   * modes the tool is registered plainly, with no UI metadata at all, so there
   * is exactly one rendering path.
   */
  const registerPlayTool = (
    name: string,
    config: {
      title: string;
      description: string;
      inputSchema: z.ZodTypeAny;
      resourceUri: string;
    },
    handler: (args: never) => Promise<CallToolResult>,
  ) => {
    const base = {
      title: config.title,
      description: config.description,
      inputSchema: config.inputSchema,
      annotations: playAnnotations,
    };
    if (inlineMode) {
      registerAppTool(
        server,
        name,
        { ...base, _meta: uiToolMeta(config.resourceUri) },
        handler as never,
      );
    } else {
      server.registerTool(name, base as never, handler as never);
    }
  };

  // ---------------------------------------------------------------------------
  // Tool: play-sheet-music
  // ---------------------------------------------------------------------------
  const playHandler = async (
    args: z.infer<typeof playSheetInputSchema>,
  ): Promise<CallToolResult> => {
    const result = await handlePlaySheetMusic(args);

    if (result.isError) return result;

    // Explicit --render-mode flag delivers HTML / opens a browser file.
    if (defaultRenderMode === "auto") {
      // No KV here, so only the stateless query-string form is available; a
      // score too long for a URL simply gets no link (and the honest tail
      // stays honest). The page is served by the hosted worker, which is the
      // only origin a stdio server can offer.
      return attachPlayLink(
        result,
        buildShareQueryUrl({ kind: "score", args }),
      );
    }

    const playerOpts = {
      abcNotation: args.abcNotation,
      title: args.title,
      style: args.style,
      instrument: args.instrument,
      tempo: args.tempo,
      swing: args.swing,
      drumIntro: args.drumIntro,
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

  registerPlayTool(
    "play-sheet-music",
    {
      title: "Play Sheet Music",
      description:
        PLAY_SHEET_BASE_DESCRIPTION +
        (inlineMode ? PLAY_SHEET_EXT_APPS_SUFFIX : PLAY_SHEET_FALLBACK_SUFFIX),
      inputSchema: playSheetInputSchema,
      resourceUri: SHEET_RESOURCE_URI,
    },
    playHandler as never,
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

    if (defaultRenderMode === "auto") {
      // Broken Strudel still gets the link: it opens the same code in an
      // editable REPL, which is where a fix happens.
      // toPlayShareArgs folds the `visuals` preset into the code, so the linked
      // page shows the same animation the widget would.
      return attachPlayLink(
        result,
        buildShareQueryUrl({ kind: "play", args: toPlayShareArgs(args) }),
        { keepOnError: true },
      );
    }

    // The standalone page gets the SAME reduction the share link gets, so all
    // three paths (widget, share URL, fallback page) agree on what was asked
    // for: `visuals` is folded into the code by applyVisualPreset and `bpm` is
    // clamped to the tool's range. `theme` is dropped here as it is everywhere
    // else — it colours the widget's CodeMirror chrome, and the standalone page
    // renders its own, with no theme switch to hand it to.
    const shareArgs = toPlayShareArgs(args);
    const playerOpts = {
      code: shareArgs.code,
      bpm: shareArgs.bpm,
      autoplay: shareArgs.autoplay,
      // The generator gained an optional `title`; spread so this compiles
      // whether or not that option is present in the signature yet.
      ...(shareArgs.title ? { title: shareArgs.title } : {}),
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

  registerPlayTool(
    "play-live-pattern",
    {
      title: "Play Live Pattern",
      description:
        PLAY_LIVE_BASE_DESCRIPTION +
        (inlineMode ? PLAY_LIVE_EXT_APPS_SUFFIX : PLAY_LIVE_FALLBACK_SUFFIX),
      inputSchema: playLiveInputSchema,
      resourceUri: STRUDEL_RESOURCE_URI,
    },
    strudelPlayHandler as never,
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
  // Tool: analyze-harmony (pure music theory, no UI)
  // ---------------------------------------------------------------------------
  server.registerTool(
    "analyze-harmony",
    {
      title: "Analyze Harmony",
      description: ANALYZE_HARMONY_DESCRIPTION,
      inputSchema: analyzeHarmonyInputSchema,
      annotations: ANALYZE_HARMONY_ANNOTATIONS,
    },
    handleAnalyzeHarmony,
  );

  // ---------------------------------------------------------------------------
  // Tool: convert-abc-to-strudel (scored composition → live pattern)
  // ---------------------------------------------------------------------------
  server.registerTool(
    "convert-abc-to-strudel",
    {
      title: "Convert ABC to Strudel",
      description: CONVERT_ABC_DESCRIPTION,
      inputSchema: convertAbcInputSchema,
      annotations: CONVERT_ABC_ANNOTATIONS,
    },
    async (args) => handleConvertAbcToStrudel(args),
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
