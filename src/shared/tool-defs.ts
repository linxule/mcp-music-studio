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
import { analyzeHarmony, HARMONY_TASKS } from "./harmony.js";
import {
  convertAbcToStrudel,
  DEFAULT_STRUDEL_SOUND,
  type AbcToStrudelArgs,
  type ParseOnlyFn,
} from "./abc-to-strudel.js";
import { EDITOR_THEMES, VISUAL_PRESETS } from "./visual-presets.js";
// Type-only: the validator itself (and the ~200 KiB of Strudel behind it) is
// imported by each transport's handler, not by this module.
import type { StrudelValidation } from "./strudel-validate.js";

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
  '("C", "Am7") above the notes and set a style. ' +
  "If unsure about chord spelling or the key, call analyze-harmony; " +
  "convert-abc-to-strudel turns a scored melody into a live pattern.";

// -----------------------------------------------------------------------------
// Server identity — icon + website (emitted verbatim in serverInfo by both
// transports). The `icons` field entered the MCP spec in 2025-11-25; SDK 1.27.1
// carries it through the initialize response. Spec-current clients (e.g. MCP
// Inspector) render it; older-protocol clients ignore it harmlessly. Points at a
// 256px square variant — not the 1MB master — so the connect handshake stays light.
// -----------------------------------------------------------------------------

export const WEBSITE_URL = "https://mcp-music-studio.linxule.workers.dev";

/** Canonical square icon, served from the repo via GitHub raw (direct bytes). */
export const LOGO_URL =
  "https://raw.githubusercontent.com/linxule/mcp-music-studio/main/assets/icons/logo-256.png";

/**
 * serverInfo.icons for the LOCAL (stdio) server. Plain (non-`as const`) array so
 * it stays assignable to the SDK's mutable `Icon[]`, and structurally typed so it
 * satisfies either transport's separately-bundled McpServer.
 */
export const SERVER_ICONS = [
  { src: LOGO_URL, mimeType: "image/png", sizes: ["256x256"] },
];

/**
 * serverInfo.icons for the WORKER (remote). Uses the worker's own /icon.png
 * (same-origin as /mcp, direct bytes — no 301) so clients that restrict icon URLs
 * to the server's domain accept it.
 */
export const WORKER_SERVER_ICONS = [
  { src: `${WEBSITE_URL}/icon.png`, mimeType: "image/png", sizes: ["256x256"] },
];

// -----------------------------------------------------------------------------
// Tool annotations (MCP hints — all tools here are read-only, non-destructive)
// -----------------------------------------------------------------------------

/**
 * The play tools mutate no server state, but they are NOT idempotent: each call
 * instantiates a widget and starts audio, so repeating one with the same
 * arguments has an additional effect on the world. `idempotentHint: true` would
 * invite a client to coalesce or silently retry a call the user can hear.
 */
export const PLAY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

/**
 * Play-tool annotations for a given local render mode.
 *
 * `readOnlyHint` was hard-coded `true`, which is a lie in `--render-mode
 * browser`: that mode writes an HTML file under `--output-dir` and shells out to
 * the OS to open it. A client reading the hint may decide the call is safe to
 * make without asking — so the hint has to follow the mode.
 *
 * `html` and `auto` stay read-only on purpose: `html` returns the player as an
 * inline resource block (a pure string build, nothing touched), and `auto`
 * returns text plus a link. Neither writes anything, so marking them
 * non-read-only would just be a different inaccuracy.
 */
export function playToolAnnotations(renderMode: "auto" | "html" | "browser") {
  if (renderMode !== "browser") return PLAY_TOOL_ANNOTATIONS;
  return {
    // Writes a file to disk...
    readOnlyHint: false,
    // ...but only ever a new player page; it destroys nothing.
    destructiveHint: false,
    idempotentHint: false,
    // ...and launches the user's browser, which is squarely "the open world".
    openWorldHint: true,
  } as const;
}

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
    // samples('shabda:...') resolves through shabda.ndre.gr, which then serves
    // the audio from cdn.freesound.org. Both are needed or the fetch fails and
    // the sound is never registered (silent layer, no error).
    "https://shabda.ndre.gr",
    "https://cdn.freesound.org",
  ],
};

// -----------------------------------------------------------------------------
// UI tool _meta — single source for both transports
// -----------------------------------------------------------------------------

/**
 * `_meta` linking a tool to its ext-apps UI resource.
 *
 * Both spellings are emitted: the nested `ui.resourceUri` of the current spec
 * and the flat legacy `"ui/resourceUri"` some hosts still read. `registerAppTool`
 * from @modelcontextprotocol/ext-apps back-fills whichever is missing, but the
 * Worker calls `registerTool` directly (the ext-apps helper isn't in its bundle),
 * so the pair used to be hand-written in two places and could silently drift.
 * tests/transport-parity.test.ts pins the two transports together.
 */
export function uiToolMeta(resourceUri: string): {
  ui: { resourceUri: string };
  "ui/resourceUri": string;
} {
  return {
    ui: { resourceUri },
    "ui/resourceUri": resourceUri,
  };
}

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

// -----------------------------------------------------------------------------
// The honest tail — and the click-to-play link that can now replace it
// -----------------------------------------------------------------------------
//
// Neither transport can tell whether the caller renders ext-apps widgets (the
// SDK strips inbound capabilities.extensions, and the stateless worker never
// replays `initialize`), so both play tools end on a sentence that refuses to
// claim playback. When a hosted player URL is available that sentence changes
// from a dead end into an instruction — see `attachPlayLink`.

export const NO_INLINE_PLAYER_TAIL =
  "If you don't see a player here, this client can't play it inline, so nothing has played yet.";

export const NO_INLINE_PLAYER_TAIL_WITH_LINK =
  "If you don't see a player here, this client can't play it inline — click the link below to play it in your browser.";

/** Prefix of the line carrying the hosted player URL. */
export const PLAY_LINK_PREFIX = "\u25b6 Play in browser: ";

/** `name` of the resource_link block, so clients render a sensible label. */
export const PLAY_LINK_NAME = "Play in browser";

/**
 * Honest confirmation for transports that don't server-side validate ABC (the worker).
 * Deliberately does NOT assert that anything played — a terminal client sees only this
 * text (no widget), so claiming playback would mislead the agent.
 */
export const PLAY_SHEET_NEUTRAL_TEXT =
  "Sheet music ready. It renders as an interactive, playable score in MCP-app hosts " +
  `(e.g. Claude Desktop, claude.ai). ${NO_INLINE_PLAYER_TAIL}`;

/**
 * Add the "Tier 3" click-to-play link to a play-tool result.
 *
 * Two content blocks, because clients disagree about what they render: the URL
 * goes into the text (terminals show text and nothing else) *and* as a
 * `resource_link`, which Claude Code and other structured clients turn into an
 * actual link. The honest tail is swapped for its click-the-link variant at the
 * same time, so the result never simultaneously offers a player and says
 * nothing has played.
 *
 * A no-op when there is no URL (nothing fit, or the transport has no host) or
 * when the result is an error — a link to a page that renders broken notation
 * helps nobody.
 *
 * `keepOnError` is the one exception, and it exists for play-live-pattern:
 * broken ABC renders as a broken score, but broken Strudel lands in an EDITABLE
 * REPL, so the link is where the user goes to fix it.
 */
export function attachPlayLink(
  result: CallToolResult,
  // `null` is what buildShareQueryUrl returns for a payload too long to fit in
  // a URL; `undefined` is "this transport had nowhere to host it".
  url: string | null | undefined,
  { keepOnError = false }: { keepOnError?: boolean } = {},
): CallToolResult {
  if (!url || (result.isError && !keepOnError)) return result;

  let linked = false;
  const content = result.content.map((block) => {
    // The tail is not always final — the local server appends a --render-mode
    // hint after it — so swap it in place and put the link at the very end.
    if (linked || block.type !== "text" || !block.text.includes(NO_INLINE_PLAYER_TAIL)) {
      return block;
    }
    linked = true;
    const swapped = block.text.replace(
      NO_INLINE_PLAYER_TAIL,
      NO_INLINE_PLAYER_TAIL_WITH_LINK,
    );
    return { ...block, text: `${swapped}\n\n${PLAY_LINK_PREFIX}${url}` };
  });

  return {
    ...result,
    content: [
      ...content,
      {
        type: "resource_link" as const,
        uri: url,
        name: PLAY_LINK_NAME,
        mimeType: "text/html",
      },
    ],
  };
}

// -----------------------------------------------------------------------------
// Input bounds
//
// Every free-form field below is bounded. Unbounded strings/arrays are the
// cheapest way to make a server do unbounded work: a multi-megabyte `code` or
// `abcNotation` is parsed, hashed, URL-encoded for the share link, and (on the
// worker) written to KV. These caps are far above any real piece of music.
// -----------------------------------------------------------------------------

/** Max length of a score or pattern, in characters. */
export const MAX_SOURCE_CHARS = 64 * 1024;

/** Max entries in a note/chord list for analyze-harmony. */
export const MAX_HARMONY_ITEMS = 64;

export const playSheetInputSchema = z.object({
  abcNotation: z
    .string()
    .max(MAX_SOURCE_CHARS)
    .default(DEFAULT_ABC_NOTATION)
    .describe(
      'ABC notation string. Include chord symbols ("C", "Am7") above notes for auto-accompaniment with style presets.',
    ),
  title: z
    .string()
    .optional()
    .describe(
      "Piece title (overrides T: in ABC). Shown in the widget header and used as " +
        "the filename stem for the WAV/MIDI downloads.",
    ),
  instrument: z
    .string()
    .optional()
    .describe(
      "Default instrument for the main voice — any of the 128 General MIDI names " +
        "(e.g. 'Flute', 'Cello', 'Banjo', 'Alto Sax'). Matching is fuzzy and picks the " +
        "lowest GM program among the hits, so 'sax' gives Soprano Sax; the result text " +
        "names what you actually got whenever it isn't what you asked for. " +
        "Use get-music-guide with topic 'instruments' for the full list, or %%MIDI program N " +
        "in the ABC to set a program per voice.",
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
    .max(75)
    .optional()
    .describe(
      "Swing as the share of the beat given to its first half. " +
        "50 = straight, 60 \u2248 3:2, 66 = triplet swing, 75 = maximum " +
        "(dotted eighth + sixteenth). Anything at or below 50 is treated as no swing. " +
        "Only takes effect in an x/4 or x/8 meter.",
    ),
  drumIntro: z
    .number()
    .int()
    .min(0)
    .max(8)
    .optional()
    .describe(
      "Bars of count-in before the melody starts (0-8). " +
        "Needs a style preset \u2014 the count-in is played by that style's drum kit, " +
        "so without a style you get silent bars instead.",
    ),
  transpose: z
    .number()
    .int()
    .min(-12)
    .max(12)
    .optional()
    .describe(
      "Transpose by semitones (-12 to 12). Positive=higher, negative=lower. " +
        "Rewrites the notation and the key signature, so the printed score matches what plays.",
    ),
});

// -----------------------------------------------------------------------------
// play-live-pattern
// -----------------------------------------------------------------------------

export const PLAY_LIVE_BASE_DESCRIPTION =
  "Live-code music patterns using TidalCycles mini-notation in JavaScript. " +
  "Layer drums, synths, and bass with stack(). Choose from 71 drum machine banks, " +
  "128 GM instruments, built-in synths, and a full effects chain. " +
  "Patterns play in a REPL the user can edit directly. " +
  "Add .pianoroll() to a pattern to show a live piano-roll animation in the widget " +
  "(or .punchcard()/.scope()/.spectrum() — one draw method per pattern). " +
  "For a custom animated background, start the code with `await initHydra()` and write " +
  "Hydra shader code — H(pattern) locks it to the sequence, and `() => a.fft[0]` makes it " +
  "react to the audio itself (Strudel's output, not the mic); see get-strudel-guide topic 'visuals'. " +
  "Rather not hand-write one? `visuals` picks a ready-made animation for code that has none " +
  "(pianoroll/punchcard/scope/spectrum, or hydra-kaleid/pulse/wash/feed). " +
  "`theme` sets the code-editor colour scheme, which also tints the visuals — match it to the mood " +
  "(teletext chiptune, sonicPink synthwave, nord ambient, gruvboxDark lofi). " +
  "Use get-strudel-guide for genre templates, sound references, and advanced features " +
  "like arrangement and sample loading.";

export const PLAY_LIVE_EXT_APPS_SUFFIX =
  "\n\nThe Strudel REPL renders inline with an editable code editor, " +
  "visualizations, and playback controls.";

export const PLAY_LIVE_FALLBACK_SUFFIX =
  "\n\nThe Strudel REPL is delivered as HTML or opened in the browser.";

export const playLiveInputSchema = z.object({
  code: z
    .string()
    .max(MAX_SOURCE_CHARS)
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
  visuals: z
    .enum(VISUAL_PRESETS)
    .optional()
    .describe(
      "Ready-made visual, for when the code has none of its own. " +
        "pianoroll/punchcard/scope/spectrum draw onto the 2D canvas behind the code; " +
        "hydra-kaleid (rotating kaleidoscope), hydra-pulse (shape driven by a rhythm), " +
        "hydra-wash (slow ambient noise) and hydra-feed (the piano roll mirrored and trailed) " +
        "are WebGL shader backgrounds. Ignored if the code already visualises itself — " +
        "writing your own .pianoroll() or initHydra() shader is still the better result " +
        "(see get-strudel-guide topic 'visuals').",
    ),
  theme: z
    .enum(EDITOR_THEMES)
    .optional()
    .describe("Editor colour theme — pick to match the mood (e.g. 'nord', 'sonicPink', 'githubLight')."),
});

/**
 * Why the remote transport returns an unchecked receipt.
 *
 * Not a bundle-size decision: the @strudel packages fit the Worker fine
 * (+215 KiB gzip, measured). Strudel's evaluate() transpiles a pattern and runs
 * it through `new Function`, and workerd rejects that outright — "EvalError:
 * Code generation from strings disallowed for this context" — with no flag to
 * lift it. So the remote server says what it cannot do, and points at the one
 * that can.
 */
export const PLAY_LIVE_UNVALIDATED_REMOTE =
  "Not verified: this remote server can't run Strudel to check it — Cloudflare " +
  "Workers disallow the dynamic code generation its evaluator needs. The local npm " +
  "server (npx mcp-music-studio) reports parse errors, sounds and event counts.";

/** Where the pattern actually plays — the one sentence every branch ends on. */
const PLAY_LIVE_PLAYBACK_TAIL =
  "It plays in an editable REPL widget in MCP-app hosts " +
  `(e.g. Claude Desktop, claude.ai). ${NO_INLINE_PLAYER_TAIL}`;

/** Trim float noise off a cps computed as e.g. 120/60/4. */
const showCps = (cps: number) => String(Math.round(cps * 1000) / 1000);

/** The "parses OK: ..." clause — what the server can actually vouch for. */
function summariseValidation(v: StrudelValidation): string {
  const parts: string[] = [];
  if (v.layers) parts.push(`${v.layers} layers`);
  if (v.eventsPerCycle !== undefined) parts.push(`${v.eventsPerCycle} events/cycle`);
  if (v.cps !== undefined) parts.push(`cps ${showCps(v.cps)}`);
  if (v.sounds?.length) {
    // A samples() call registers names this server cannot see, so "unknown"
    // there means unverifiable, not wrong — say so rather than crying wolf.
    const qualifier = v.sampleUrls?.length
      ? " (custom samples loaded — names not checked)"
      : v.unregistered?.length
        ? ""
        : " (all registered)";
    parts.push(`sounds: ${v.sounds.join(" ")}${qualifier}`);
  } else if (v.usesNotes) {
    parts.push("notes with no sound named (plays on the default triangle synth)");
  }
  if (v.usesHydra) parts.push("Hydra background: yes");
  if (v.visuals?.length) parts.push(`visuals: ${v.visuals.join(", ")}`);
  return parts.join(", ");
}

/** Lines that qualify an otherwise-OK result. */
function validationWarnings(v: StrudelValidation): string[] {
  const warnings: string[] = [];
  if (v.eventsPerCycle === 0) {
    warnings.push(
      "This pattern produces no events over the cycles queried — it evaluates, " +
        "but nothing will be heard.",
    );
  }
  if (v.unregistered?.length) {
    warnings.push(
      `Sounds not in the default banks: ${v.unregistered.join(", ")} — they will be ` +
        "silent unless samples() loads them.",
    );
  }
  return warnings;
}

/**
 * Build the play-live-pattern tool result.
 *
 * With no `validation` the wording is deliberately non-asserting: the REPL
 * evaluates the code client-side, so a server that has not run it cannot claim
 * it works. Pass a `validation` (see src/shared/strudel-validate.ts) and the
 * result can say what the pattern actually does — which for a text-only client
 * is the only feedback there is.
 */
export function buildPlayLiveResult(
  args: { code: string; title?: string },
  validation?: StrudelValidation,
  /**
   * Why no validation ran, when a transport cannot run one at all. A complete
   * sentence or two; rendered on its own line, like a validation warning.
   */
  unvalidatedNote?: string,
): CallToolResult {
  const label = args.title ? `"${args.title}" — ` : "";

  if (!validation) {
    const text = unvalidatedNote
      ? [`${label}Strudel pattern ready.`, unvalidatedNote, PLAY_LIVE_PLAYBACK_TAIL].join(
          "\n",
        )
      : `${label}Strudel pattern ready. ${PLAY_LIVE_PLAYBACK_TAIL}`;
    return { content: [{ type: "text", text }] };
  }

  if (!validation.ok) {
    const { message = "unknown error", line, column } = validation.error ?? {};
    // Acorn puts the position on the error object; V8 puts it in the message.
    // Append it only when it isn't already there.
    const at =
      line !== undefined && !/\(\d+:\d+\)\s*$/.test(message)
        ? ` (${line}:${column ?? 0})`
        : "";
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            `${label}Strudel pattern failed to evaluate: ${message}${at}. ` +
            `Nothing will play until it is fixed — the code is loaded in the REPL, ` +
            `where you can edit and re-run it. ${NO_INLINE_PLAYER_TAIL}`,
        },
      ],
    };
  }

  const summary = summariseValidation(validation);
  const head = summary
    ? `${label}Strudel pattern ready — parses OK: ${summary}.`
    : `${label}Strudel pattern ready — parses OK.`;

  return {
    content: [
      {
        type: "text",
        text: [head, ...validationWarnings(validation), PLAY_LIVE_PLAYBACK_TAIL].join(
          "\n",
        ),
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
  "Topics: mini-notation (pattern syntax), " +
  "sounds (synths, 71 drum banks, 128 GM instruments, 128 vcsl orchestral/percussion samples), " +
  "effects (filters, reverb, delay, FM synthesis, envelopes), " +
  "patterns (transformations, probability, euclidean, arrangement), " +
  "genres (complete templates: techno/house/dnb/ambient/jazz/lofi/synthwave), " +
  "tips (tempo, common mistakes, ABC↔Strudel crossover), " +
  "visuals (pianoroll/scope draw methods, Hydra shader backgrounds, audio-reactive shaders, "
  + "plus the visuals/theme parameters), " +
  "advanced (sample loading, wavetables, ZZFX, continuous signals, chord voicings).";

export const GET_STRUDEL_GUIDE_TOPIC_DESCRIPTION =
  "Reference topic. Start with 'genres' for working templates, " +
  "'sounds' for instruments, 'visuals' for animations and Hydra backgrounds, " +
  "'advanced' for sample loading.";

// -----------------------------------------------------------------------------
// search-music-docs — shared core (cache + key are injected per transport)
// -----------------------------------------------------------------------------

export const SEARCH_DOCS_DESCRIPTION =
  "Search detailed documentation for Strudel live coding or ABC/ABCJS notation. " +
  "Returns relevant code examples and explanations from the official docs. " +
  "Use this when the curated guides (get-strudel-guide, get-music-guide) don't " +
  "cover what you need — for specific functions, advanced techniques, or when " +
  "you're unsure about syntax. Powered by semantic search over strudel.cc and ABCJS docs.";

/** Max query length accepted (code points) — bounds KV-key cardinality and upstream cost. */
export const SEARCH_DOCS_MAX_QUERY = 500;

/**
 * Hard cap on how much of the upstream response body is read, in bytes.
 *
 * `res.text()` buffers whatever context7.com sends before the result is
 * truncated to SEARCH_DOCS_MAX_CHARS — an upstream that answers with 200 MB
 * would be faithfully held in memory first (and on the Worker, that is the
 * isolate's memory). The reader stops here instead; the payload is truncated
 * for the model anyway.
 */
export const SEARCH_DOCS_MAX_BODY_BYTES = 256 * 1024;

/** How long to wait on context7.com before giving up. */
export const SEARCH_DOCS_TIMEOUT_MS = 15_000;

export const searchDocsInputSchema = z.object({
  query: z
    .string()
    .max(SEARCH_DOCS_MAX_QUERY)
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
 * Cache key for a (library, query) pair.
 *
 * Workers KV caps keys at 512 BYTES, but the query is capped at 500 CODE POINTS.
 * A 500-character CJK or emoji query is 1500-2000 UTF-8 bytes, so the literal
 * key `ctx7:<library>:<query>` overflowed the limit and every KV read/write
 * threw — silently disabling the cache for exactly the queries most likely to
 * repeat. Hashing gives a fixed 77-byte ASCII key regardless of the input.
 */
export async function buildSearchCacheKey(
  library: string,
  query: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(query),
  );
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `ctx7:${library}:${hex}`;
}

/**
 * Truncate to `maxCodePoints` Unicode code points.
 *
 * Code points, not UTF-16 units, so an astral character straddling the cap
 * can't be split into a broken surrogate half. Walked with an index rather than
 * `Array.from(query)`, which materialised an array of every code point in the
 * input *before* applying the cap — the one allocation the cap exists to avoid.
 */
export function truncateCodePoints(
  value: string,
  maxCodePoints: number,
): string {
  let count = 0;
  for (let i = 0; i < value.length; ) {
    if (count === maxCodePoints) return value.slice(0, i);
    // A surrogate pair is one code point but two UTF-16 units.
    i += value.codePointAt(i)! > 0xffff ? 2 : 1;
    count++;
  }
  return value;
}

/**
 * Read at most `maxBytes` of a response body, then hang up.
 *
 * Falls back to `.text()` only when the runtime gave us no stream to read
 * (some fetch mocks), where the body is already in memory anyway.
 */
async function readCappedText(
  res: Response,
  maxBytes: number,
): Promise<string> {
  const body = res.body;
  if (!body?.getReader) return (await res.text()).slice(0, maxBytes);

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const room = maxBytes - total;
      const chunk = value.byteLength > room ? value.subarray(0, room) : value;
      total += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
  } finally {
    // Signals the upstream we're done; the remaining bytes are never buffered.
    await reader.cancel().catch(() => {});
  }
  return text;
}

export async function searchMusicDocs(
  query: string,
  library: "strudel" | "abcjs",
  deps: SearchDocsDeps = {},
): Promise<CallToolResult> {
  const libraryId = CONTEXT7_LIBRARY_IDS[library] ?? CONTEXT7_LIBRARY_IDS.strudel;
  const maxChars = deps.maxChars ?? SEARCH_DOCS_MAX_CHARS;
  const q = truncateCodePoints(query, SEARCH_DOCS_MAX_QUERY);
  const cacheKey = await buildSearchCacheKey(library, q);

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
    // Without a deadline a hung upstream pins the tool call open indefinitely
    // (and, on the Worker, holds the request alive until the platform kills it).
    let res = await fetch(url, {
      signal: AbortSignal.timeout(SEARCH_DOCS_TIMEOUT_MS),
    });
    if (res.status === 429 && apiKey && apiKey.startsWith("ctx7sk")) {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(SEARCH_DOCS_TIMEOUT_MS),
      });
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

    const raw = await readCappedText(res, SEARCH_DOCS_MAX_BODY_BYTES);
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
// analyze-harmony — music theory helper (no UI, pure computation)
// -----------------------------------------------------------------------------

export const ANALYZE_HARMONY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const ANALYZE_HARMONY_DESCRIPTION =
  "Music theory helper: name a chord from notes, guess the key, get a progression, " +
  "or list what fits a key. Returns both the ABC chord-symbol spelling (for play-sheet-music) " +
  "and the Strudel form (for play-live-pattern). " +
  "Tasks: detect-chord (notes -> chord name + what to play next), " +
  "detect-key (notes or chords -> best key + diatonic chords), " +
  "suggest-progression (key [+ romanNumerals] -> chord symbols), " +
  "scale-for-chord (chords -> the scale to improvise over each), " +
  "key-chords (key -> every diatonic triad, seventh, and chord scale). " +
  "Use it before writing chord symbols for a style preset, or to check a harmonization.";

export const analyzeHarmonyInputSchema = z.object({
  task: z
    .enum(HARMONY_TASKS)
    .describe(
      "What to work out. detect-chord/detect-key need notes or chords; " +
        "suggest-progression/key-chords need a key.",
    ),
  notes: z
    .array(z.string())
    .max(MAX_HARMONY_ITEMS)
    .optional()
    .describe('Note names, e.g. ["c4","e4","g4","b4"] or ["C","Eb","G"]. For detect-chord/detect-key.'),
  chords: z
    .array(z.string())
    .max(MAX_HARMONY_ITEMS)
    .optional()
    .describe('Chord symbols, e.g. ["Dm7","G7","Cmaj7"]. For detect-key/scale-for-chord.'),
  key: z
    .string()
    .optional()
    .describe('Key, e.g. "C", "A minor", "F# major". For suggest-progression/key-chords.'),
  romanNumerals: z
    .array(z.string())
    .max(MAX_HARMONY_ITEMS)
    .optional()
    .describe(
      'Roman numerals to render in the key, e.g. ["ii7","V7","Imaj7"] or ["I","V","vi","IV"]. ' +
        "Optional for suggest-progression — omit it to get common progressions instead.",
    ),
});

/** Shared handler: identical text on both transports, never throws. */
export function buildAnalyzeHarmonyResult(
  args: z.infer<typeof analyzeHarmonyInputSchema>,
): CallToolResult {
  return { content: [{ type: "text", text: analyzeHarmony(args) }] };
}

// -----------------------------------------------------------------------------
// convert-abc-to-strudel — bridge scored composition into live performance
// -----------------------------------------------------------------------------

export const CONVERT_ABC_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const CONVERT_ABC_DESCRIPTION =
  "Turn an ABC melody into Strudel mini-notation so a scored piece can be remixed live. " +
  "Returns runnable code — setcps() from the Q: tempo, one [...] bar group per bar inside " +
  "note(\"<...>\"), with a chord(\"<...>\").voicing() layer stacked alongside it when the ABC " +
  "has chord symbols (one stack(), because Strudel plays only the last expression) — " +
  "then pass it to play-live-pattern. Durations become @ weights, rests become ~, " +
  "triplets nest, the key signature is folded into the note names, and %%MIDI program " +
  "picks the sound. Lists what was lost (grace notes, dynamics, repeats, lyrics, other " +
  "voices, inline tempo changes, a short final bar, ABC's own gchord/drum accompaniment). " +
  "Pick a single voice with `voice`; re-run per voice and stack() them for a full arrangement.";

export const convertAbcInputSchema = z.object({
  abcNotation: z
    .string()
    .max(MAX_SOURCE_CHARS)
    .describe("ABC notation to convert (the same string you'd pass to play-sheet-music)."),
  voice: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Which voice to convert, 1-based, counted across all staves (default 1). " +
        "Multi-voice tunes report how many voices there are.",
    ),
  sound: z
    .string()
    .optional()
    .describe(
      `Strudel sound for the melody (defaults to the tune's %%MIDI program, else "${DEFAULT_STRUDEL_SOUND}"). ` +
        "Use a GM soundfont name like gm_flute or gm_epiano1 — see get-strudel-guide topic 'sounds'.",
    ),
});

/**
 * Shared handler. The abcjs parser is injected so this module stays free of the
 * abcjs import; each transport passes its own `ABCJS.parseOnly`.
 */
export function buildConvertAbcResult(
  args: AbcToStrudelArgs,
  parseOnly: ParseOnlyFn,
): CallToolResult {
  const result = convertAbcToStrudel(args, parseOnly);
  if (!result.ok) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `${result.error}\n\nTip: use get-music-guide("abc-syntax") for notation reference.`,
        },
      ],
    };
  }
  return { content: [{ type: "text", text: result.text }] };
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
          `use stack() to layer drums, bass, and melody, and set a fitting tempo with setcps(). ` +
          `For a living widget, add a visual — see get-strudel-guide topic "visuals".`,
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
