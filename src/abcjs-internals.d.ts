/**
 * Types for the one abcjs internal we deep-import.
 *
 * abcjs ships source as its entry point (package.json "main": "index.js", no
 * `exports` map), so this path resolves to the very module `load-note.js` and
 * `place-note.js` mutate. It is not part of abcjs's public API and carries no
 * types; see src/abcjs-sound-cache.ts for why we reach for it anyway and how
 * the widget detects at runtime if this ever stops being the live object.
 */
declare module "abcjs/src/synth/sounds-cache.js" {
  /** `soundsCache[instrumentName][noteName] = Promise<{ audioBuffer }>` */
  const soundsCache: Record<string, Record<string, unknown>>;
  export default soundsCache;
}
