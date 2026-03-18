import ABCJS from "abcjs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ParseOnlyResult = {
  warnings?: string[];
};

export type ParseOnlyFn = (abcNotation: string) => ParseOnlyResult[];

export function createPlaySheetMusicResult(
  abcNotation: string,
  parseOnly: ParseOnlyFn = ABCJS.parseOnly as ParseOnlyFn,
): CallToolResult {
  const [{ warnings } = {}] = parseOnly(abcNotation);

  if (warnings && warnings.length > 0) {
    const messages = warnings.map((warning) => warning.replace(/<[^>]*>/g, ""));
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
          text: `Parsed with warnings (will still play):\n${messages.join("\n")}`,
        },
      ],
    };
  }

  return {
    content: [{ type: "text", text: "Music parsed successfully. Playing!" }],
  };
}
