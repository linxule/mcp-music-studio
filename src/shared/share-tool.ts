import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MAX_SOURCE_CHARS, playLiveInputSchema, playSheetInputSchema } from "./tool-defs.js";
import {
  DEFAULT_SHARE_ORIGIN,
  SHARE_PARAM_MAX_BYTES,
  toPlayShareArgs,
  type SharePayload,
} from "./share-url.js";

export const CREATE_SHARE_DESCRIPTION =
  "Create a hosted music share link only when the user asks to share or store a piece online. " +
  "Uploads the supplied score or pattern to MCP Music Studio for 30 days; anyone with the link can view and play it without signing in. " +
  "Creating the same share again refreshes its expiry. Playback does not require this tool. " +
  "Provide kind 'score' with score, or kind 'play' with pattern. Never include private information or secrets.";

export const CREATE_SHARE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export const createShareInputSchema = z.object({
  kind: z.enum(["score", "play"]),
  score: playSheetInputSchema.extend({
    abcNotation: z.string().min(1).max(MAX_SOURCE_CHARS),
  }).optional(),
  pattern: playLiveInputSchema.optional(),
});

export async function createShareResult(
  args: z.infer<typeof createShareInputSchema>,
  store: (payload: SharePayload) => Promise<string>,
): Promise<CallToolResult> {
  if ((args.kind === "score" && (!args.score || args.pattern)) ||
      (args.kind === "play" && (!args.pattern || args.score))) {
    return { isError: true, content: [{ type: "text", text:
      "Provide exactly one matching input: kind 'score' with score, or kind 'play' with pattern." }] };
  }
  const payload: SharePayload = args.kind === "score"
    ? { kind: "score", args: args.score! }
    : { kind: "play", args: toPlayShareArgs(args.pattern!) };
  // The local HTTP client and the in-process Worker accept the same byte limit.
  if (new TextEncoder().encode(JSON.stringify(payload)).length > SHARE_PARAM_MAX_BYTES) {
    return { isError: true, content: [{ type: "text", text:
      "This share exceeds the 64 KiB upload limit. Shorten the score or pattern and try again. Nothing was stored." }] };
  }
  try {
    const url = await store(payload);
    return { content: [
      { type: "text", text: `Share link created: ${url}\nAnyone with this link can view and play the piece. It is stored for 30 days; creating the same share again refreshes that period. See ${DEFAULT_SHARE_ORIGIN}/privacy.` },
      { type: "resource_link", uri: url, name: "Music share (30 days)", mimeType: "text/html" },
    ] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text:
      `Could not create the share link. ${error instanceof Error ? error.message : "Please try again later."}` }] };
  }
}

/** Only the explicit share tool uploads local source to the hosted service. */
export async function uploadShare(payload: SharePayload): Promise<string> {
  const response = await fetch(`${DEFAULT_SHARE_ORIGIN}/share`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(response.status === 429
      ? "Too many share requests. Try again later."
      : `The share service returned HTTP ${response.status}. Try again later.`);
  }
  const data = await response.json() as { url?: unknown };
  if (typeof data.url !== "string" ||
      !data.url.startsWith(`${DEFAULT_SHARE_ORIGIN}/p/`) ||
      !/^[0-9a-f]{32}$/.test(data.url.slice(`${DEFAULT_SHARE_ORIGIN}/p/`.length))) {
    throw new Error("The share service returned an invalid link.");
  }
  return data.url;
}
