/**
 * Pulls the complete, runnable example blocks out of a guide topic.
 *
 * The guides are prose + code, not fenced markdown, so "what is an example?"
 * has to be decided structurally:
 *
 *   - a block STARTS at a line whose first non-space text begins with one of
 *     START_TOKENS;
 *   - it absorbs following lines while brackets are unbalanced, the line is
 *     indented, or the line continues a chain (`.foo()`, `)`, `,`, `//`);
 *   - a new UNINDENTED start token at bracket depth 0 begins a NEW block,
 *     unless the block so far is only tempo/setup preamble or declares names
 *     the rest of it uses;
 *   - reference lines pair code with an aligned description
 *     (`s("hh*8")              eighth notes`). Two or more spaces outside a
 *     string, followed by something that is not a chain continuation, is the
 *     prose column — cut there if that makes the block parse;
 *   - whatever is left must PARSE as JavaScript. `stack(pat1, pat2)` parses
 *     but names placeholders; the caller classifies those. Anything that does
 *     not parse is prose with a code-shaped prefix, and is a fragment.
 */

/** A line starting with one of these opens an example block. */
const START_TOKENS = [
  "setcps(",
  "setcpm(",
  "stack(",
  "note(",
  "sound(",
  "s(",
  "n(",
  "arrange(",
  "let ",
  "const ",
  "await initHydra",
];

/**
 * Setup preamble: never splits a block and never stands alone as an example
 * (a lone `setcps(0.5)` has no pattern to be silent about).
 */
const PREAMBLE = /^(set(cps|cpm)\(|await initHydra)/;

export interface GuideBlock {
  readonly topic: string;
  /** 1-based line number of the block's first line, within the topic text. */
  readonly line: number;
  readonly code: string;
  /** Nearest preceding `## `/`### ` heading, for test names. */
  readonly heading: string;
}

const startsBlock = (line: string) =>
  START_TOKENS.some((t) => line.trimStart().startsWith(t));

const continues = (line: string) =>
  /^\s/.test(line) || /^[.)\],]/.test(line) || line.startsWith("//");

/** Bracket depth of `code`, ignoring brackets inside strings and comments. */
export function depthOf(code: string): number {
  let depth = 0;
  let inString: string | undefined;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === inString) inString = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") inString = ch;
    else if (ch === "/" && code[i + 1] === "/") {
      const nl = code.indexOf("\n", i);
      if (nl === -1) break;
      i = nl;
    } else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
  }
  return depth;
}

/** Does this text parse as JavaScript? Fragments and prose lines do not. */
export function parses(code: string): boolean {
  try {
    // eslint-disable-next-line no-new-func
    new Function(`async () => {\n${code}\n}`);
    return true;
  } catch {
    return false;
  }
}

/** Offsets of the "prose column" candidates on one line, rightmost first. */
function proseCuts(line: string): number[] {
  const cuts: number[] = [];
  let inString: string | undefined;
  const indent = line.length - line.trimStart().length;
  for (let i = indent; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === inString) inString = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === " " && line[i + 1] === " ") {
      const rest = line.slice(i).trimStart();
      // `.foo()` / `)` / `,` / `//` continue the code, they are not prose.
      if (rest && !/^[.)\],]/.test(rest) && !rest.startsWith("//")) cuts.push(i);
      while (line[i + 1] === " ") i++;
    }
  }
  return cuts.reverse();
}

/** Drop aligned descriptions until the block parses; give up unchanged. */
function stripProse(code: string): string {
  if (parses(code)) return code;
  const lines = code.split("\n");
  for (let li = lines.length - 1; li >= 0; li--) {
    for (const cut of proseCuts(lines[li])) {
      const candidate = [...lines];
      candidate[li] = lines[li].slice(0, cut);
      const joined = stripProse(candidate.join("\n"));
      if (parses(joined)) return joined;
    }
  }
  return code;
}

const hasDeclaration = (code: string) => /^\s*(let|const|var)\s/m.test(code);
const isOnlyPreamble = (lines: string[]) =>
  lines.every(
    (l) =>
      PREAMBLE.test(l.trimStart()) ||
      l.trim() === "" ||
      l.trim().startsWith("//"),
  );

export function extractBlocks(topic: string, text: string): GuideBlock[] {
  const lines = text.split("\n");
  const blocks: GuideBlock[] = [];
  let heading = "";
  let cur: string[] = [];
  let curLine = 0;
  let curHeading = "";

  const flush = () => {
    if (cur.length && !isOnlyPreamble(cur)) {
      const code = stripProse(cur.join("\n").replace(/\s+$/, ""));
      if (code.trim()) {
        blocks.push({ topic, line: curLine, code, heading: curHeading });
      }
    }
    cur = [];
  };

  for (let i = 0; i < lines.length; i++) {
    // `  Example: s("bd").euclid(3,8)  tresillo` — the label is prose, the
    // rest is a real one-liner worth running.
    const line = lines[i].replace(/\s+$/, "").replace(/^(\s*)Example:\s+/, "$1");

    if (/^#{1,6}\s/.test(line)) {
      flush();
      heading = line.replace(/^#+\s*/, "");
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }

    if (cur.length) {
      const depth = depthOf(cur.join("\n"));
      const opensNew =
        depth === 0 &&
        startsBlock(line) &&
        !PREAMBLE.test(line.trimStart()) &&
        !hasDeclaration(cur.join("\n")) &&
        !isOnlyPreamble(cur) &&
        // An indented start token usually continues the chain above; only
        // treat it as a new example when what came before already stands alone.
        (!/^\s/.test(line) || parses(stripProse(cur.join("\n"))));
      if (opensNew) {
        flush();
        curLine = i + 1;
        curHeading = heading;
        cur.push(line);
        continue;
      }
      if (depth > 0 || continues(line) || startsBlock(line)) {
        cur.push(line);
        continue;
      }
      flush(); // prose after a complete block
      continue;
    }

    if (startsBlock(line)) {
      curLine = i + 1;
      curHeading = heading;
      cur.push(line);
    }
  }
  flush();

  return withTopicDeclarations(blocks, text);
}

/**
 * A guide recipe can declare a name in one block and use it in the next
 * (`const seq = "..."` beside the Hydra chain, `n(seq)` under it — the reader
 * pastes the whole recipe). Re-attach any single-line declaration a block uses
 * but does not make, so blocks are evaluated the way they are meant to be run.
 * Without this, `seq`/`pulse` silently resolve to Strudel's own globals.
 */
const DECLARATION = /^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*.+$/;

function withTopicDeclarations(blocks: GuideBlock[], text: string): GuideBlock[] {
  const decls = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const m = DECLARATION.exec(trimmed);
    if (m && depthOf(trimmed) === 0) decls.set(m[1], trimmed);
  }
  if (decls.size === 0) return blocks;
  return blocks.map((b) => {
    const own = new Set<string>();
    for (const line of b.code.split("\n")) {
      const m = DECLARATION.exec(line.trim());
      if (m) own.add(m[1]);
    }
    const needed = [...decls]
      .filter(([name]) => !own.has(name))
      .filter(([name]) => new RegExp(`\\b${name}\\b`).test(b.code))
      .map(([, line]) => line);
    return needed.length ? { ...b, code: `${needed.join("\n")}\n${b.code}` } : b;
  });
}
