// =============================================================================
// Tempo injection — the single documented tempo policy for BOTH delivery paths
// (the ext-apps widget in src/strudel-app.ts and the browser fallback in
// src/strudel-browser-fallback.ts).
//
// DOM-free and dependency-free by design: vitest exercises it in Node, and the
// widget bundle must not grow a parser for a one-line rewrite. Instead of an
// AST we run a tokenizer-lite scanner that knows enough JavaScript lexical
// structure (comments, strings, template literals, regex literals, bracket
// depth) to tell a real top-level `setcps(...)` call from a look-alike.
// =============================================================================

/**
 * ## Tempo policy
 *
 * `play-live-pattern` takes an optional `bpm`. Strudel's own unit is cycles per
 * second (`setcps`) or cycles per minute (`setcpm`), so a bpm has to be
 * converted and then either *written into* the pattern's existing tempo call or
 * *prepended* as a new one. The old implementation did that with
 * `code.replace(/setcps\s*\([^)]*\)/, ...)`, which corrupts nested parens
 * (`setcps(120 / (60 * 4))` → `setcps(0.5))`, a syntax error that silently
 * kills the pattern) and also matches inside comments and strings.
 *
 * The policy implemented here, in order:
 *
 * 1. **`"replaced"`** — the code contains exactly ONE top-level tempo setter
 *    (`setcps` / `setcpm` at statement position, paren/brace/bracket depth 0,
 *    not a member access) and no other `setcps`/`setcpm` identifier anywhere
 *    outside comments and strings, AND its single argument is a pure numeric
 *    expression. The argument text is replaced in place; everything else in the
 *    source is preserved byte for byte.
 * 2. **`"inserted"`** — no `setcps`/`setcpm` identifier occurs anywhere outside
 *    comments and strings. `setcps(<cps>)\n` is prepended (after a `#!` line or
 *    a `"use …"` directive prologue, if present).
 * 3. **`"inserted-ambiguous"`** — anything else: multiple setters, a setter
 *    nested in a function/call/template expression, a shadowing
 *    `const setcps = …`, an alias `const t = setcps`, a member `.setcps(`, or a
 *    non-numeric/effectful argument such as `setcps(getTempo())`. Nothing is
 *    rewritten in place; `setcps(<cps>)\n` is prepended so the requested tempo
 *    still applies unless the pattern's own later call overrides it at runtime.
 *
 * Rationale for (3): never silently discard a pattern's intentional tempo
 * changes, and never emit a syntax error. A prepended line is always safe — at
 * worst it is overridden by code that runs after it.
 *
 * A "pure numeric argument" is digits, `.`, whitespace and `+ - * / % ( )`
 * only, containing at least one digit and no comment marker. Anything else is
 * treated as ambiguous.
 *
 * Inputs longer than 65536 characters skip the scan entirely and take the
 * prepend path (`"inserted-ambiguous"`).
 *
 * Callers gate on `if (bpm)`. If `bpm` is not a finite number greater than
 * zero, the code is returned untouched (policy `"inserted-ambiguous"`, meaning
 * "no confident rewrite happened").
 */

export interface TempoResult {
  /** The rewritten pattern source. */
  code: string;
  /** Which branch of the policy above produced `code`. */
  policy: "inserted" | "replaced" | "inserted-ambiguous";
  /** Cycles per second the requested bpm maps to, rounded to 4 decimals. */
  cps: number;
}

/** Largest input the scanner will look at; longer sources take the prepend path. */
const MAX_SCAN_LENGTH = 65536;

const TEMPO_NAMES = new Set(["setcps", "setcpm"]);

/** Round like the original implementation did: 4 decimal places. */
function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * bpm → cycles per second. `quarterNotesPerCycle` is how many quarter notes one
 * Strudel cycle spans (4 = one 4/4 bar per cycle, Strudel's default feel).
 */
export function bpmToCps(bpm: number, quarterNotesPerCycle = 4): number {
  return round4(bpm / 60 / quarterNotesPerCycle);
}

/** bpm → cycles per minute, the unit `setcpm` takes. */
function bpmToCpm(bpm: number, quarterNotesPerCycle = 4): number {
  return round4(bpm / quarterNotesPerCycle);
}

interface Occurrence {
  name: string;
  /** Index of the `(` that immediately follows the identifier, or -1. */
  callParenIndex: number;
  parenDepth: number;
  braceDepth: number;
  bracketDepth: number;
  /** Identifier sits where a statement can start (not mid-expression). */
  statementStart: boolean;
  /** Identifier is a property access (`x.setcps`). */
  member: boolean;
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

/**
 * Keywords after which a `/` starts a regex literal rather than a division.
 * Only the ones plausible in pattern code; the list is a heuristic, and a
 * wrong guess degrades to "ambiguous", never to a corrupted rewrite.
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

function skipStringLiteral(code: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < code.length) {
    const c = code[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    if (c === "\n") return i; // unterminated — bail at the line end
    i++;
  }
  return i;
}

function skipRegexLiteral(code: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < code.length) {
    const c = code[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "\n") return i; // unterminated — bail
    if (inClass) {
      if (c === "]") inClass = false;
    } else if (c === "[") {
      inClass = true;
    } else if (c === "/") {
      i++;
      break;
    }
    i++;
  }
  while (i < code.length && /[A-Za-z]/.test(code[i])) i++;
  return i;
}

/** Skip whitespace and comments starting at `i`; returns the next code index. */
function skipTrivia(code: string, i: number): number {
  while (i < code.length) {
    const c = code[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\f" || c === "\v") {
      i++;
      continue;
    }
    if (c === "/" && code[i + 1] === "/") {
      while (i < code.length && code[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end === -1 ? code.length : end + 2;
      continue;
    }
    return i;
  }
  return i;
}

/**
 * Lexical scan for `setcps`/`setcpm` identifiers, recording where each one sits
 * so the caller can tell a real top-level setter from a look-alike. Comments,
 * strings, regex literals and template text are skipped; template `${…}` bodies
 * ARE scanned (as nested code, so a setter inside one reads as ambiguous).
 */
function findOccurrences(code: string): Occurrence[] {
  const found: Occurrence[] = [];
  const n = code.length;
  let i = 0;
  let paren = 0;
  let brace = 0;
  let bracket = 0;
  // Last significant token, enough to disambiguate `/` and spot statement starts.
  let prevKind: "none" | "value" | "keyword" | "punct" = "none";
  let prevText = "";
  let sawNewline = true; // start of file is a statement position
  const templateBraces: number[] = [];
  let mode: "code" | "template" = "code";

  while (i < n) {
    const c = code[i];

    if (mode === "template") {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        mode = "code";
        prevKind = "value";
        prevText = "`";
        sawNewline = false;
        i++;
        continue;
      }
      if (c === "$" && code[i + 1] === "{") {
        brace++;
        templateBraces.push(brace);
        mode = "code";
        prevKind = "punct";
        prevText = "{";
        sawNewline = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (c === "\n") {
      sawNewline = true;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v") {
      i++;
      continue;
    }
    if (c === "/" && code[i + 1] === "/") {
      while (i < n && code[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      if (code.lastIndexOf("\n", stop - 1) >= i) sawNewline = true;
      i = stop;
      continue;
    }
    if (c === "/" && regexAllowed(prevKind, prevText)) {
      i = skipRegexLiteral(code, i);
      prevKind = "value";
      prevText = "/";
      sawNewline = false;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipStringLiteral(code, i, c);
      prevKind = "value";
      prevText = c;
      sawNewline = false;
      continue;
    }
    if (c === "`") {
      mode = "template";
      i++;
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < n && IDENT_PART.test(code[j])) j++;
      const word = code.slice(i, j);
      if (TEMPO_NAMES.has(word)) {
        const after = skipTrivia(code, j);
        found.push({
          name: word,
          callParenIndex: code[after] === "(" ? after : -1,
          parenDepth: paren,
          braceDepth: brace,
          bracketDepth: bracket,
          statementStart:
            prevKind === "none" || prevText === ";" || prevText === "}" || sawNewline,
          member: prevText === ".",
        });
      }
      prevKind = REGEX_PRECEDING_KEYWORDS.has(word) ? "keyword" : "value";
      prevText = word;
      sawNewline = false;
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(code[i + 1] ?? ""))) {
      let j = i;
      while (j < n && /[0-9A-Za-z_.]/.test(code[j])) j++;
      prevKind = "value";
      prevText = "0";
      sawNewline = false;
      i = j;
      continue;
    }

    if (c === "(") paren++;
    else if (c === ")") paren = Math.max(0, paren - 1);
    else if (c === "[") bracket++;
    else if (c === "]") bracket = Math.max(0, bracket - 1);
    else if (c === "{") brace++;
    else if (c === "}") {
      if (templateBraces.length > 0 && templateBraces[templateBraces.length - 1] === brace) {
        templateBraces.pop();
        brace--;
        mode = "template";
        i++;
        continue;
      }
      brace = Math.max(0, brace - 1);
    }
    prevKind = "punct";
    prevText = c;
    sawNewline = false;
    i++;
  }

  return found;
}

function regexAllowed(
  prevKind: "none" | "value" | "keyword" | "punct",
  prevText: string,
): boolean {
  if (prevKind === "none" || prevKind === "keyword") return true;
  if (prevKind === "value") return false;
  return prevText !== ")" && prevText !== "]";
}

/** Index just past the matching `)` for the `(` at `open`, or -1 if unbalanced. */
function matchParen(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const PURE_NUMERIC = /^[\s0-9.+\-*/%()]*$/;

function isPureNumeric(argument: string): boolean {
  if (!PURE_NUMERIC.test(argument)) return false;
  if (!/[0-9]/.test(argument)) return false;
  // `//` and `/*` are comment starts, not division — refuse to reason about them.
  if (argument.includes("//") || argument.includes("/*")) return false;
  return true;
}

/**
 * Where a prepended `setcps(...)` line must go: after a `#!` shebang line and
 * after a `"use strict"`-style directive prologue, otherwise index 0.
 */
function insertionIndex(code: string): number {
  let at = 0;
  if (code.startsWith("#!")) {
    const eol = code.indexOf("\n");
    if (eol === -1) return code.length;
    at = eol;
  }
  for (;;) {
    const start = skipTrivia(code, at);
    const quote = code[start];
    if (quote !== '"' && quote !== "'") return at;
    const end = skipStringLiteral(code, start, quote);
    if (code[end - 1] !== quote) return at; // unterminated
    const content = code.slice(start + 1, end - 1);
    // Only classic directives ("use strict", "use asm"), so an expression that
    // merely starts with a string literal is never split apart.
    if (!content.startsWith("use ")) return at;
    const next = skipTrivia(code, end);
    if (code[next] === ";") at = next + 1;
    else if (next >= code.length || code.lastIndexOf("\n", next) >= end) at = end;
    else return at; // string is part of a larger expression
  }
}

function prepend(code: string, cps: number): string {
  const line = `setcps(${cps})\n`;
  let at = insertionIndex(code);
  if (at === 0) return line + code;
  // Land on a line boundary so the inserted call always gets its own line and
  // never fuses with the prologue's trailing code.
  while (at < code.length && (code[at] === " " || code[at] === "\t" || code[at] === "\r")) {
    at++;
  }
  if (code[at] === "\n") return code.slice(0, at + 1) + line + code.slice(at + 1);
  return `${code.slice(0, at)}\n${line}${code.slice(at)}`;
}

/**
 * Apply `bpm` to a Strudel pattern. See the policy block at the top of this
 * file — the returned `policy` says which branch was taken.
 */
export function injectTempo(
  code: string,
  bpm: number,
  quarterNotesPerCycle = 4,
): TempoResult {
  const qpc =
    Number.isFinite(quarterNotesPerCycle) && quarterNotesPerCycle > 0
      ? quarterNotesPerCycle
      : 4;
  const cps = bpmToCps(bpm, qpc);

  if (typeof code !== "string" || !Number.isFinite(bpm) || bpm <= 0) {
    return { code, policy: "inserted-ambiguous", cps };
  }
  if (code.length > MAX_SCAN_LENGTH) {
    return { code: prepend(code, cps), policy: "inserted-ambiguous", cps };
  }

  const occurrences = findOccurrences(code);
  if (occurrences.length === 0) {
    return { code: prepend(code, cps), policy: "inserted", cps };
  }

  const only = occurrences.length === 1 ? occurrences[0] : null;
  const isTopLevelSetter =
    only !== null &&
    only.callParenIndex >= 0 &&
    !only.member &&
    only.statementStart &&
    only.parenDepth === 0 &&
    only.braceDepth === 0 &&
    only.bracketDepth === 0;

  if (!isTopLevelSetter) {
    return { code: prepend(code, cps), policy: "inserted-ambiguous", cps };
  }

  const close = matchParen(code, only.callParenIndex);
  if (close === -1) {
    return { code: prepend(code, cps), policy: "inserted-ambiguous", cps };
  }
  const argument = code.slice(only.callParenIndex + 1, close);
  if (!isPureNumeric(argument)) {
    return { code: prepend(code, cps), policy: "inserted-ambiguous", cps };
  }

  const value = only.name === "setcpm" ? bpmToCpm(bpm, qpc) : cps;
  const rewritten =
    code.slice(0, only.callParenIndex + 1) + String(value) + code.slice(close);
  return { code: rewritten, policy: "replaced", cps };
}
