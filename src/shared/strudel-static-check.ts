// =============================================================================
// Syntax check without running anything — what the remote Worker CAN verify
//
// Workers can't run Strudel (its evaluate() needs `new Function`, which workerd
// refuses), so until 0.7 the remote play-live-pattern returned "not verified"
// for everything. But TRANSPILING needs no code generation: acorn parses the
// JavaScript and @strudel/mini parses every double-quoted string. That catches
// the class of error that cost the most round trips in claude.ai — the `))`
// for `)]` that both Lossy versions shipped, which only the user ever saw.
// =============================================================================

// @ts-ignore -- no types published
import { transpiler } from "@strudel/transpiler";
import type { StrudelValidationError } from "./strudel-validation-types.js";

/** A syntax or mini-notation error with its position, or null when the code parses. */
export function staticCheckStrudel(code: string): StrudelValidationError | null {
  try {
    transpiler(code);
    return null;
  } catch (err) {
    const e = err as Error & { loc?: { line?: number; column?: number } };
    const message = e?.message ?? String(err);
    const name = e?.name && e.name !== "Error" && !message.startsWith(e.name) ? `${e.name}: ` : "";
    if (typeof e?.loc?.line === "number") {
      return { message: `${name}${message}`, line: e.loc.line, column: e.loc.column };
    }
    const match = /\((\d+):(\d+)\)\s*$/.exec(message);
    return match
      ? { message: `${name}${message}`, line: Number(match[1]), column: Number(match[2]) }
      : { message: `${name}${message}` };
  }
}
