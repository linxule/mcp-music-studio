/**
 * @file Which instrument the score itself gives its first voice, and how to
 *       override it — pure, DOM-free and abcjs-free (the worker imports it).
 *
 * The widget's Instrument menu passes its choice to abcjs as the `program`
 * synth option. abcjs treats that as the starting instrument only: a tune's
 * own `%%MIDI program N` wins as soon as the sequencer reaches it
 * (abc_midi_sequencer.js). The ABC guide teaches `%%MIDI program`, so without
 * help the menu does nothing in the common case (issue #25). This module finds
 * the directive that decides the first voice's opening instrument, so the
 * widget can show it, and rewrites that directive when the user picks another.
 *
 * ## abcjs's scoping, as measured against 6.7.1
 *
 * `parseMidiCommand` (parse/abc_parse_directive.js) files a directive in one of
 * two places, depending on `tuneBuilder.hasBeginMusic()`: whether any staff
 * line exists yet.
 *
 *  - **Global** (`tune.formatting.midi.program`) before music starts. That
 *    covers the header, the body before its first music line, and inline
 *    `[I:MIDI program N]` fields that open the first music line. Last one wins.
 *    The sequencer gives every voice this program at its start. A two-argument
 *    `%%MIDI program <channel> <n>` plays `<n>`.
 *  - **Voice-scoped** (an inline element on the current voice) once music has
 *    started. A body `V:` line starts music by itself (parseHeader returns
 *    `newline`), so the guide's
 *    `V:1` / `%%MIDI program 73` / notes pattern is voice-scoped. abcjs reads
 *    `params[0]` only, so an inline `%%MIDI program 2 42` plays program 2.
 *
 * Voices declared in the header (`V:1` … `V:2` … `K:`) are therefore NOT
 * separate: their `%%MIDI program` lines are all global, the last one wins,
 * and every voice plays it. This module reports what abcjs plays, not what
 * the author meant.
 *
 * "First voice" is abcjs's voice 0: the first voice named in `%%score` /
 * `%%staves` if there is one, else the first `V:` id in the tune (header or
 * body), else the unnamed default voice. A voice-scoped program is "leading"
 * only while that voice has no note or rest yet. A later one is a deliberate
 * mid-tune change and is left alone.
 *
 * Deliberately outside the model: `%%MIDI channel 10` and percussion clefs,
 * `%%MIDI bagpipes`, tunes that put music before the first `V:` of a
 * multi-voice score (abcjs itself scrambles voices there), and malformed
 * `%%MIDI program` lines (abcjs's parser rejects those as errors before
 * anything plays). `tests/abc-program.test.ts` checks this model against the
 * real sequencer over the guide's templates and every layout above.
 */
import { INSTRUMENTS, applyStyleToAbc } from "./music-logic.js";

/** The directive that sets the first voice's opening instrument. */
export interface LeadingProgram {
  /** The GM program abcjs gives the first voice's first note. */
  program: number;
  /** Header/pre-music (applies to every voice) vs. the first voice only. */
  scope: "global" | "voice";
  /** The directive as written, e.g. `%%MIDI program 73`. */
  directive: string;
  /** Span of the argument text an override replaces. */
  replaceStart: number;
  replaceEnd: number;
}

/** Header fields abcjs parses as fields; any other `X:` line is music. */
const KNOWN_FIELDS = new Set("ABCDFGINORSWZHKLMPQTUVswXEm");

// abcjs lowercases the directive name (`%%midi` works) but compares the MIDI
// sub-command as written (parse_directive.js parseMidiCommand), so
// `%%MIDI PROGRAM 73` is filed under "PROGRAM" and never played.
const DIRECTIVE_RE =
  /^%%\s*[Mm][Ii][Dd][Ii]\s*=?\s*program\s+(-?\d+)(?:\s+(-?\d+))?\s*(?:%.*)?$/;
const INLINE_FIELD_RE = /^\[([A-Za-z]):([^\]]*)\]/;
const INLINE_PROGRAM_RE =
  /^\[I:\s*[Mm][Ii][Dd][Ii]\s*=?\s*program\s+(-?\d+)(?:\s+(-?\d+))?\s*\]/;
const SCORE_RE = /^%%\s*(?:score|staves)\b(.*)$/i;
/** Blocks abcjs consumes whole as text / PostScript, never as music or MIDI. */
const BLOCK_RE = /^%%\s*begin(text|ps)\b/i;
const NOTE_CHARS = /[A-Ga-gzZxX]/;

interface ProgramArgs {
  /** First integer and its absolute span. */
  first: { value: number; start: number; end: number };
  second?: { value: number; start: number; end: number };
}

/** Locate the one or two integer arguments of a matched directive. */
function programArgs(
  match: RegExpExecArray,
  offset: number,
): ProgramArgs {
  // Search from the END of "program" so a digit in the prefix can't be
  // mistaken for an argument.
  const text = match[0];
  const keyword = text.search(/program/i) + "program".length;
  const firstAt = text.indexOf(match[1]!, keyword);
  const first = {
    value: Number.parseInt(match[1]!, 10),
    start: offset + firstAt,
    end: offset + firstAt + match[1]!.length,
  };
  if (match[2] === undefined) return { first };
  const secondAt = text.indexOf(match[2], firstAt + match[1]!.length);
  return {
    first,
    second: {
      value: Number.parseInt(match[2], 10),
      start: offset + secondAt,
      end: offset + secondAt + match[2].length,
    },
  };
}

/** Global form: `<n>` or `<channel> <n>` — the program is the LAST argument. */
function globalCandidate(args: ProgramArgs, directive: string): LeadingProgram {
  const arg = args.second ?? args.first;
  return {
    program: arg.value,
    scope: "global",
    directive,
    replaceStart: arg.start,
    replaceEnd: arg.end,
  };
}

/**
 * Voice-scoped form: abcjs reads `params[0]` only, so the override replaces
 * both arguments with the one it plays.
 */
function voiceCandidate(args: ProgramArgs, directive: string): LeadingProgram {
  return {
    program: args.first.value,
    scope: "voice",
    directive,
    replaceStart: args.first.start,
    replaceEnd: (args.second ?? args.first).end,
  };
}

/**
 * Indices of the lines abcjs parses as the FIRST tune, in order.
 *
 * Mirrors parse/abc_parse_book.js: the (trimmed) book splits at every line
 * that starts `X:`; with more than one tune, text before the first `X:` is
 * "intertune", and only its `%%` directives are carried into the tune (ahead
 * of it); and a tune ends at its first empty line — another tune's intertune
 * text (a `%%score` for the next piece, say) must not be read as this one's.
 */
function firstTuneLineIndices(rawLines: readonly string[]): number[] {
  let start = 0;
  while (start < rawLines.length && rawLines[start]!.trim() === "") start++;
  const tuneStarts: number[] = [];
  for (let i = start + 1; i < rawLines.length; i++) {
    if (rawLines[i]!.startsWith("X:")) tuneStarts.push(i);
  }
  const indices: number[] = [];
  let tuneStart = start;
  let tuneEnd = tuneStarts[0] ?? rawLines.length;
  if (tuneStarts.length > 0 && !rawLines[start]!.startsWith("X:")) {
    for (let i = start; i < tuneStarts[0]!; i++) {
      if (rawLines[i]!.startsWith("%%")) indices.push(i);
    }
    tuneStart = tuneStarts[0]!;
    tuneEnd = tuneStarts[1] ?? rawLines.length;
  }
  for (let i = tuneStart; i < tuneEnd; i++) {
    // abcjs cuts at the raw "\n\n", so a CRLF blank line ("\r") doesn't end it.
    if (i > tuneStart && rawLines[i] === "") break;
    indices.push(i);
  }
  return indices;
}

/** First voice id named by `%%score` / `%%staves`, if the tune has one. */
function scoreFirstVoice(lines: readonly string[]): string | null {
  for (const line of lines) {
    const match = SCORE_RE.exec(line);
    if (!match) continue;
    const token = /[^\s()[\]{}|*]+/.exec(match[1]!);
    if (token) return token[0];
  }
  return null;
}

/** The voice id of a `V:` field body: its first whitespace-separated token. */
function voiceId(fieldBody: string): string {
  return fieldBody.trim().split(/\s+/)[0] ?? "";
}

/**
 * Find the directive that decides what abcjs plays on the first voice's first
 * note, or `null` when the score leaves that to the `program` synth option.
 */
export function findLeadingProgram(abc: string): LeadingProgram | null {
  const rawLines = abc.split("\n");
  // Offsets of each line in `abc`, so spans point into the original text.
  const offsets: number[] = [];
  let cursor = 0;
  for (const raw of rawLines) {
    offsets.push(cursor);
    cursor += raw.length + 1;
  }
  // Only the first tune reaches the widget; `tune[i]` sits at `offsets[at[i]]`.
  const at = firstTuneLineIndices(rawLines);
  const tune = at.map((i) => rawLines[i]!.replace(/\r$/, ""));

  let voice0: string | null = scoreFirstVoice(tune);
  let inHeader = true;
  let musicStarted = false;
  let currentIsVoice0 = true;
  let voice0HasNote = false;
  let global: LeadingProgram | null = null;
  let leadingInVoice: LeadingProgram | null = null;

  const switchVoice = (id: string): void => {
    if (voice0 === null) voice0 = id;
    currentIsVoice0 = id === voice0;
  };

  for (let i = 0; i < tune.length; i++) {
    const line = tune[i]!;
    const offset = offsets[at[i]!]!;

    // A text or PostScript block is prose to abcjs (parse_directive.js
    // `begintext` / `beginps`), however much it looks like music or MIDI.
    const block = BLOCK_RE.exec(line);
    if (block) {
      const end = `%%end${block[1]!.toLowerCase()}`;
      while (i + 1 < tune.length && !tune[i + 1]!.toLowerCase().startsWith(end)) i++;
      i++; // the %%end line itself
      continue;
    }

    if (line.startsWith("%%")) {
      const match = DIRECTIVE_RE.exec(line);
      if (!match) continue;
      const args = programArgs(match, offset);
      // Drop a trailing `% comment` (the leading `%%` is the directive's own).
      const directive = ("%%" + line.slice(2).split("%")[0]).trim();
      if (!musicStarted) global = globalCandidate(args, directive);
      else if (currentIsVoice0 && !voice0HasNote) {
        leadingInVoice = voiceCandidate(args, directive);
      }
      continue;
    }

    // abcjs cuts a line at its first `%` (abc_parse.js parseLine), which also
    // swallows a directive written with leading whitespace.
    const percent = line.indexOf("%");
    const body = (percent >= 0 ? line.slice(0, percent) : line).replace(/\s+$/, "");
    if (body.length === 0) continue;

    if (body[1] === ":" && KNOWN_FIELDS.has(body[0]!)) {
      const field = body[0];
      if (field === "K" && inHeader) {
        // The header's last V: stays the current voice: abcjs's K: handler
        // (parse_header.js) ends the header without selecting a voice, so
        // music straight after K: belongs to that voice, not to voice 0.
        inHeader = false;
      } else if (field === "V") {
        switchVoice(voiceId(body.slice(2)));
        if (!inHeader) musicStarted = true;
      }
      continue;
    }

    // A music line. Inline fields that open the tune's FIRST music line are
    // read before abcjs creates the staff line, so they are still global.
    let tokenSeen = false;
    for (let j = 0; j < body.length; ) {
      const rest = body.slice(j);
      const field = INLINE_FIELD_RE.exec(rest);
      if (field) {
        if (field[1] === "V") {
          switchVoice(voiceId(field[2]!));
        } else {
          const program = INLINE_PROGRAM_RE.exec(rest);
          if (program) {
            const args = programArgs(program, offset + j);
            if (!musicStarted && !tokenSeen) global = globalCandidate(args, program[0]);
            else if (currentIsVoice0 && !voice0HasNote) {
              leadingInVoice = voiceCandidate(args, program[0]);
            }
          }
        }
        j += field[0].length;
        continue;
      }
      const ch = body[j]!;
      if (ch === '"') {
        const close = body.indexOf('"', j + 1);
        tokenSeen = true;
        j = close < 0 ? body.length : close + 1;
        continue;
      }
      if (ch === "!") {
        const close = body.indexOf("!", j + 1);
        tokenSeen = true;
        j = close < 0 ? body.length : close + 1;
        continue;
      }
      if (/\s/.test(ch)) {
        j++;
        continue;
      }
      tokenSeen = true;
      if (NOTE_CHARS.test(ch) && currentIsVoice0) voice0HasNote = true;
      j++;
    }
    if (tokenSeen) musicStarted = true;
  }

  return leadingInVoice ?? global;
}

/**
 * The ABC with the first voice's opening program replaced by `program`.
 *
 * Only that one directive changes, so other voices that set their own
 * programs keep them. When the score sets NO opening program for the first
 * voice, the text comes back unchanged: the `program` synth option already
 * controls it.
 *
 * A global directive is also every other voice's starting program. Voices
 * without a program of their own therefore follow the override too, which is
 * the same as what the synth option does to them in a score without one.
 */
export function overrideLeadingProgram(abc: string, program: number): string {
  const leading = findLeadingProgram(abc);
  if (!leading || !Number.isInteger(program)) return abc;
  return (
    abc.slice(0, leading.replaceStart) +
    String(program) +
    abc.slice(leading.replaceEnd)
  );
}

/**
 * The ABC the widget actually hands to abcjs: the user's raw notation with the
 * style preset layered on and, when the user has picked from the Instrument
 * menu, the first voice's program overridden.
 *
 * The raw ABC is never rewritten: the editor keeps showing what the model
 * wrote. Every render path goes through here so they cannot disagree.
 */
export function deriveEffectiveAbc(
  raw: string,
  options: { style: string; programOverride?: number | null },
): string {
  const withProgram =
    options.programOverride === undefined || options.programOverride === null
      ? raw
      : overrideLeadingProgram(raw, options.programOverride);
  return applyStyleToAbc(withProgram, options.style);
}

/** The canonical INSTRUMENTS name for a GM program, if it has one. */
export function instrumentForProgram(program: number): string | null {
  for (const [name, value] of Object.entries(INSTRUMENTS)) {
    if (value === program) return name;
  }
  return null;
}
