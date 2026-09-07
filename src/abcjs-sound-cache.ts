/**
 * @file Invalidate abcjs's sample cache when the sound bank changes.
 *
 * ## The bug
 *
 * abcjs caches decoded mp3 samples in a module-level singleton
 * (`node_modules/abcjs/src/synth/sounds-cache.js`) keyed as
 *
 *     soundsCache[instrument][noteName]
 *
 * The **soundfont URL is not part of the key** (`load-note.js`). So after any
 * note has been played, switching `soundFontUrl` and re-priming returns the
 * OLD bank's samples for every instrument/note pair already cached. Measured
 * with the real loader and a stubbed XHR: two `getNote()` calls for the same
 * flute note against two different bank URLs issued exactly ONE network
 * request, to the first URL. The widget's Sound selector was therefore a lie
 * from the first play onward, and its comment ("every sample is refetched")
 * was false.
 *
 * ## Why not something cleaner
 *
 * There is no supported reset. `soundsCache` is not on `ABCJS.synth` (grepped:
 * nothing matching /cache|reset|clear/), nothing in abcjs ever empties it, and
 * neither a fresh `SynthController` nor a fresh `AudioContext` helps — the
 * cache is scoped to the *module*, not to either of those. `SynthController`'s
 * own `destroy()` only tears down the timer and midiBuffer.
 *
 * ## What this does instead
 *
 * abcjs ships **source** as its entry point (`package.json` "main":
 * "index.js", no `exports` map), so bundlers resolve `abcjs` and
 * `abcjs/src/synth/sounds-cache.js` to the same file, and a deep import gets
 * the *same* singleton the loader mutates. `resetSoundsCache()` empties it in
 * place (never reassigns — every other abcjs module holds the same object
 * reference), which makes the next `init()`/`prime()` refetch every sample
 * from the newly selected bank.
 *
 * ## Why this can't silently regress into the old lie
 *
 * A deep import into another package's internals is a fair thing to be nervous
 * about: a future abcjs could move the file (a build error — loud, fine) or,
 * worse, keep the path while the live cache moves elsewhere (silent, and we'd
 * be back to a selector that lies). `soundsCacheLooksLive()` closes that door
 * at runtime: once audio has actually been primed, the real cache is
 * necessarily non-empty, so an empty reference proves we are holding the wrong
 * object. The widget checks that before promising a bank switch, and disables
 * the selector honestly if the proof fails.
 */
import soundsCache from "abcjs/src/synth/sounds-cache.js";

/** The live cache object, typed. Exported for tests. */
export const abcjsSoundsCache = soundsCache as Record<
  string,
  Record<string, unknown>
>;

/**
 * Empty abcjs's sample cache so the next prime refetches from the current bank.
 *
 * Mutates in place — abcjs modules captured this exact object at import time,
 * so reassigning it would leave them all pointing at the old one.
 *
 * @returns how many instrument entries were dropped.
 */
export function resetSoundsCache(): number {
  const keys = Object.keys(abcjsSoundsCache);
  for (const key of keys) delete abcjsSoundsCache[key];
  return keys.length;
}

/** Number of instruments currently cached. */
export function soundsCacheSize(): number {
  return Object.keys(abcjsSoundsCache).length;
}

/**
 * Is our reference plausibly the cache abcjs is really using?
 *
 * Only meaningful once something has been primed: before that, an empty cache
 * is simply an empty cache. Call it with `hasPrimedAudio = true` and a `false`
 * answer means the deep import missed and bank switching cannot be trusted.
 */
export function soundsCacheLooksLive(hasPrimedAudio: boolean): boolean {
  return !hasPrimedAudio || soundsCacheSize() > 0;
}
