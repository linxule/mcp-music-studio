/**
 * Notation-level transposition.
 *
 * The tool used to emit `%%MIDI transpose N`, an audio-only directive: the
 * synth played in the new key while the printed score and its `K:` header
 * stayed in the old one. Anyone reading the sheet music got the wrong notes.
 *
 * `ABCJS.strTranspose(abc, tuneObjArray, steps)` (public API since 6.x) rewrites
 * the ABC *string* instead — key signatures, accidentals, note letters and chord
 * symbols all move together — so the score and the audio agree. It needs a
 * parsed tune whose character offsets line up with the string being rewritten,
 * hence the `parseOnly` round-trip on the very same text.
 *
 * ## Three things strTranspose gets wrong (Codex review #5)
 *
 * Measured against abcjs 6.4.x, transposing up 2 semitones:
 *
 *   `{^F} C4 |`   → `{^G D4 |`   — the closing brace is DELETED
 *   `{^FG} C4 |`  → `{^G} D4 |`  — a grace note is DROPPED
 *   `K:none` `C D E F` → `D E F G` — shifts [2,2,1,2], not a uniform 2
 *
 * We can't fork abcjs, so this module works around all three:
 *
 *   (a) every `{...}` grace group is lifted out behind an inert annotation
 *       marker, transposed on its own as a one-line tune under the same key,
 *       and put back;
 *   (b) a tune with no key signature to move (`K:none`, or no `K:` at all) is
 *       not rewritten at all — it falls back to the audio-only
 *       `%%MIDI transpose N` and says so;
 *   (c) the rewritten string is ALWAYS reparsed and compared against the input
 *       — same note count, same grace-note count, no new warnings — and any
 *       disagreement falls back to `%%MIDI transpose N` with a warning rather
 *       than showing a score abcjs mangled.
 *
 * Lives in its own module because it needs ABCJS: `music-logic.ts` is imported
 * (via `shared/tool-defs.ts`) by the Cloudflare Worker and must stay
 * dependency-light.
 */
import ABCJS from "abcjs";

export interface TransposeResult {
  /** The ABC to render. Either notation-transposed, or the input plus a directive. */
  abc: string;
  /**
   * One honest sentence when the notation could NOT be moved and the audio was
   * shifted instead, so the caller can say the printed score is unchanged.
   * `null` when the notation itself was transposed.
   */
  warning: string | null;
}

type ParseFn = (abc: string) => ABCJS.TuneObjectArray;

const defaultParse: ParseFn = (input) => ABCJS.parseOnly(input);

/**
 * Marker standing in for a grace group while abcjs rewrites the rest.
 *
 * An ABC annotation (`"@…"`, as opposed to a chord symbol) is left verbatim by
 * strTranspose — verified against abcjs 6.4.x — and is legal wherever a grace
 * group is legal, so the surrounding notes keep their offsets and their
 * meaning.
 */
const MARKER_PREFIX = '"@zQg';
const marker = (index: number) => `${MARKER_PREFIX}${index}Q"`;

interface Masked {
  text: string;
  /** Inner text of each grace group, in order, without the braces. */
  groups: string[];
  /** Key field in force at each group, e.g. `"G"` or `"D dorian"`. */
  keys: string[];
}

/** Is this line an ABC header/comment rather than music? */
const isNonMusicLine = (line: string) => /^%/.test(line) || /^[A-Za-z]:/.test(line);

/**
 * Replace every `{...}` grace group in the tune BODY with an inert marker.
 *
 * Returns `null` when the input already contains the marker prefix (so the
 * substitution would not be reversible) or when a group is unterminated.
 */
function maskGraceGroups(abc: string): Masked | null {
  if (abc.includes(MARKER_PREFIX)) return null;

  const groups: string[] = [];
  const keys: string[] = [];
  const out: string[] = [];
  let key = "";
  let inBody = false;

  for (const line of abc.split("\n")) {
    // Track the key in force: a header `K:` opens the body, and either form can
    // change the key later on.
    const header = /^K:\s*(.*)$/.exec(line);
    if (header) {
      key = header[1]!.trim();
      inBody = true;
      out.push(line);
      continue;
    }
    if (isNonMusicLine(line)) {
      out.push(line);
      continue;
    }
    if (!inBody) {
      out.push(line);
      continue;
    }

    let result = "";
    let i = 0;
    while (i < line.length) {
      const ch = line[i]!;
      if (ch === '"') {
        // A quoted chord symbol/annotation may legally contain a brace.
        const end = line.indexOf('"', i + 1);
        if (end < 0) {
          result += line.slice(i);
          i = line.length;
          continue;
        }
        result += line.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      if (ch === "{") {
        const end = line.indexOf("}", i + 1);
        if (end < 0) return null; // unterminated group — don't touch this tune
        // An inline `[K:...]` earlier on the line may have changed the key.
        const inlineKey = /\[K:\s*([^\]]*)\]/g;
        let last: RegExpExecArray | null;
        let localKey = key;
        for (
          last = inlineKey.exec(line.slice(0, i));
          last;
          last = inlineKey.exec(line.slice(0, i))
        ) {
          localKey = last[1]!.trim();
        }
        result += marker(groups.length);
        groups.push(line.slice(i + 1, end));
        keys.push(localKey);
        i = end + 1;
        continue;
      }
      result += ch;
      i += 1;
    }
    out.push(result);
  }

  return { text: out.join("\n"), groups, keys };
}

/**
 * Transpose one grace group's contents by treating it as a tiny tune of its own.
 *
 * `{^FG}` under `K:C` up 2 becomes the body `^GA` of a `K:D` tune — correctly
 * respelled for the destination key, which is exactly what the surrounding
 * (transposed) music expects. Returns `null` if abcjs refuses.
 */
function transposeGraceGroup(
  inner: string,
  key: string,
  steps: number,
  parse: ParseFn,
): string | null {
  const trimmed = inner.trim();
  if (trimmed.length === 0) return inner;
  const tiny = `X:1\nL:1/8\nK:${key || "C"}\n${trimmed}\n`;
  try {
    const parsed = parse(tiny);
    if (!parsed || (parsed as unknown as unknown[]).length === 0) return null;
    const out = ABCJS.strTranspose(tiny, parsed, steps);
    const lines = out.split("\n");
    const keyLine = lines.findIndex((line) => /^K:/.test(line));
    if (keyLine < 0) return null;
    const body = lines
      .slice(keyLine + 1)
      .join(" ")
      .trim();
    if (body.length === 0 || body.includes("{") || body.includes("}")) return null;
    return body;
  } catch {
    return null;
  }
}

/** Every sounding pitch and grace note in a parsed tune, for the safety check. */
function shapeOf(parsed: ABCJS.TuneObjectArray): { notes: number; graces: number } {
  let notes = 0;
  let graces = 0;
  for (const tune of parsed as unknown as Record<string, any>[]) {
    for (const line of (tune.lines as any[]) ?? []) {
      for (const staff of (line.staff as any[]) ?? []) {
        for (const voice of (staff.voices as any[]) ?? []) {
          for (const el of voice as Record<string, any>[]) {
            notes += (el.pitches as unknown[] | undefined)?.length ?? 0;
            graces += (el.gracenotes as unknown[] | undefined)?.length ?? 0;
          }
        }
      }
    }
  }
  return { notes, graces };
}

/** Warnings abcjs emitted for a tune, flattened for comparison. */
function warningsOf(parsed: ABCJS.TuneObjectArray): Set<string> {
  const out = new Set<string>();
  for (const tune of parsed as unknown as Record<string, any>[]) {
    for (const w of (tune.warnings as unknown[] | undefined) ?? []) {
      out.add(String(w).replace(/<[^>]*>/g, "").trim());
    }
  }
  return out;
}

/**
 * Does this tune have a key signature strTranspose can move?
 *
 * abcjs answers `root: "none"` for both `K:none` and a missing/blank `K:`. In
 * that mode it shifts pitches by SCALE STEPS rather than semitones, so
 * `C D E F` up 2 becomes `D E F G` — intervals [2,2,1,2] instead of a uniform 2.
 */
function hasMovableKey(parsed: ABCJS.TuneObjectArray): boolean {
  for (const tune of parsed as unknown as Record<string, any>[]) {
    for (const line of (tune.lines as any[]) ?? []) {
      for (const staff of (line.staff as any[]) ?? []) {
        const root = staff?.key?.root;
        if (typeof root === "string") return root !== "none";
      }
    }
  }
  return false;
}

/** Insert the audio-only directive after the first `K:` line (or at the top). */
function withMidiTranspose(abc: string, steps: number): string {
  const directive = `%%MIDI transpose ${steps}`;
  const keyMatch = abc.match(/^(K:[^\n]*\n)/m);
  if (keyMatch && keyMatch.index !== undefined) {
    const at = keyMatch.index + keyMatch[0].length;
    return `${abc.slice(0, at)}${directive}\n${abc.slice(at)}`;
  }
  return `${directive}\n${abc}`;
}

function audioOnly(abc: string, steps: number, reason: string): TransposeResult {
  const direction = steps > 0 ? "up" : "down";
  return {
    abc: withMidiTranspose(abc, steps),
    warning:
      `Transposed the AUDIO only (${direction} ${Math.abs(steps)} semitone` +
      `${Math.abs(steps) === 1 ? "" : "s"}) — ${reason}. ` +
      `The printed score is still in the written key.`,
  };
}

/**
 * Transpose ABC by `steps` semitones, notation and key signature together,
 * reporting whether it had to fall back to shifting the audio alone.
 *
 * Returns the input unchanged for a falsy/zero shift, for unparseable ABC, or
 * if abcjs throws — transposition is a nicety, never a reason to lose the
 * score.
 */
export function transposeAbcDetailed(
  abc: string,
  steps: number | undefined,
  parse: ParseFn = defaultParse,
): TransposeResult {
  if (!steps || !Number.isFinite(steps)) return { abc, warning: null };
  const shift = Math.trunc(steps);
  if (shift === 0) return { abc, warning: null };

  let before: ABCJS.TuneObjectArray;
  try {
    before = parse(abc);
    // abcjs types TuneObjectArray as a 1-tuple, but unparseable input really
    // does come back empty at runtime — hence the widened length check.
    if (!before || (before as unknown as unknown[]).length === 0) {
      return { abc, warning: null };
    }
  } catch (err) {
    console.warn("Transpose failed; leaving notation unchanged:", err);
    return { abc, warning: null };
  }

  try {
    if (!hasMovableKey(before)) {
      return audioOnly(
        abc,
        shift,
        "this tune has no key signature to move (K:none), and abcjs shifts a " +
          "keyless tune by scale steps rather than semitones",
      );
    }

    const masked = maskGraceGroups(abc);
    if (!masked) {
      return audioOnly(abc, shift, "its grace notes could not be protected from abcjs");
    }

    const maskedParsed = masked.groups.length > 0 ? parse(masked.text) : before;
    if (!maskedParsed || (maskedParsed as unknown as unknown[]).length === 0) {
      return audioOnly(abc, shift, "its grace notes could not be protected from abcjs");
    }

    let out = ABCJS.strTranspose(masked.text, maskedParsed, shift);

    for (let i = 0; i < masked.groups.length; i += 1) {
      const moved = transposeGraceGroup(masked.groups[i]!, masked.keys[i]!, shift, parse);
      if (moved === null || !out.includes(marker(i))) {
        return audioOnly(abc, shift, "abcjs could not transpose one of its grace notes");
      }
      out = out.replace(marker(i), `{${moved}}`);
    }

    // Always verify: strTranspose has no failure signal of its own, so the only
    // way to know it kept the music intact is to read the result back.
    const after = parse(out);
    if (!after || (after as unknown as unknown[]).length === 0) {
      return audioOnly(abc, shift, "the transposed notation no longer parsed");
    }
    const from = shapeOf(before);
    const to = shapeOf(after);
    if (from.notes !== to.notes || from.graces !== to.graces) {
      return audioOnly(abc, shift, "the transposed notation lost notes");
    }
    const known = warningsOf(before);
    const fresh = [...warningsOf(after)].filter((w) => !known.has(w));
    if (fresh.length > 0) {
      return audioOnly(abc, shift, `the transposed notation did not parse cleanly (${fresh[0]})`);
    }

    return { abc: out, warning: null };
  } catch (err) {
    console.warn("Transpose failed; leaving notation unchanged:", err);
    return { abc, warning: null };
  }
}

/**
 * String-only form, for callers that render the ABC and have nowhere to show a
 * warning. The audio-only fallback is still applied — it lives inside the
 * returned ABC as a `%%MIDI transpose` directive — so playback is transposed
 * either way.
 */
export function transposeAbc(
  abc: string,
  steps: number | undefined,
  parse: ParseFn = defaultParse,
): string {
  return transposeAbcDetailed(abc, steps, parse).abc;
}
