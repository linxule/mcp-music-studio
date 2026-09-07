/**
 * The abcjs version the browser-fallback player pulls from a CDN.
 *
 * The bundled widget uses whatever `node_modules/abcjs` resolves to; the
 * fallback page has no bundler, so it names a version in a URL. Those two used
 * to drift silently (the HTML hard-coded a version in two places while
 * package.json declared a range), meaning the fallback could render with a
 * different abcjs than the widget and no test would notice.
 *
 * `tests/abcjs-version.test.ts` pins this to the installed package version, so
 * a dependency bump that forgets this constant fails the suite.
 */
export const ABCJS_CDN_VERSION = "6.7.0";

/** jsDelivr base for the pinned release (no trailing slash). */
export const ABCJS_CDN_BASE = `https://cdn.jsdelivr.net/npm/abcjs@${ABCJS_CDN_VERSION}`;
