// =============================================================================
// get-session / update-session — shared by both transports
//
// The Worker answers from its Durable Object directly; the local stdio server
// reaches the same hosted routes over HTTPS (its widget joins the hosted
// session too — the widget can only reach origins in its CSP). Each transport
// supplies a SessionBackend and a code check; everything the model reads is
// built here, so the two cannot drift (tests/transport-parity.test.ts).
// =============================================================================

import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SESSION_ID_RE, SESSION_MAX_QUANTIZE, type QueuedPattern, type SessionEvent } from "./session.js";
import { MAX_SOURCE_CHARS } from "./tool-defs.js";

export interface SessionUpdateOutcome {
  pattern: QueuedPattern;
  /** The widget's answer for this rev, if it came within the wait. */
  applied: Extract<SessionEvent, { t: "applied" }> | null;
  /** Milliseconds since a player last checked in; null if none ever did. */
  widgetSeenMsAgo: number | null;
  /** Where the player's clock is now, and the cycle the update lands on. */
  estCycle: number | null;
  boundary: number | null;
  cps: number | null;
}

export interface SessionBackend {
  /** Open a session; returns its id. */
  /** `seed` is the code it opens with, so a second screen (/s/<id>) can load it. */
  create(seed?: string): Promise<string>;
  /** The model-facing description, advancing the read mark; null if unknown. */
  state(
    id: string,
    wait?: { mode: "pass" | "activity"; timeoutMs?: number },
    signal?: AbortSignal,
  ): Promise<string | null>;
  update(id: string, code: string, quantize: number): Promise<SessionUpdateOutcome | null>;
}

export interface CodeProblem {
  message: string;
  line?: number;
  column?: number;
}

export const GET_SESSION_DESCRIPTION =
  "Read a live session opened by play-live-pattern(session: true): whether the player is up and what " +
  "it is playing, its runtime reports (errors, silence, missing sounds, a callback that threw), and what " +
  "the human did since your last read — taps (cycle and position), code they edited and ran, and when " +
  "they passed the turn to you. Read it before assuming a piece played, and when the user says it's your turn. " +
  "With wait: 'pass' it LISTENS — holds until the listener presses Pass — so you can play a whole back-to-back " +
  "set in one turn: update-session, get-session(wait: 'pass'), answer, listen again.";

export const UPDATE_SESSION_DESCRIPTION =
  "Swap a new pattern into a live session's player — no new player, the music keeps playing. " +
  "Send the WHOLE pattern, as you would to play-live-pattern. It takes over at the next bar " +
  "(quantize 1, the default), at the next multiple of n cycles, or at once (0). Patterns run on the session's clock, so " +
  "set quantize to your phrase length (an 8-bar phrase → 8) and the swap lands on its first bar. " +
  "The code is syntax-checked first; the result says whether the player ran it, and its error if not, " +
  "when the player answers within a few seconds.";

const sessionField = z
  .string()
  .regex(SESSION_ID_RE)
  .describe("The session id from play-live-pattern's result (16 lowercase letters/digits).");

export const getSessionInputSchema = z.object({
  session: sessionField,
  wait: z
    .enum(["pass", "activity"])
    .optional()
    .describe(
      "Listen instead of just reading: 'pass' holds until the listener presses Pass, 'activity' until they play " +
        "(a few seconds after their first move). Returns at once if that already happened since your last read, " +
        "and after ~40 s if not — call again to keep listening. Lets you stay in the booth for a whole set.",
    ),
});

export const updateSessionInputSchema = z.object({
  session: sessionField,
  code: z
    .string()
    .max(MAX_SOURCE_CHARS)
    .describe("The complete new Strudel pattern (same rules as play-live-pattern's code)."),
  quantize: z
    .number()
    .int()
    .min(0)
    .max(SESSION_MAX_QUANTIZE)
    .optional()
    .describe("Land on the next multiple of this many cycles (bars). 1 = next bar (default), 4/8 = phrase, 0 = now."),
});

export const GET_SESSION_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false, // reading advances the "since your last read" mark
  openWorldHint: false,
} as const;

export const UPDATE_SESSION_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

/** Appended to play-live-pattern's result when a session was opened. */
export function sessionNote(id: string): string {
  return (
    `Live session: ${id}. This player stays open as one performance. ` +
    `update-session(session: "${id}", code) swaps in a new pattern on the next bar — no new player — and ` +
    `says whether it ran; get-session(session: "${id}") reads what happened: runtime errors, what is playing, ` +
    "and the human's taps, control moves, code edits and when they hand the turn to you — with wait: \"pass\" it " +
    "listens until they press Pass. The session closes after 2 hours idle."
  );
}

export const SESSION_UNAVAILABLE_NOTE =
  "A live session was requested but could not be opened (the session service did not answer); " +
  "the pattern plays as a normal one-off player.";

const unknownSession = (id: string): CallToolResult => ({
  isError: true,
  content: [
    {
      type: "text",
      text:
        `No live session "${id}" — it may have expired (2 hours idle) or the id is mistyped. ` +
        "Open a new one with play-live-pattern(session: true).",
    },
  ],
});

const cyc = (c: number | null): string => (c === null ? "?" : (Math.round(c * 10) / 10).toFixed(1));

export function buildUpdateSessionResult(
  id: string,
  outcome: SessionUpdateOutcome | null,
): CallToolResult {
  if (!outcome) return unknownSession(id);
  const { pattern, applied, widgetSeenMsAgo, estCycle, boundary, cps } = outcome;
  if (applied) {
    if (!applied.ok) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              `Rev ${pattern.rev} failed in the player: ${applied.error ?? "unknown error"}. ` +
              "The previous pattern kept playing. Fix it and call update-session again.",
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text",
          text:
            `Rev ${pattern.rev} applied — it takes over at cycle ${cyc(applied.cycle)}.` +
            (applied.report ? ` ${applied.report}` : "") +
            ` get-session(session: "${id}") shows what the human does next.`,
        },
      ],
    };
  }
  if (widgetSeenMsAgo === null || widgetSeenMsAgo > 60_000) {
    return {
      content: [
        {
          type: "text",
          text:
            `Rev ${pattern.rev} queued, but no player ` +
            (widgetSeenMsAgo === null
              ? "has joined this session yet"
              : `has checked in for ${Math.round(widgetSeenMsAgo / 1000)} s — it may be closed, scrolled away, or the app backgrounded`) +
            ". It applies when the player (re)connects. Nothing is audible from this update until then.",
        },
      ],
    };
  }
  const eta =
    boundary !== null && estCycle !== null && cps
      ? ` (~${Math.max(0, Math.round((boundary - estCycle) / cps))} s from now)`
      : "";
  return {
    content: [
      {
        type: "text",
        text:
          `Rev ${pattern.rev} queued for cycle ${cyc(boundary)}${eta}; the player had not confirmed it yet. ` +
          `Call get-session(session: "${id}") in a moment to see whether it ran.`,
      },
    ],
  };
}

/**
 * Register both tools. `check` is the transport's own pre-flight (the Worker
 * can only parse; the local server evaluates in its sandbox), so a typo comes
 * back as a tool error and never reaches the player.
 */
export function registerSessionTools(
  server: { registerTool(name: string, config: unknown, cb: unknown): unknown },
  backend: SessionBackend,
  check: (code: string) => Promise<CodeProblem | null>,
): void {
  server.registerTool(
    "get-session",
    {
      title: "Read Live Session",
      description: GET_SESSION_DESCRIPTION,
      inputSchema: getSessionInputSchema,
      annotations: GET_SESSION_ANNOTATIONS,
    },
    async (
      args: { session: string; wait?: "pass" | "activity" },
      extra?: { signal?: AbortSignal },
    ): Promise<CallToolResult> => {
      // A cancelled call must stop listening, or the player's Pass is told a
      // model heard it when none will (Codex review).
      const text = await backend.state(args.session, args.wait ? { mode: args.wait } : undefined, extra?.signal);
      if (text === null) return unknownSession(args.session);
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "update-session",
    {
      title: "Update Live Session",
      description: UPDATE_SESSION_DESCRIPTION,
      inputSchema: updateSessionInputSchema,
      annotations: UPDATE_SESSION_ANNOTATIONS,
    },
    async (args: { session: string; code: string; quantize?: number }): Promise<CallToolResult> => {
      const problem = await check(args.code);
      if (problem) {
        const at =
          problem.line !== undefined && !/\(\d+:\d+\)\s*$/.test(problem.message)
            ? ` (${problem.line}:${problem.column ?? 0})`
            : "";
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `Not sent — the pattern does not parse: ${problem.message}${at}. ` +
                "The player keeps playing the previous pattern.",
            },
          ],
        };
      }
      const outcome = await backend.update(args.session, args.code, args.quantize ?? 1);
      return buildUpdateSessionResult(args.session, outcome);
    },
  );
}

/**
 * A SessionBackend over the hosted session routes. The local server passes
 * `fetch` against the hosted origin; the Worker passes its own route handler,
 * so both run the same requests through the same code.
 */
export function httpSessionBackend(
  call: (path: string, init?: RequestInit) => Promise<Response>,
): SessionBackend {
  return {
    async create(seed) {
      const res = await call("/session/new", {
        method: "POST",
        headers: { "content-type": "text/plain;charset=UTF-8" },
        body: seed ? JSON.stringify({ seed }) : undefined,
      });
      if (!res.ok) throw new Error(`session service answered ${res.status}`);
      const body = (await res.json()) as { id?: unknown };
      if (typeof body.id !== "string") throw new Error("session service sent no id");
      return body.id;
    },
    async state(id, wait, signal) {
      const q = wait ? `?wait=${wait.mode}${wait.timeoutMs ? `&timeout=${wait.timeoutMs}` : ""}` : "";
      const res = await call(`/session/${id}/state${q}`, signal ? { signal } : undefined);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`session service answered ${res.status}`);
      return ((await res.json()) as { text: string }).text;
    },
    async update(id, code, quantize) {
      const res = await call(`/session/${id}/update`, {
        method: "POST",
        headers: { "content-type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({ code, quantize }),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`session service answered ${res.status}`);
      return (await res.json()) as SessionUpdateOutcome;
    },
  };
}

/**
 * Open a session for a play-live-pattern result: a line for the model and
 * `_meta.session` for the widget (which joins it at `origin`). A failure to
 * open one never fails the play — the piece plays as a one-off player.
 */
export async function attachSession(
  result: CallToolResult,
  backend: SessionBackend,
  origin: string,
  /** The code the piece starts with — what /s/<id> loads before any update. */
  seed?: string,
): Promise<CallToolResult> {
  if (result.isError) return result;
  let line: string;
  let meta: Record<string, unknown> = {};
  try {
    const id = await backend.create(seed);
    // A second screen: the same session in the full player, where tilt and
    // the microphone are allowed (a chat's widget frame blocks them).
    line = `${sessionNote(id)} The same session opens in a browser too (another device, sensors, fullscreen): ${origin}/s/${id}`;
    meta = { session: { id, origin } };
  } catch {
    line = SESSION_UNAVAILABLE_NOTE;
  }
  const content = result.content.map((block, i) =>
    i === 0 && block.type === "text" ? { ...block, text: `${block.text}\n${line}` } : block,
  );
  return { ...result, content, _meta: { ...result._meta, ...meta } };
}
