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
 * converted and then either *written into* the pattern's existing tempo call,
 * *prepended* as a new one, or *left alone* when touching the source would be
 * unsafe. The old implementation did that with
 * `code.replace(/setcps\s*\([^)]*\)/, ...)`, which corrupts nested parens
 * (`setcps(120 / (60 * 4))` → `setcps(0.5))`, a syntax error that silently
 * kills the pattern) and also matches inside comments and strings.
 *
 * The policy implemented here, in order:
 *
 * | policy | when | what happens to `code` |
 * | --- | --- | --- |
 * | `"replaced"` | exactly ONE tempo setter, at a *real* top-level statement position (see below), not a member access, depth 0 everywhere, and its single argument is a pure numeric expression | the argument text is replaced in place; every other byte is preserved |
 * | `"inserted"` | no `setcps`/`setcpm` identifier anywhere outside comments, strings and regex literals | `setcps(<cps>);\n` is prepended (after a `#!` line or a `"use …"` directive prologue) |
 * | `"unchanged-ambiguous"` | the name is locally **bound** (`const/let/var/function/class setcps`) or **aliased** / referenced without a call (`const t = setcps`) | **nothing** — `code` is returned byte for byte. Prepending here is not safe: a `const setcps` binding puts the prepended call in that binding's temporal dead zone (`ReferenceError`), and a bare reference means the pattern is doing something with the setter we cannot model. The caller applies `cps` at runtime instead (`editor.repl.setCps(cps)`). |
 * | `"inserted-ambiguous"` | anything else: multiple setters, a setter nested in a function/call/bracket/template expression, a conditional setter (`if (x)\n setcps(…)`), a labelled or assigned setter, a member `.setcps(`, or a non-numeric/effectful argument such as `setcps(getTempo())` | nothing is rewritten in place; `setcps(<cps>);\n` is prepended so the requested tempo still applies unless the pattern's own later call overrides it at runtime |
 *
 * Rationale: never silently discard a pattern's intentional tempo changes, and
 * never emit a program that fails to parse or throw. A prepended line is safe
 * *except* against a local binding of the same name, which is exactly what
 * `"unchanged-ambiguous"` carves out.
 *
 * ### Why the inserted line ends in `;`
 *
 * `setcps(0.5)` with no terminator does not reliably start a new statement:
 * automatic semicolon insertion will not separate it from a following IIFE or
 * array literal, so `setcps(0.5)\n(() => note(60))()` parses as a *call on the
 * result of `setcps`*. Every emitted setter line therefore ends with an
 * explicit `;` — the `setcps` form here, and the `setcpm` form the same way if
 * a future branch ever emits one.
 *
 * ### What counts as a top-level statement position
 *
 * A newline alone is not enough — `if (false)\n  setcps(0.25);` sits on its own
 * line but never executes, so rewriting its argument silently does nothing. A
 * setter is treated as top-level only when the previous significant token
 * (whitespace and comments ignored) is one of:
 *
 * - start of file,
 * - `;`,
 * - `}`, or
 * - a line end whose preceding token cannot continue a statement — i.e. NOT
 *   `=` `,` `(` `[` `{` `?` `:` `.` or a binary/unary operator, NOT `=>`, NOT a
 *   keyword like `else` / `do` / `return` / `new` / `await`, and NOT the `)`
 *   that closes an `if` / `for` / `while` / `switch` / `catch` / `with` header.
 *
 * Anything in doubt degrades to `"inserted-ambiguous"`, never to a rewrite.
 *
 * A "pure numeric argument" is digits, `.`, whitespace and `+ - * / % ( )`
 * only, containing at least one digit and no comment marker. Anything else is
 * treated as ambiguous.
 *
 * Inputs longer than 65536 characters skip the scan entirely and take the
 * prepend path (`"inserted-ambiguous"`).
 *
 * Callers gate on `if (bpm)`. If `bpm` is not a finite number greater than
 * zero, the code is returned untouched (policy `"unchanged-ambiguous"`, meaning
 * "no rewrite happened"). `cps` is always returned so a caller can apply the
 * tempo through Strudel's runtime API regardless of which branch was taken.
 */

/** Which branch of the policy table above produced a `TempoResult`. */
export type TempoPolicy =
  | "inserted"
  | "replaced"
  | "inserted-ambiguous"
  | "unchanged-ambiguous";

export interface TempoResult {
  /** The pattern source after the policy was applied (byte-identical to the input for `"unchanged-ambiguous"`). */
  code: string;
  /** Which branch of the policy above produced `code`. */
  policy: TempoPolicy;
  /**
   * Cycles per second the requested bpm maps to, rounded to 4 decimals.
   * Always returned — for `"unchanged-ambiguous"` it is the ONLY way the tempo
   * reaches the pattern, so the caller must apply it at runtime
   * (`editor.repl.setCps(cps)`).
   */
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
  /**
   * Identifier is the *bound name* of a local declaration —
   * `const/let/var/function/class setcps`. Prepending a call would then land in
   * that binding's temporal dead zone (or call the user's own function).
   */
  binding: boolean;
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

/**
 * Punctuation that cannot end a statement. If one of these is the last
 * significant token before a line break, the next line CONTINUES the same
 * construct, so an identifier there is not at a statement position.
 * (`>` also covers the tail of `=>`, since the scanner reads punctuation one
 * character at a time.)
 */
const CONTINUATION_PUNCT = new Set([
  "=", "+", "-", "*", "/", "%", "<", ">", "&", "|", "^", "~", "!",
  "?", ":", ",", "(", "[", "{", ".",
]);

/** Keywords that cannot end a statement either. */
const CONTINUATION_KEYWORDS = new Set([
  "else",
  "do",
  "try",
  "finally",
  "return",
  "case",
  "default",
  "new",
  "typeof",
  "void",
  "delete",
  "yield",
  "await",
  "throw",
  "in",
  "of",
  "instanceof",
  "extends",
]);

/**
 * Keywords whose `(` opens a *header*, not a call. The `)` that closes one is
 * followed by the controlled statement — `if (false)\n setcps(0.25);` — so that
 * `)` must NOT read as "the previous statement ended".
 */
const CONTROL_HEADER_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "with",
]);

/** Keywords that introduce a binding whose name is the following identifier. */
const DECLARATION_KEYWORDS = new Set(["const", "let", "var", "function", "class"]);

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
  // Whether the `(` at each open paren depth started an `if`/`for`/`while`/…
  // header rather than a call or a grouping.
  const parenIsControlHeader: boolean[] = [];
  // Only meaningful while `prevText === ")"`: did that `)` close such a header?
  let closedControlHeader = false;
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
        closedControlHeader = false;
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
        closedControlHeader = false;
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
      closedControlHeader = false;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipStringLiteral(code, i, c);
      prevKind = "value";
      prevText = c;
      sawNewline = false;
      closedControlHeader = false;
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
          statementStart: atStatementPosition(
            prevKind,
            prevText,
            sawNewline,
            closedControlHeader,
          ),
          member: prevText === ".",
          binding: DECLARATION_KEYWORDS.has(prevText),
        });
      }
      prevKind = REGEX_PRECEDING_KEYWORDS.has(word) ? "keyword" : "value";
      prevText = word;
      sawNewline = false;
      closedControlHeader = false;
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(code[i + 1] ?? ""))) {
      let j = i;
      while (j < n && /[0-9A-Za-z_.]/.test(code[j])) j++;
      prevKind = "value";
      prevText = "0";
      sawNewline = false;
      closedControlHeader = false;
      i = j;
      continue;
    }

    closedControlHeader = false;
    if (c === "(") {
      parenIsControlHeader.push(CONTROL_HEADER_KEYWORDS.has(prevText));
      paren++;
    } else if (c === ")") {
      closedControlHeader = parenIsControlHeader.pop() ?? false;
      paren = Math.max(0, paren - 1);
    } else if (c === "[") bracket++;
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

/**
 * Is an identifier at this point a *statement*, rather than a fragment of the
 * construct on the line above? See "What counts as a top-level statement
 * position" in the policy block. A newline on its own is not enough: an `if`
 * header, an `else`, an `=>`, an assignment or any dangling operator all carry
 * the statement across the break, and a setter in that position never runs
 * unconditionally, so its argument must not be rewritten.
 */
function atStatementPosition(
  prevKind: "none" | "value" | "keyword" | "punct",
  prevText: string,
  sawNewline: boolean,
  closedControlHeader: boolean,
): boolean {
  if (prevKind === "none") return true; // start of file (comments already skipped)
  if (prevText === ";" || prevText === "}") return true;
  if (!sawNewline) return false;
  if (prevKind === "punct" && CONTINUATION_PUNCT.has(prevText)) return false;
  if (CONTINUATION_KEYWORDS.has(prevText)) return false;
  // `if (…)` / `for (…)` / `while (…)` headers govern the next statement.
  if (prevText === ")" && closedControlHeader) return false;
  return true;
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
 * Characters that CONTINUE the expression above rather than beginning a new
 * statement, even across a newline: member access, a call, an index, a tagged
 * template, and every binary/ternary operator that can lead a continuation line.
 *
 * `!`, `~` and `{` are deliberately absent — each can only *start* something,
 * so a newline before one is a real statement boundary (ASI inserts there).
 */
const EXPRESSION_CONTINUATION_STARTS = new Set([
  ".", "(", "[", "`", ",", "?", ":", "=",
  "+", "-", "*", "/", "%", "<", ">", "&", "|", "^",
]);

/** Word operators that can only appear mid-expression. */
const CONTINUATION_WORD_RE = /^(?:instanceof|in)\b/;

/**
 * Is the token at `i` a continuation of the expression before it?
 *
 * A directive prologue ends at a newline ONLY when what follows starts a new
 * statement. `'use strict'\n.trim();` is a single member expression the newline
 * does not terminate, and inserting `setcps(…);` into the middle of it was a
 * SyntaxError (the audit's case: `'use strict'\nsetcps(0.5);\n.trim();`).
 */
function continuesExpression(code: string, i: number): boolean {
  if (i >= code.length) return false;
  if (EXPRESSION_CONTINUATION_STARTS.has(code[i])) return true;
  return CONTINUATION_WORD_RE.test(code.slice(i, i + 11));
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
    else if (next >= code.length) at = end;
    // A newline ends the directive only if the next significant token starts a
    // statement of its own. `.`/`(`/`[`/an operator carries the expression over
    // the break, and splitting THAT is a SyntaxError.
    else if (code.lastIndexOf("\n", next) >= end && !continuesExpression(code, next)) {
      at = end;
    } else return at; // string is part of a larger expression
  }
}

/**
 * The one place a tempo setter line is emitted. The trailing `;` is load
 * bearing: without it ASI does not separate the call from a following IIFE or
 * array literal (`setcps(0.5)\n(() => note(60))()` parses as a call on
 * `setcps`'s return value). Kept as a helper so any future `setcpm` emission
 * inherits the same terminator.
 */
function setterLine(name: "setcps" | "setcpm", value: number): string {
  return `${name}(${value});\n`;
}

function prepend(code: string, cps: number): string {
  const line = setterLine("setcps", cps);
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
    return { code, policy: "unchanged-ambiguous", cps };
  }
  if (code.length > MAX_SCAN_LENGTH) {
    return { code: prepend(code, cps), policy: "inserted-ambiguous", cps };
  }

  const occurrences = findOccurrences(code);
  if (occurrences.length === 0) {
    return { code: prepend(code, cps), policy: "inserted", cps };
  }

  // A local binding of the name (`const setcps = ...`) would put a prepended
  // call in that binding's temporal dead zone; a bare non-call reference
  // (`const t = setcps`, `const { setcps } = ...`, a parameter named `setcps`)
  // means the pattern is doing something with the setter we cannot model.
  // Either way the source is left alone, and the caller applies `cps` through
  // the runtime API.
  const shadowedOrAliased = occurrences.some(
    (occurrence) =>
      occurrence.binding || (occurrence.callParenIndex === -1 && !occurrence.member),
  );
  if (shadowedOrAliased) {
    return { code, policy: "unchanged-ambiguous", cps };
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
