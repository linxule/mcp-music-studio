import { describe, expect, it } from "vitest";
import { STRUDEL_CSP, SHEET_CSP } from "../src/shared/tool-defs";
import { STRUDEL_GUIDES } from "../src/strudel-guide";
import { ABC_GUIDES } from "../src/abc-guide";
import strudelSounds from "./fixtures/strudel-sounds.json";

/**
 * Inside the ext-apps widget the host enforces the CSP we declare in
 * STRUDEL_CSP / SHEET_CSP. A guide example that fetches from an origin we did
 * not declare fails silently: the sample is never registered and the layer is
 * mute, with no error the agent can see.
 *
 * So: every https:// origin that appears in guide CODE must be declared — or
 * the example must say, on the same line or the one above it, that it is
 * browser-mode only (the --render-mode browser fallback has no CSP).
 */

const BROWSER_ONLY_MARKER = /browser mode only|browser-mode only/i;

const declared = new Set(
  [...STRUDEL_CSP.connectDomains, ...STRUDEL_CSP.resourceDomains, ...SHEET_CSP.connectDomains].map(
    (d) => new URL(d).origin,
  ),
);

/**
 * A guide line is prose unless it looks like code: an example we expect an
 * agent to copy. Code lines here are the ones that call a function with the
 * URL in it — samples(...), s(...), a bare object literal continuation.
 */
const looksLikeCode = (line: string) => /[a-zA-Z_$][\w$]*\s*\(|^\s*[}\])]/.test(line);

const URL_RE = /https?:\/\/[^\s'"`)\],]+/g;

interface Found {
  readonly where: string;
  readonly origin: string;
  readonly line: string;
}

function collect(): Found[] {
  const out: Found[] = [];
  for (const [source, guides] of [
    ["strudel", STRUDEL_GUIDES],
    ["abc", ABC_GUIDES],
  ] as const) {
    for (const [topic, text] of Object.entries(guides)) {
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        if (!looksLikeCode(line)) return;
        // The marker may sit on the example's heading, so look back to the
        // nearest heading line and forward one line.
        let start = i;
        while (start > 0 && !lines[start].startsWith("#")) start -= 1;
        const context = lines.slice(start, i + 2).join("\n");
        if (BROWSER_ONLY_MARKER.test(context)) return;
        for (const m of line.match(URL_RE) ?? []) {
          let origin: string;
          try {
            origin = new URL(m).origin;
          } catch {
            continue;
          }
          out.push({ where: `${source}:${topic}`, origin, line: line.trim() });
        }
      });
    }
  }
  return out;
}

const found = collect();

describe("guide code examples only fetch from CSP-declared origins", () => {
  it("every https:// origin in a guide example is declared (or marked browser-mode only)", () => {
    const bad = found
      .filter((f) => !declared.has(f.origin))
      .map((f) => `${f.where}: ${f.origin}  <-  ${f.line}`);
    expect([...new Set(bad)]).toEqual([]);
  });

  it("declares the origins prebake() itself fetches from", () => {
    for (const manifest of strudelSounds.sampleManifests as string[]) {
      expect(declared.has(new URL(manifest).origin), manifest).toBe(true);
    }
    expect(declared.has(new URL(strudelSounds.bankAliases as string).origin)).toBe(true);
    // GM soundfont payloads
    expect(declared.has("https://felixroos.github.io")).toBe(true);
  });

  it("declares the shabda sample source the guide advertises", () => {
    // samples('shabda:...') -> shabda.ndre.gr -> cdn.freesound.org
    expect(STRUDEL_CSP.connectDomains).toContain("https://shabda.ndre.gr");
    expect(STRUDEL_CSP.connectDomains).toContain("https://cdn.freesound.org");
  });

  it("the guide tells the agent which sample sources survive the widget CSP", () => {
    const advanced = STRUDEL_GUIDES.advanced;
    expect(advanced).toMatch(/github:/);
    expect(advanced).toMatch(/shabda:/);
    expect(advanced).toMatch(/BLOCKED/);
    expect(advanced).toMatch(BROWSER_ONLY_MARKER);
  });
});
