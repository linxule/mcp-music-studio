// =============================================================================
// Error positions in the code the MODEL sent, not the code the widget ran
//
// The widget can add whole lines above a pattern before evaluating it: a
// `setcps(…);` for the `bpm` parameter (src/shared/tempo.ts) and the draw or
// Hydra lines of a `visuals` preset. An error at "(88:61)" in what ran is then
// line 87 of what the model wrote — and the model, reading its own code, looks
// one line too low. (Found from claude.ai, 2026-10-01: the `))` typo in Lossy.)
// =============================================================================

/**
 * Map 1-based `line` of `shown` back to `sent`, where `shown` is `sent` with
 * whole lines inserted. Null when the line was inserted, or when `shown` is not
 * such an insertion (the user edited the buffer) — then no mapping is honest.
 */
export function mapLineToSent(shown: string, sent: string, line: number): number | null {
  const a = shown.split("\n");
  const b = sent.split("\n");
  if (a.length < b.length) return null;
  // Align from the front AND from the back. When an inserted line is
  // textually identical to one of the piece's own (a bpm `setcps(…);` the
  // piece already had), the two alignments disagree — and then no mapping is
  // honest, so make no claim rather than a confident one-line-off one.
  const forward = align(a, b);
  const backward = align([...a].reverse(), [...b].reverse());
  if (!forward || !backward) return null;
  const f = forward[line - 1] ?? null;
  const r = backward[a.length - line];
  const fromBack = r === null || r === undefined ? null : b.length + 1 - r;
  return f !== null && f === fromBack ? f : null;
}

/** Greedy alignment of `a` (b with whole lines inserted) onto `b`; 1-based b lines, null for inserted. */
function align(a: string[], b: string[]): Array<number | null> | null {
  const map: Array<number | null> = [];
  let j = 0;
  for (let i = 0; i < a.length; i++) {
    if (j < b.length && a[i] === b[j]) map.push(++j);
    else map.push(null);
  }
  return j === b.length ? map : null;
}

/**
 * A sentence to append to an error report when its `(line:column)` points at a
 * different line of the code the model sent; "" when they agree or can't be mapped.
 */
export function sourceLineNote(message: string, shown: string, sent: string): string {
  const matches = [...message.matchAll(/\((\d+):(\d+)\)/g)];
  const last = matches[matches.length - 1];
  if (!last || shown === sent) return "";
  const line = Number(last[1]);
  const mapped = mapLineToSent(shown, sent, line);
  if (mapped === null || mapped === line) return "";
  const added = shown.split("\n").length - sent.split("\n").length;
  return (
    ` — that is line ${mapped} of the code you sent (the widget added ${added} ` +
    `line${added === 1 ? "" : "s"} for bpm/visuals before running it)`
  );
}
