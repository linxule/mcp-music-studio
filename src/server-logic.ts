import ABCJS from "abcjs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { PLAY_SHEET_NEUTRAL_TEXT } from "./shared/tool-defs.js";
import { resolveInvocationSettings } from "./music-logic.js";

export type ParseOnlyResult = {
  warnings?: string[];
};

export type ParseOnlyFn = (abcNotation: string) => ParseOnlyResult[];

/** The subset of the play-sheet-music arguments this result text depends on. */
export interface PlaySheetMusicArgs {
  abcNotation: string;
  instrument?: string;
}

/**
 * How the requested instrument actually resolved, as one line of agent-facing
 * text — or "" when there is nothing to report.
 *
 * The widget resolves instrument names fuzzily (`findInstrument`), and an
 * unmatched name used to fall back to a grand piano with no signal at all: the
 * agent asked for a banjo, heard a piano, and was told the piece had played.
 */
function instrumentNote(instrument: string | undefined): string {
  if (!instrument?.trim()) return "";
  const settings = resolveInvocationSettings({ instrument });
  if (!settings.warning) return "";
  return `\n\nInstrument: ${settings.instrument} (requested "${settings.requestedInstrument}"). ${settings.warning}`;
}

export function createPlaySheetMusicResult(
  input: string | PlaySheetMusicArgs,
  parseOnly: ParseOnlyFn = ABCJS.parseOnly as ParseOnlyFn,
): CallToolResult {
  const args: PlaySheetMusicArgs =
    typeof input === "string" ? { abcNotation: input } : input;
  const [{ warnings } = {}] = parseOnly(args.abcNotation);

  if (warnings && warnings.length > 0) {
    const messages = warnings.map((warning) =>
      String(warning).replace(/<[^>]*>/g, ""),
    );
    const hasErrors = messages.some(
      (message) =>
        message.includes("Expected") ||
        message.includes("Unknown") ||
        message.includes("Error"),
    );

    if (hasErrors) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `ABC notation has errors:\n${messages.join("\n")}\n\nTip: Use get-music-guide("abc-syntax") for notation reference.`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Parsed with warnings (will still play):\n${messages.join("\n")}${instrumentNote(args.instrument)}`,
        },
      ],
    };
  }

  // Compose from the shared constant (single source of truth) + a local-only hint.
  return {
    content: [
      {
        type: "text",
        text:
          `${PLAY_SHEET_NEUTRAL_TEXT} Re-run with --render-mode browser to open a playable version in your browser.` +
          instrumentNote(args.instrument),
      },
    ],
  };
}
