import { describe, expect, it } from "vitest";
import { fixSampleUrl, installSampleUrlFix } from "../src/shared/sample-url-fix";

const STEINWAY =
  "https://raw.githubusercontent.com/sgossner/VCSL/master/Chordophones/Zithers/Grand%20Piano%2C%20Steinway%20B/Sus/JHPiano_Sus_Close_C4_vl4_rr1.wav";

describe("VCSL comma paths (silent in Chromium)", () => {
  it("routes a comma path to jsDelivr, and leaves everything else alone", () => {
    expect(fixSampleUrl(STEINWAY)).toBe(
      "https://cdn.jsdelivr.net/gh/sgossner/VCSL@master/Chordophones/Zithers/Grand%20Piano%2C%20Steinway%20B/Sus/JHPiano_Sus_Close_C4_vl4_rr1.wav",
    );
    const plain = "https://raw.githubusercontent.com/sgossner/VCSL/master/Idiophones/Struck%20Idiophones/Marimba/x.wav";
    expect(fixSampleUrl(plain)).toBe(plain);
    const dirt = "https://raw.githubusercontent.com/tidalcycles/Dirt-Samples/master/bd/a,b.wav";
    expect(fixSampleUrl(dirt)).toBe(dirt);
  });

  it("wraps fetch once, rewriting string and URL inputs", async () => {
    const seen: string[] = [];
    const scope: any = { fetch: async (input: any) => { seen.push(String(input instanceof URL ? input.href : input)); return new Response(""); } };
    installSampleUrlFix(scope);
    installSampleUrlFix(scope);
    await scope.fetch(STEINWAY);
    await scope.fetch(new URL(STEINWAY));
    await scope.fetch("https://example.com/a,b");
    expect(seen[0]).toContain("cdn.jsdelivr.net");
    expect(seen[1]).toContain("cdn.jsdelivr.net");
    expect(seen[2]).toBe("https://example.com/a,b");
  });
});

describe("Request inputs", () => {
  it("rewrites a Request's URL and keeps its init", async () => {
    let seen: Request | undefined;
    const scope: any = { fetch: async (input: any) => { seen = input; return new Response(""); } };
    installSampleUrlFix(scope);
    await scope.fetch(new Request(STEINWAY, { headers: { "x-test": "1" } }));
    expect(seen!.url).toContain("cdn.jsdelivr.net");
    expect(seen!.headers.get("x-test")).toBe("1");
  });
});
