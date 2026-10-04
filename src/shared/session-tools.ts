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
import { LOADED_STOPPED, SESSION_ID_RE, SESSION_MAX_QUANTIZE, staleWidgetHint, type QueuedPattern, type SessionEvent } from "./session.js";
import { MAX_SOURCE_CHARS } from "./tool-defs.js";

export interface SessionUpdateOutcome {
  pattern: QueuedPattern;
  /** The widget's answer for this rev, if it came within the wait. */
  applied: Extract<SessionEvent, { t: "applied" }> | null;
  /** Milliseconds since a player last checked in; null if none ever did. */
  widgetSeenMsAgo: number | null;
  /** The state that check-in reported, before this update reached the player (absent before 0.10.2). */
  widgetState?: string | null;
  /** How many times a player joined this session; more than one can mean a second screen (/s/<id>). */
  joins?: number;
  /** Where the player's clock is now, and the cycle the update lands on. */
  estCycle: number | null;
  boundary: number | null;
  cps: number | null;
  /** The player's widget version (absent before 0.10.1), for the stale-widget hint. */
  widget?: string | null;
  /** The bar the PLAYER picked (it says so before waiting for it); null if it had not answered. */
  scheduled?: { boundary: number } | null;
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
  /** null: no such session; "ended": the listener closed it (End session). */
  update(id: string, code: string, quantize: number): Promise<SessionUpdateOutcome | null | "ended">;
}

export interface CodeProblem {
  message: string;
  line?: number;
  column?: number;
}

export const GET_SESSION_DESCRIPTION =
  "Only for a live session (play-live-pattern session: true). Reads whether the player is up and what it played, " +
  "its errors and silences, and what the human did since your last read: taps, changes to remember() state, " +
  "code they ran, a Pass to you, or End. Read it before assuming a piece played. With wait: 'pass' it listens " +
  "until the human presses Pass, so a whole back-and-forth set fits in one turn: update-session, " +
  "get-session(wait: 'pass'), answer, listen again.";

export const UPDATE_SESSION_DESCRIPTION =
  "Only for a live session. Swaps new code into the session's player while the music keeps playing. " +
  "Send the WHOLE pattern, as for play-live-pattern. It lands on the next bar (quantize 1, the default), " +
  "the next multiple of n bars, or at once (0): set quantize to your phrase length (8-bar phrase → 8). " +
  "If the player answers within a few seconds, the result says whether it ran the code, or its error. To change a piece's remember() state, " +
  "ship a merge, not a new start value (get-strudel-guide topic 'interactive').";

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
      "Listen instead of just reading: 'pass' until the listener presses Pass, 'activity' until they play. " +
        "Returns at once if that already happened since your last read, else after ~40 s — call again to keep listening.",
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
    "listens until they press Pass. The session closes after 2 hours idle, or when the listener presses End session."
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

const endedSession = (): CallToolResult => ({
  isError: true,
  content: [
    {
      type: "text",
      text:
        "The listener ended this session — the player no longer takes updates (its last pattern keeps playing on its own). " +
        "Open a new one with play-live-pattern(session: true).",
    },
  ],
});

/**
 * The player was stopped when the update reached it. A stopped player has no
 * bar to land on — Play starts it — so name none. If its last check-in said
 * "playing", say so, or the model reads get-session's "playing" and this
 * answer as a contradiction (claude.ai field test, 2026-10-03).
 */
function loadedStoppedReply(rev: number, outcome: SessionUpdateOutcome): string {
  const text =
    `Rev ${rev} arrived while the player was stopped, so there is no landing bar: it ${LOADED_STOPPED}.`;
  if (outcome.widgetState !== "playing" || outcome.widgetSeenMsAgo === null) return text;
  const secs = Math.max(1, Math.round(outcome.widgetSeenMsAgo / 1000));
  const why = "the listener pressed Stop, or the player was suspended (on a phone: the app in the background or the screen locked)";
  // Every joined screen answers updates; the one that answered need not be
  // the one that reported "playing" (Codex review, 0.10.2).
  if ((outcome.joins ?? 0) > 1) {
    return (
      text +
      ` A player had reported "playing" ${secs} s before this update. More than one screen has joined this session, ` +
      `so either that player stopped in between (${why}), or a stopped second screen answered first.`
    );
  }
  return text + ` The player had reported "playing" ${secs} s before this update, so it stopped in between: ${why}.`;
}

export function buildUpdateSessionResult(
  id: string,
  outcome: SessionUpdateOutcome | null | "ended",
): CallToolResult {
  if (outcome === "ended") return endedSession();
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
              (staleWidgetHint(applied.error, outcome.widget ?? null) ??
                "The previous pattern kept playing. Fix it and call update-session again."),
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text",
          text:
            (applied.cycle === null
              ? loadedStoppedReply(pattern.rev, outcome)
              : `Rev ${pattern.rev} applied — it takes over at cycle ${cyc(applied.cycle)}.`) +
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
  const eta = (at: number | null) =>
    at !== null && estCycle !== null && cps ? ` (~${Math.max(0, Math.round((at - estCycle) / cps))} s from now)` : "";
  if (outcome.scheduled) {
    const at = outcome.scheduled.boundary;
    return {
      content: [
        {
          type: "text",
          text:
            `Rev ${pattern.rev} takes over at cycle ${cyc(at)}${eta(at)} — the bar the player picked. ` +
            `get-session(session: "${id}") confirms when it plays.`,
        },
      ],
    };
  }
  return {
    content: [
      {
        type: "text",
        text:
          `Rev ${pattern.rev} queued — estimated to take over around cycle ${cyc(boundary)}${eta(boundary)}; the player had not answered yet. ` +
          `Call get-session(session: "${id}") in a moment to see where it landed.`,
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
      if (res.status === 410) return "ended";
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
