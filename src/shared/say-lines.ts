// =============================================================================
// say() lines a pattern will ask for — found by parsing, never by running
//
// The hosted Worker warms GET /tts with these at tool time, so the player's
// later fetch is a cache hit and a voiced piece doesn't start late (0.12).
// Pure: the Worker is the only caller; the local server has no /tts to warm.
//
// Only what the player would actually render is extracted:
//   say('words')                    → luna (the default voice)
//   say('words', { voice: 'orion' }) → orion
// SINGLE-quoted literals only. Strudel's transpiler turns every double-quoted
// string AND every untagged template literal into mini-notation before the
// code runs, so say("words") and say(`words`) hand say() a pattern, which it
// refuses — warming those would pay for lines that never play. The same goes
// for a voice written in double quotes.
//
// sing('words', notes, { voice: 'orion' }) is read the same way (its options
// are the THIRD argument) and marked `words`: the Worker then warms the clip
// AND its word timings, so a sung line is ready when the pattern evaluates.
//
// Anything not a literal is skipped, by design: say(SPEECH.bar) where
// SPEECH = { bar: 'x' }, say(lines[i]), say('a' + b), a voice from a variable,
// an options object with a spread. Those still play; their first fetch renders
// as before.
// =============================================================================

import { parse } from "acorn";
import { normalizeTts, type TtsRequest } from "./tts.js";

/** Most distinct lines one tool call warms. Each one is a paid render on a miss. */
export const PRERENDER_MAX_LINES = 8;

/** A line to warm; `words` = a sing() line (warm its word timings too). */
export type SayLine = TtsRequest & { words?: true };

export type SayLines = {
  /** Distinct (voice, normalized text) pairs, in source order, at most `max`. */
  lines: SayLine[];
  /** Distinct renderable lines left out because of the cap. */
  overCap: number;
};

type Node = { type: string; [key: string]: unknown };

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as Node).type === "string";

/** A single-quoted string literal's value, or undefined. */
function singleQuoted(node: unknown): string | undefined {
  if (!isNode(node) || node.type !== "Literal") return undefined;
  const { value, raw } = node as Node & { value: unknown; raw?: string };
  return typeof value === "string" && raw?.[0] === "'" ? value : undefined;
}

/** The voice an options argument names: null = default, undefined = can't tell. */
function voiceOf(options: unknown): string | null | undefined {
  if (options === undefined) return null;
  if (!isNode(options) || options.type !== "ObjectExpression") return undefined;
  let voice: string | null | undefined = null;
  for (const prop of options.properties as Node[]) {
    // A spread or a computed key could carry a voice we can't see.
    if (prop.type !== "Property" || prop.computed) return undefined;
    const key = prop.key as Node & { name?: string; value?: unknown };
    if ((key.type === "Identifier" ? key.name : key.value) !== "voice") continue;
    voice = singleQuoted(prop.value); // the last one wins, as in JavaScript
  }
  return voice;
}

/** The say() lines in `code` worth rendering ahead of the player. Never throws. */
export function extractSayLines(code: string, max = PRERENDER_MAX_LINES): SayLines {
  let ast: unknown;
  try {
    ast = parse(code, { ecmaVersion: "latest", sourceType: "script", allowAwaitOutsideFunction: true });
  } catch {
    return { lines: [], overCap: 0 };
  }
  const seen = new Map<string, SayLine | null>();
  const lines: SayLine[] = [];
  let overCap = 0;
  const stack: unknown[] = [ast];
  // Depth-first, children pushed in reverse so lines come out in source order.
  while (stack.length) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
      continue;
    }
    if (!isNode(node)) continue;
    if (node.type === "CallExpression") {
      const callee = node.callee as Node & { name?: string };
      const args = node.arguments as unknown[];
      const name = callee.type === "Identifier" ? callee.name : undefined;
      const sung = name === "sing";
      const text = name === "say" || sung ? singleQuoted(args[0]) : undefined;
      const voice = text === undefined ? undefined : voiceOf(args[sung ? 2 : 1]);
      if (text !== undefined && voice !== undefined) {
        const line: SayLine | { error: string } = normalizeTts(text, voice ?? undefined);
        if (!("error" in line)) {
          if (sung) line.words = true;
          const id = `${line.voice}\u0000${line.text}`;
          if (!seen.has(id)) {
            const kept = lines.length < max ? line : null;
            seen.set(id, kept);
            if (kept) lines.push(kept);
            else overCap++;
          } else if (sung) {
            // Said and sung: warming the words warms the clip too.
            const kept = seen.get(id);
            if (kept) kept.words = true;
          }
        }
      }
    }
    const children = Object.entries(node)
      .filter(([key]) => key !== "loc" && key !== "start" && key !== "end")
      .map(([, value]) => value)
      .filter((value) => isNode(value) || Array.isArray(value));
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return { lines, overCap };
}
