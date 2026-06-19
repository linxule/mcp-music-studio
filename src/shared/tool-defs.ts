// =============================================================================
// Shared tool definitions — single source of truth for both transports
//
// Consumed by the local stdio/HTTP server (server.ts) and the Cloudflare Worker
// (worker/src/index.ts) so tool names, schemas, descriptions, annotations,
// _meta, instructions, and the search-docs behavior never drift between them.
//
// Dependency-light by design: no Node.js or ABCJS imports, so the Worker bundle
// can import it. Transport-specific wiring (render-mode branches, KV cache,
// fs/child_process) stays in each transport's own file.
// =============================================================================

import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { STYLE_NAMES } from "../music-logic.js";
import { DEFAULT_ABC_NOTATION } from "../abc-guide.js";

// -----------------------------------------------------------------------------
// Resource URIs
// -----------------------------------------------------------------------------

export const SHEET_RESOURCE_URI = "ui://sheet-music/mcp-app.html";
export const STRUDEL_RESOURCE_URI = "ui://strudel/strudel-app.html";

// -----------------------------------------------------------------------------
// Server-level guidance (flow hint for the model)
// -----------------------------------------------------------------------------

/**
 * Advertise ext-apps UI support on the low-level server, symmetrically across
 * both transports. The `extensions` capability isn't in every bundled SDK's
 * ServerCapabilities type, so the param is widened here to keep the call site
 * clean in both server.ts and the worker.
 */
export function advertiseUiExtension(rawServer: {
  registerCapabilities(capabilities: unknown): void;
}): void {
  rawServer.registerCapabilities({
    extensions: { "io.modelcontextprotocol/ui": {} },
  });
}

export const SERVER_INSTRUCTIONS =
  "Music Studio renders music in interactive widgets. Two creative modes: " +
  "play-sheet-music (write ABC notation → sheet music + multi-instrument audio) and " +
  "play-live-pattern (write Strudel/TidalCycles code → an editable live-coding REPL). " +
  "Before composing, consult the reference tools: get-music-guide (ABC — start with " +
  "topic 'genres' for templates, 'styles' for accompaniment presets, 'instruments' for the list) " +
  "or get-strudel-guide (Strudel — 'genres', 'sounds', 'effects'). Use search-music-docs only " +
  "when the curated guides don't cover something. For ABC accompaniment, include chord symbols " +
  '("C", "Am7") above the notes and set a style.';

// -----------------------------------------------------------------------------
// Tool annotations (MCP hints — all tools here are read-only, non-destructive)
// -----------------------------------------------------------------------------

export const PLAY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const GUIDE_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const SEARCH_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true, // hits an external API (context7.com)
} as const;

// -----------------------------------------------------------------------------
// CSP _meta for the UI resources
// -----------------------------------------------------------------------------

export const SHEET_CSP: { connectDomains: string[] } = {
  connectDomains: ["https://paulrosen.github.io"],
};

export const STRUDEL_CSP: { resourceDomains: string[]; connectDomains: string[] } = {
  resourceDomains: ["https://unpkg.com", "https://cdn.jsdelivr.net"],
  connectDomains: [
    "https://unpkg.com",
    "https://raw.githubusercontent.com",
    "https://cdn.jsdelivr.net",
    "https://felixroos.github.io",
    "https://tidalcycles.github.io",
  ],
};

// -----------------------------------------------------------------------------
// play-sheet-music
// -----------------------------------------------------------------------------

export const PLAY_SHEET_BASE_DESCRIPTION =
  "Compose and play sheet music with visual notation, multi-instrument audio, " +
  "and style presets. Write ABC notation for melodies, arrangements, harmonized " +
  "pieces, or well-known tunes. Add a style (rock, jazz, bossa, waltz, folk...) " +
  "for automatic drums, bass, and chord accompaniment. " +
  "Returns a parse-status confirmation and renders the player; it does not return raw audio. " +
  "Use get-music-guide for genre templates, instrument lists, and ABC syntax reference.";

export const PLAY_SHEET_EXT_APPS_SUFFIX =
  "\n\nThe music player renders inline with interactive playback controls.";

export const PLAY_SHEET_FALLBACK_SUFFIX =
  "\n\nThe music player is delivered as HTML or opened in the browser automatically.";

/**
 * Honest confirmation for transports that don't server-side validate ABC (the worker).
 * Deliberately does NOT assert that anything played — a terminal client sees only this
 * text (no widget), so claiming playback would mislead the agent.
 */
export const PLAY_SHEET_NEUTRAL_TEXT =
  "Sheet music ready. It renders as an interactive, playable score in MCP-app hosts " +
  "(e.g. Claude Desktop, claude.ai). If you don't see a player here, this client can't play it " +
  "inline, so nothing has played yet.";

export const playSheetInputSchema = z.object({
  abcNotation: z
    .string()
    .default(DEFAULT_ABC_NOTATION)
    .describe(
      'ABC notation string. Include chord symbols ("C", "Am7") above notes for auto-accompaniment with style presets.',
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
    .describe("Transpose by semitones (-12 to 12). Positive=higher, negative=lower."),
});

// -----------------------------------------------------------------------------
// play-live-pattern
// -----------------------------------------------------------------------------

export const PLAY_LIVE_BASE_DESCRIPTION =
  "Live-code music patterns using TidalCycles mini-notation in JavaScript. " +
  "Layer drums, synths, and bass with stack(). Choose from 72 drum machine banks, " +
  "128 GM instruments, built-in synths, and a full effects chain. " +
  "Patterns play in a REPL the user can edit directly. " +
  "Use get-strudel-guide for genre templates, sound references, and advanced features " +
  "like visualization, arrangement, and sample loading.";

export const PLAY_LIVE_EXT_APPS_SUFFIX =
  "\n\nThe Strudel REPL renders inline with an editable code editor, " +
  "visualizations, and playback controls.";

export const PLAY_LIVE_FALLBACK_SUFFIX =
  "\n\nThe Strudel REPL is delivered as HTML or opened in the browser.";

export const playLiveInputSchema = z.object({
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
    .describe(
      "Start playing immediately (default: true). May require user click due to browser autoplay policy.",
    ),
});

/**
 * Build the play-live-pattern tool result. Strudel code is evaluated client-side
 * in the REPL, so the server cannot confirm it runs — the wording is deliberately
 * non-asserting so the agent doesn't over-trust a silent failure.
 */
export function buildPlayLiveResult(args: { code: string; title?: string }): CallToolResult {
  const label = args.title ? `"${args.title}" — ` : "";
  return {
    content: [
      {
        type: "text",
        text:
          `${label}Strudel pattern ready. It plays in an editable REPL widget in MCP-app hosts ` +
          "(e.g. Claude Desktop, claude.ai). If you don't see a player here, this client can't play it " +
          "inline, so nothing has played yet.",
      },
    ],
  };
}

// -----------------------------------------------------------------------------
// get-music-guide / get-strudel-guide descriptions
// -----------------------------------------------------------------------------

export const GET_MUSIC_GUIDE_DESCRIPTION =
  "Returns detailed reference material for music composition. " +
  "Topics: instruments (GM instrument list + combos), drums (patterns + percussion notes), " +
  "abc-syntax (notation reference), arrangements (multi-voice patterns), " +
  "genres (complete ABC templates for jazz/blues/folk/rock/bossa/classical), " +
  "styles (what each style preset does), midi-directives (%%MIDI reference).";

export const GET_MUSIC_GUIDE_TOPIC_DESCRIPTION =
  "Reference topic. Start with 'genres' for complete examples, 'styles' to understand presets, or 'instruments' for the full instrument list.";

export const GET_STRUDEL_GUIDE_DESCRIPTION =
  "Reference material for Strudel live coding (performance mode). " +
  "Topics: mini-notation (pattern syntax), sounds (synths, 72 drum banks, 128 GM instruments), " +
  "effects (filters, reverb, delay, FM synthesis, envelopes), " +
  "patterns (transformations, probability, euclidean, arrangement), " +
  "genres (complete templates: techno/house/dnb/ambient/jazz/lofi/synthwave), " +
  "tips (tempo, common mistakes, ABC↔Strudel crossover), " +
  "advanced (visualization, sample loading, wavetables, ZZFX, continuous signals, chord voicings).";

export const GET_STRUDEL_GUIDE_TOPIC_DESCRIPTION =
  "Reference topic. Start with 'genres' for working templates, " +
  "'sounds' for instruments, 'advanced' for visualization and sample loading.";

// -----------------------------------------------------------------------------
// search-music-docs — shared core (cache + key are injected per transport)
// -----------------------------------------------------------------------------

export const SEARCH_DOCS_DESCRIPTION =
  "Search detailed documentation for Strudel live coding or ABC/ABCJS notation. " +
  "Returns relevant code examples and explanations from the official docs. " +
  "Use this when the curated guides (get-strudel-guide, get-music-guide) don't " +
  "cover what you need — for specific functions, advanced techniques, or when " +
  "you're unsure about syntax. Powered by semantic search over strudel.cc and ABCJS docs.";

export const searchDocsInputSchema = z.object({
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
});

export const CONTEXT7_LIBRARY_IDS: Record<"strudel" | "abcjs", string> = {
  strudel: "/websites/strudel_cc",
  abcjs: "/paulrosen/abcjs",
};

/** Max chars of upstream docs returned before truncation (avoids flooding context). */
export const SEARCH_DOCS_MAX_CHARS = 12000;

export interface SearchDocsDeps {
  /** Optional Context7 API key; used to retry once with Bearer auth on HTTP 429. */
  apiKey?: string;
  /** Optional cache read (e.g. Cloudflare KV). Returns cached text or null. */
  cacheGet?: (key: string) => Promise<string | null>;
  /** Optional cache write (e.g. Cloudflare KV, 24h TTL). */
  cachePut?: (key: string, value: string) => Promise<void>;
  /** Truncation cap; defaults to SEARCH_DOCS_MAX_CHARS. */
  maxChars?: number;
}

/**
 * Shared search-music-docs implementation. Behavior is identical across
 * transports; only the cache adapter and API key differ (injected via deps).
 * Never reflects the raw upstream error body (status only) to avoid relaying
 * upstream-controlled text into the model context.
 */
/** Max query length accepted — bounds KV-key cardinality and upstream cost. */
export const SEARCH_DOCS_MAX_QUERY = 500;

export async function searchMusicDocs(
  query: string,
  library: "strudel" | "abcjs",
  deps: SearchDocsDeps = {},
): Promise<CallToolResult> {
  const libraryId = CONTEXT7_LIBRARY_IDS[library] ?? CONTEXT7_LIBRARY_IDS.strudel;
  const maxChars = deps.maxChars ?? SEARCH_DOCS_MAX_CHARS;
  // Truncate by Unicode code points (not UTF-16 units) so an astral character
  // straddling the cap can't be split into a broken surrogate half.
  const codePoints = Array.from(query);
  const q =
    codePoints.length > SEARCH_DOCS_MAX_QUERY
      ? codePoints.slice(0, SEARCH_DOCS_MAX_QUERY).join("")
      : query;
  const cacheKey = `ctx7:${library}:${q}`;

  if (deps.cacheGet) {
    try {
      const cached = await deps.cacheGet(cacheKey);
      if (cached) return { content: [{ type: "text", text: cached }] };
    } catch {
      /* cache miss/unavailable — fall through to fetch */
    }
  }

  const params = new URLSearchParams({ libraryId, query: q, type: "txt" });
  const url = `https://context7.com/api/v2/context?${params}`;
  const apiKey = deps.apiKey ?? "";

  try {
    let res = await fetch(url);
    if (res.status === 429 && apiKey && apiKey.startsWith("ctx7sk")) {
      res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    }

    if (!res.ok) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Documentation search failed (${res.status}). Try the curated guides (get-strudel-guide, get-music-guide) instead.`,
          },
        ],
      };
    }

    const raw = await res.text();
    if (!raw || raw.trim().length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No results found for "${q}" in ${library} docs. Try rephrasing or use the curated guides.`,
          },
        ],
      };
    }

    let text = raw;
    if (text.length > maxChars) {
      text =
        text.slice(0, maxChars) +
        `\n\n…[results truncated at ${maxChars} chars — refine your query for more specific snippets]`;
    }

    if (deps.cachePut) {
      try {
        await deps.cachePut(cacheKey, text);
      } catch {
        /* cache write best-effort */
      }
    }

    return { content: [{ type: "text", text }] };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Documentation search error: ${(err as Error).message}. Use get-strudel-guide or get-music-guide as fallback.`,
        },
      ],
    };
  }
}

// -----------------------------------------------------------------------------
// Prompts — slash-command / menu entry points (user-controlled primitive)
//
// Shared by both transports. Handlers are pure message builders (no side
// effects), templated to scaffold the right tool-call flow for the model while
// giving humans a discoverable starting point.
// -----------------------------------------------------------------------------

type PromptResult = {
  messages: { role: "user"; content: { type: "text"; text: string } }[];
};

function userText(text: string): PromptResult {
  return { messages: [{ role: "user", content: { type: "text", text } }] };
}

interface PromptDef {
  name: string;
  config: {
    title: string;
    description: string;
    argsSchema: Record<string, z.ZodTypeAny>;
  };
  build: (args: Record<string, string | undefined>) => PromptResult;
}

export const MUSIC_PROMPTS: PromptDef[] = [
  {
    name: "compose-beat",
    config: {
      title: "Compose a beat",
      description:
        "Generate and play a Strudel live-coding pattern in a given genre.",
      argsSchema: {
        genre: z
          .string()
          .describe(
            "Genre, e.g. techno, house, dnb, lofi, ambient, synthwave, jazz",
          ),
        mood: z
          .string()
          .optional()
          .describe("Optional vibe, e.g. dark, dreamy, energetic, chill"),
      },
    },
    build: (args) =>
      userText(
        `Compose a ${args.mood ? `${args.mood} ` : ""}${args.genre ?? "lofi"} pattern and play it with the play-live-pattern tool. ` +
          `First call get-strudel-guide with topic "genres" for a working ${args.genre ?? "lofi"} template, then adapt it — ` +
          `use stack() to layer drums, bass, and melody, and set a fitting tempo with setcps().`,
      ),
  },
  {
    name: "harmonize-melody",
    config: {
      title: "Harmonize a melody",
      description:
        "Add chords/accompaniment to an ABC melody and play it as sheet music.",
      argsSchema: {
        melody: z.string().describe("ABC notation of the melody to harmonize"),
        style: z
          .string()
          .optional()
          .describe(
            "Optional accompaniment style: rock, jazz, bossa, waltz, march, reggae, folk, classical",
          ),
      },
    },
    build: (args) =>
      userText(
        `Harmonize this melody by adding chord symbols (e.g. "C", "Am7") above the notes` +
          `${args.style ? ` and applying the "${args.style}" accompaniment style` : ""}, ` +
          `then play it with the play-sheet-music tool. If unsure which chords fit, call get-music-guide with topic "genres" for examples.\n\n` +
          `Melody (ABC):\n\`\`\`\n${args.melody ?? "X:1\nK:C\nCDEF GABc|"}\n\`\`\``,
      ),
  },
  {
    name: "arrange-tune",
    config: {
      title: "Arrange a tune",
      description:
        "Turn a melody or musical idea into a fuller multi-voice arrangement and play it.",
      argsSchema: {
        tune: z
          .string()
          .describe(
            "ABC notation, or a text description of the tune/idea to arrange",
          ),
        instrumentation: z
          .string()
          .optional()
          .describe(
            "Optional desired instruments/voices, e.g. 'flute + cello + piano'",
          ),
      },
    },
    build: (args) =>
      userText(
        `Arrange this into a fuller multi-voice piece${args.instrumentation ? ` for ${args.instrumentation}` : ""} ` +
          `and play it with the play-sheet-music tool. Add complementary voices (bass line, inner harmony), include chord symbols, ` +
          `and consider an accompaniment style. Call get-music-guide with topic "arrangements" for multi-voice ABC patterns if needed.\n\n` +
          `Starting point:\n\`\`\`\n${args.tune ?? "(describe or paste a melody)"}\n\`\`\``,
      ),
  },
];

/**
 * Register the music prompts on a server. Method syntax (not an arrow property)
 * keeps the param bivariant so it accepts both transports' separately-bundled
 * McpServer types.
 */
export function registerMusicPrompts(server: {
  registerPrompt(name: string, config: unknown, cb: unknown): unknown;
}): void {
  for (const p of MUSIC_PROMPTS) {
    server.registerPrompt(
      p.name,
      p.config,
      (args: Record<string, string | undefined>) => p.build(args),
    );
  }
}
