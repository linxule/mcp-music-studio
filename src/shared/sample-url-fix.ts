// =============================================================================
// VCSL samples whose path has a comma — silent in every Chromium browser
//
// raw.githubusercontent.com answers with an UNQUOTED
//   content-disposition: attachment; filename=…/Grand Piano, Steinway B/…
// and Chromium reads the comma as two content-disposition headers, refusing the
// response (net::ERR_RESPONSE_HEADERS_MULTIPLE_CONTENT_DISPOSITION). 22 of the
// 128 VCSL sounds have such a folder — kalimba*, steinway, kawai, ocarina*,
// snare_*, psaltery_*, shaker_*, handbells, trainwhistle — so in Chrome, Edge
// and Electron hosts they never sound, with nothing but a console line to show
// for it. (Measured 2026-10-01 against the vcsl.json @strudel/repl@1.3.0 loads;
// WebKit appears to tolerate the header.) jsDelivr serves the same files from
// the same repository with no content-disposition at all, and is already in the
// widget's CSP. So sample fetches for those paths are rewritten there.
// =============================================================================

const VCSL_RAW = "https://raw.githubusercontent.com/sgossner/VCSL/master/";
const VCSL_JSDELIVR = "https://cdn.jsdelivr.net/gh/sgossner/VCSL@master/";

/** The URL a sample fetch should actually use. */
export function fixSampleUrl(url: string): string {
  if (!url.startsWith(VCSL_RAW)) return url;
  const path = url.slice(VCSL_RAW.length);
  return /,|%2c/i.test(path) ? VCSL_JSDELIVR + path : url;
}

/** Wrap `scope.fetch` once so every sample loader goes through fixSampleUrl. */
export function installSampleUrlFix(scope: { fetch?: typeof fetch } & Record<string, unknown>): void {
  const original = scope.fetch;
  if (typeof original !== "function" || (original as { __sampleUrlFix?: boolean }).__sampleUrlFix) return;
  const wrapped = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    if (typeof input === "string") input = fixSampleUrl(input);
    else if (input instanceof URL) input = new URL(fixSampleUrl(input.href));
    return original.call(this ?? scope, input, init);
  } as typeof fetch & { __sampleUrlFix?: boolean };
  wrapped.__sampleUrlFix = true;
  scope.fetch = wrapped;
}
