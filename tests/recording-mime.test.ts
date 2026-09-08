// =============================================================================
// Audit finding 19: a browser with no MediaRecorder crashed the Record button.
//
// pickRecordingMime() opened with `typeof MediaRecorder?.isTypeSupported`, which
// LOOKS defensive and is not: optional chaining guards a null/undefined VALUE,
// never an UNDECLARED identifier. On a browser without MediaRecorder the whole
// expression is a ReferenceError — thrown before the `new MediaRecorder(...)`
// try/catch that exists for precisely this case, so the "Recording not supported
// on this browser" status never appeared and the click died in the console.
//
// src/strudel-app.ts is a DOM-bound widget bundle with no importable surface, so
// the helper is extracted from its source and executed in a node:vm context
// where MediaRecorder is genuinely undeclared — the only way to reproduce a
// ReferenceError, since a stubbed-in `undefined` global would not throw.
// =============================================================================

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "strudel-app.ts"),
  "utf8",
);

const CANDIDATES = /const RECORDING_MIME_CANDIDATES = (\[[\s\S]*?\n\]);/.exec(SRC)?.[1];
const HELPER = /function pickRecordingMime\(\)[\s\S]*?\n\}/.exec(SRC)?.[0];

/** The extracted helper, compiled into a fresh context with these globals. */
function loadHelper(globals: Record<string, unknown>): () => string | null {
  const ctx = vm.createContext({ ...globals });
  return vm.runInContext(
    `const RECORDING_MIME_CANDIDATES = ${CANDIDATES};
${HELPER!.replace(/^function pickRecordingMime\(\)\s*:[^{]*\{/, "function pickRecordingMime() {")}
pickRecordingMime;`,
    ctx,
  );
}

describe("the extraction itself", () => {
  it("found both pieces (a rename must fail here, not silently pass)", () => {
    expect(CANDIDATES).toBeTruthy();
    expect(HELPER).toBeTruthy();
    expect(CANDIDATES).toContain("audio/webm;codecs=opus");
  });

  it("confirms the hazard: optional chaining does not protect an undeclared global", () => {
    // `toThrow(ReferenceError)` would compare across realms; match the message.
    expect(() =>
      vm.runInContext("typeof MediaRecorder?.isTypeSupported", vm.createContext({})),
    ).toThrow(/MediaRecorder is not defined/);
    // A BARE `typeof` on an undeclared name is the form that is actually safe.
    expect(
      vm.runInContext("typeof MediaRecorder", vm.createContext({})),
    ).toBe("undefined");
  });
});

describe("pickRecordingMime", () => {
  it("returns null instead of throwing when MediaRecorder does not exist", () => {
    const pick = loadHelper({});
    expect(pick()).toBeNull();
  });

  it("picks the first type the browser claims to support", () => {
    const pick = loadHelper({
      MediaRecorder: { isTypeSupported: (m: string) => m === "audio/mp4" },
    });
    expect(pick()).toBe("audio/mp4");
  });

  it("prefers opus/webm when everything is supported", () => {
    const pick = loadHelper({ MediaRecorder: { isTypeSupported: () => true } });
    expect(pick()).toBe("audio/webm;codecs=opus");
  });

  it('falls back to "" (let the UA choose) when nothing named is supported', () => {
    const pick = loadHelper({ MediaRecorder: { isTypeSupported: () => false } });
    expect(pick()).toBe("");
  });

  it("takes the first candidate when isTypeSupported is missing", () => {
    const pick = loadHelper({ MediaRecorder: {} });
    expect(pick()).toBe("audio/webm;codecs=opus");
  });
});

describe("startRecording routes the null through the unsupported handler", () => {
  it("reports the existing status instead of constructing a recorder", () => {
    // The status string is the one the constructor's catch already used — a
    // browser without MediaRecorder must land in the same place as one that
    // rejects every MIME type.
    expect(SRC).toMatch(
      /const mime = pickRecordingMime\(\);\n\s*if \(mime === null\) \{\n\s*setStatus\("Recording not supported on this browser", "error"\);\n\s*return;/,
    );
  });
});
