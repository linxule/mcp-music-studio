import ABCJS from "abcjs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { PLAY_SHEET_NEUTRAL_TEXT } from "./shared/tool-defs.js";
import { resolveInvocationSettings } from "./music-logic.js";

/**
 * The slice of abcjs' parse-only output this module reads.
 *
 * `lines` is optional because tests (and any future caller) inject a stub
 * parser: a stub that models only `warnings` must not be read as "this tune is
 * empty". Real abcjs always returns a `lines` array, even for empty input.
 */
export type ParseOnlyResult = {
  warnings?: string[];
  lines?: ParsedLine[];
};

type ParsedLine = {
  staff?: { voices?: { el_type?: string }[][] }[];
};

export type ParseOnlyFn = (abcNotation: string) => ParseOnlyResult[];

/** The subset of the play-sheet-music arguments this result text depends on. */
export interface PlaySheetMusicArgs {
  abcNotation: string;
  instrument?: string;
}

export interface PlaySheetResultOptions {
  /**
   * Trailing hint appended to the success text. The local server adds its
   * `--render-mode` tip here; the Worker, where that flag doesn't exist, passes
   * an empty string.
   */
  hint?: string;
}

/** The local server's fallback tip — kept as the default for existing callers. */
export const LOCAL_RENDER_MODE_HINT =
  " Re-run with --render-mode browser to open a playable version in your browser.";

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

/**
 * Does this parsed tune contain anything you could actually hear?
 *
 * `null` means "the parser didn't tell us" (a stub with no `lines`), which is
 * treated as inconclusive rather than empty.
 *
 * abcjs reports both notes and rests as `el_type: "note"` (a rest is a note
 * carrying `rest`), so one such element in any voice of any staff is enough.
 * Bar lines, clefs and key signatures alone are not: `X:1\nK:C\n||||` parses
 * without a single warning and used to be reported as a score that was "ready".
 */
function hasPlayableContent(tune: ParseOnlyResult | undefined): boolean | null {
  if (!tune || !Array.isArray(tune.lines)) return null;
  for (const line of tune.lines) {
    for (const staff of line?.staff ?? []) {
      for (const voice of staff?.voices ?? []) {
        for (const element of voice ?? []) {
          if (element?.el_type === "note") return true;
        }
      }
    }
  }
  return false;
}

/**
 * "N tunes found; the first is rendered." — or "" for the ordinary single tune.
 *
 * Only the first tune of a multi-tune ABC file reaches the widget, and nothing
 * used to say so: the extra tunes vanished silently.
 */
function multiTuneNote(tuneCount: number): string {
  if (tuneCount <= 1) return "";
  return `\n\n${tuneCount} tunes found in this ABC; only the first is rendered. Send the others as separate calls.`;
}

export function createPlaySheetMusicResult(
  input: string | PlaySheetMusicArgs,
  parseOnly: ParseOnlyFn = ABCJS.parseOnly as ParseOnlyFn,
  options: PlaySheetResultOptions = {},
): CallToolResult {
  const args: PlaySheetMusicArgs =
    typeof input === "string" ? { abcNotation: input } : input;
  const hint = options.hint ?? LOCAL_RENDER_MODE_HINT;
  const tunes = parseOnly(args.abcNotation) ?? [];
  const [first] = tunes;
  const { warnings } = first ?? {};

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
          // Not "will still play": whether anything plays depends on the host,
          // and on a terminal client nothing does.
          text:
            `Parsed with warnings (the score still renders in MCP-app hosts):\n${messages.join("\n")}` +
            multiTuneNote(tunes.length) +
            instrumentNote(args.instrument),
        },
      ],
    };
  }

  // A clean parse is not the same as a score. Reject material with no notes or
  // rests rather than confirming an empty stave as ready.
  if (hasPlayableContent(first) === false) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            "ABC parsed, but the score has no notes or rests — nothing would play or render. " +
            "Check that there is a tune body after the K: line.\n\n" +
            'Tip: Use get-music-guide("abc-syntax") for notation reference.',
        },
      ],
    };
  }

  // Compose from the shared constant (single source of truth) + the caller's hint.
  return {
    content: [
      {
        type: "text",
        text:
          `${PLAY_SHEET_NEUTRAL_TEXT}${hint}` +
          multiTuneNote(tunes.length) +
          instrumentNote(args.instrument),
      },
    ],
  };
}
