/**
 * @file Pure helpers for the sheet-music widget's in-widget ABC editor.
 *
 * Kept dependency-free (no abcjs, no DOM) so the widget's edit path can be
 * unit-tested in the plain `node` vitest environment — `src/mcp-app.ts` itself
 * touches `document` at import time and pulls in CSS, so it can't be imported
 * from a test.
 *
 * ## Raw vs. effective ABC
 *
 * The widget stores the user's ABC *raw* in `state.currentAbc` and only derives
 * the effective score at render time via `applyStyleToAbc(raw, style)`, which
 * inserts the style preset's `%%MIDI` block after the `K:` header. Nothing is
 * ever written back into the raw text, so the editor can show `state.currentAbc`
 * verbatim — no splitting, no "this isn't quite what you wrote" hint needed.
 * Transposition is the deliberate exception: `transposeAbc()` rewrites the
 * notation itself (notes *and* key signature), so the transposed text *is* the
 * user's score and is what they should be editing.
 */

/** Barline tokens, longest first so `|:` never splits as `|` + `:`. */
const BARLINE = /\[\||\|\]|\|\||::|:\||\|:|\|/;

/** Anything that occupies time in a measure: pitches and ordinary rests. */
const HAS_MUSIC = /[A-Ga-gxz]/;

/**
 * `Z4` is a MULTIMEASURE rest: one token standing for four whole bars. Counting
 * it as one measure under-reported every tune that uses one (`Z4 | C8 |` is
 * five bars, not two), so the count the widget reports to the model disagreed
 * with the score on screen.
 */
const MULTIMEASURE = /Z(\d*)/g;

/** Bars a segment spans: `Z`-rests expanded, plus one for any other music. */
function measuresIn(part: string): number {
  let rests = 0;
  MULTIMEASURE.lastIndex = 0;
  const rest = part.replace(MULTIMEASURE, (_m, digits: string) => {
    rests += digits.length > 0 ? Number(digits) : 1;
    return " ";
  });
  return rests + (HAS_MUSIC.test(rest) ? 1 : 0);
}

/** Split a body line at every inline `[V:n]`, tagging each part with its voice. */
const INLINE_VOICE = /\[V:\s*([^\]\s]+)[^\]]*\]/g;

/**
 * abcjs emits warnings as HTML fragments (`<span class="...">`). Flatten them
 * to plain strings suitable for a text node.
 */
export function cleanAbcWarnings(warnings: unknown): string[] {
  if (!Array.isArray(warnings)) return [];
  return warnings
    .map((w) =>
      String(w)
        .replace(/<[^>]*>/g, "")
        .trim(),
    )
    .filter((w) => w.length > 0);
}

/**
 * The same forgiving rule the server uses (`src/server-logic.ts`): abcjs warns
 * about plenty of things that still play, so only "Expected"/"Unknown"/"Error"
 * count as fatal. Everything else is surfaced but rendered anyway.
 */
export function hasFatalAbcWarning(messages: readonly string[]): boolean {
  return messages.some(
    (message) =>
      message.includes("Expected") ||
      message.includes("Unknown") ||
      message.includes("Error"),
  );
}

export interface AbcShape {
  /** Measures in the longest voice (voices are counted separately). */
  bars: number;
  /** The tune's first `K:` value, e.g. `"G"` or `"D dorian"`. */
  key: string | null;
}

/** Strip everything that isn't a note or a barline from one body line. */
function stripNonMusic(line: string): string {
  return line
    .replace(/%.*$/, "") // trailing comment
    .replace(/"[^"]*"/g, "") // chord symbols / annotations
    .replace(/\[[A-Za-z]:[^\]]*\]/g, "") // inline fields, e.g. [K:G]
    .replace(/![^!\n]*!/g, "") // decorations
    .replace(/\{[^}]*\}/g, ""); // grace notes
}

/**
 * Describe an ABC tune well enough to tell the model what changed: how many
 * bars it has and what key it is in.
 *
 * Bars are counted per voice (a two-voice tune has the bars of one voice, not
 * the sum), and a measure that continues across a line break is counted once.
 */
export function describeAbc(abc: string): AbcShape {
  let key: string | null = null;
  let inBody = false;
  let voice = "";
  const voices = new Map<string, { count: number; open: boolean }>();

  const voiceState = (name: string) => {
    let v = voices.get(name);
    if (!v) {
      v = { count: 0, open: false };
      voices.set(name, v);
    }
    return v;
  };

  for (const rawLine of abc.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("%")) continue;

    const header = /^([A-Za-z]):\s*(.*)$/.exec(line);
    if (header) {
      const [, field, value] = header;
      if (field === "K") {
        if (key === null) key = value.trim();
        inBody = true;
      } else if (field === "V") {
        voice = value.trim().split(/\s+/)[0] ?? "";
      }
      continue;
    }

    if (!inBody) continue;

    // A body line may switch voices inline, more than once:
    // `[V:1] C D E F | [V:2] C,4 |`. Handling only a switch at the START of the
    // line put the second voice's bars on the first voice's counter, so two
    // one-bar voices on one line reported two bars instead of one.
    const segments: { voice: string; text: string }[] = [];
    let cursor = 0;
    INLINE_VOICE.lastIndex = 0;
    for (
      let match = INLINE_VOICE.exec(line);
      match;
      match = INLINE_VOICE.exec(line)
    ) {
      segments.push({ voice, text: line.slice(cursor, match.index) });
      voice = match[1]!;
      cursor = match.index + match[0].length;
    }
    segments.push({ voice, text: line.slice(cursor) });

    for (const segment of segments) {
      const v = voiceState(segment.voice);
      const parts = stripNonMusic(segment.text).split(BARLINE);
      for (let i = 0; i < parts.length; i++) {
        const measures = measuresIn(parts[i]!);
        if (measures > 0) {
          // An already-open measure is the one this segment continues, so it is
          // only counted once; every measure beyond the first is new.
          v.count += v.open ? measures - 1 : measures;
          v.open = true;
        }
        // A barline followed this segment, so its measure is closed.
        if (i < parts.length - 1) v.open = false;
      }
    }
  }

  let bars = 0;
  for (const v of voices.values()) bars = Math.max(bars, v.count);
  return { bars, key };
}

/**
 * One honest sentence for `ui/update-model-context` after an edit lands, so the
 * model knows the score it proposed is no longer the score on screen.
 */
export function editContextText(abc: string): string {
  const { bars, key } = describeAbc(abc);
  const barPart = `${bars} bar${bars === 1 ? "" : "s"}`;
  const keyPart = key ? `, key ${key}` : "";
  return (
    `Sheet-music widget: user edited the ABC (${barPart}${keyPart}). ` +
    `The edited notation is what is now displayed, played and exported; ` +
    `the widget's send-to-chat button will paste the exact text.`
  );
}
