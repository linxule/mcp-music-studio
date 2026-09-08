import { describe, expect, it } from "vitest";
import {
  SHARE_NUMBER_BOUNDS,
  ShareParamError,
  buildShareQueryUrl,
  clampShareNumber,
  decodeShareParam,
  encodeShareParam,
  parsePlaySearchParams,
  parseScoreSearchParams,
  playSearchParams,
  scoreSearchParams,
  toPlayShareArgs,
  type ShareNumberKey,
} from "../src/shared/share-url";
import { playLiveInputSchema, playSheetInputSchema } from "../src/shared/tool-defs";

// =============================================================================
// Share numeric bounds (F6) and the visuals fold (F7)
// =============================================================================
//
// /play and /score are unauthenticated paths into the same page generators the
// tools use, and their numbers were only checked for finiteness. `?bpm=1e9`
// baked `setcps(4166666)` into a pattern; `?bpm=-120` baked a negative cps;
// `?tempo=1e9` wrote a Q: header nothing renders.

const PLAIN = 's("bd sd")';
const ABC = "X:1\nK:C\nCDEF|";

describe("SHARE_NUMBER_BOUNDS matches the tool schemas", () => {
  // share-url.ts is deliberately dependency-free, so the ranges are duplicated
  // rather than imported. Pin them by EXERCISING the zod schemas (no reliance on
  // zod internals): the bound must be accepted and one step past it rejected.
  const cases: {
    key: ShareNumberKey;
    schema: typeof playLiveInputSchema | typeof playSheetInputSchema;
    base: Record<string, unknown>;
    step: number;
  }[] = [
    { key: "bpm", schema: playLiveInputSchema, base: { code: PLAIN }, step: 1 },
    { key: "tempo", schema: playSheetInputSchema, base: { abcNotation: ABC }, step: 1 },
    { key: "swing", schema: playSheetInputSchema, base: { abcNotation: ABC }, step: 1 },
    { key: "drumIntro", schema: playSheetInputSchema, base: { abcNotation: ABC }, step: 1 },
    { key: "transpose", schema: playSheetInputSchema, base: { abcNotation: ABC }, step: 1 },
  ];

  it.each(cases)("$key", ({ key, schema, base, step }) => {
    const { min, max } = SHARE_NUMBER_BOUNDS[key];
    expect(schema.safeParse({ ...base, [key]: min }).success).toBe(true);
    expect(schema.safeParse({ ...base, [key]: max }).success).toBe(true);
    expect(schema.safeParse({ ...base, [key]: min - step }).success).toBe(false);
    expect(schema.safeParse({ ...base, [key]: max + step }).success).toBe(false);
  });

  it("covers every numeric field the share params carry", () => {
    expect(Object.keys(SHARE_NUMBER_BOUNDS).sort()).toEqual([
      "bpm",
      "drumIntro",
      "swing",
      "tempo",
      "transpose",
    ]);
  });
});

describe("clampShareNumber", () => {
  it.each([
    ["bpm", 1e9, 300],
    ["bpm", -120, 40],
    ["bpm", 128, 128],
    ["tempo", 1e9, 240],
    ["tempo", 0, 40],
    ["swing", 1000, 75],
    ["swing", -5, 0],
    ["drumIntro", 99, 8],
    ["drumIntro", -1, 0],
    ["transpose", 500, 12],
    ["transpose", -500, -12],
  ] as [ShareNumberKey, number, number][])(
    "clamps %s=%d to %d",
    (key, input, expected) => {
      expect(clampShareNumber(key, input)).toBe(expected);
    },
  );

  it("rounds the integral fields and leaves the others alone", () => {
    expect(clampShareNumber("drumIntro", 2.7)).toBe(3);
    expect(clampShareNumber("transpose", -3.4)).toBe(-3);
    expect(clampShareNumber("bpm", 128.5)).toBe(128.5);
  });

  it("drops a non-finite value rather than clamping it to a bound", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(clampShareNumber("bpm", bad)).toBeUndefined();
    }
    expect(clampShareNumber("bpm", undefined)).toBeUndefined();
  });
});

describe("clamping through the query string", () => {
  it("clamps an absurd bpm on the way in", () => {
    const q = new URLSearchParams({ c: encodeShareParam(PLAIN), bpm: "1e9" });
    expect(parsePlaySearchParams(q).bpm).toBe(300);
  });

  it("clamps a negative bpm rather than passing a negative cps to the page", () => {
    const q = new URLSearchParams({ c: encodeShareParam(PLAIN), bpm: "-120" });
    expect(parsePlaySearchParams(q).bpm).toBe(40);
  });

  it.each([
    ["tempo", "1e9", 240],
    ["swing", "9999", 75],
    ["drumIntro", "-4", 0],
    ["transpose", "48", 12],
  ] as ["tempo" | "swing" | "drumIntro" | "transpose", string, number][])(
    "clamps score param %s",
    (key, raw, expected) => {
      const q = new URLSearchParams({ a: encodeShareParam(ABC), [key]: raw });
      expect(parseScoreSearchParams(q)[key]).toBe(expected);
    },
  );

  it("clamps on the way OUT too, so an out-of-range link is never minted", () => {
    expect(playSearchParams({ code: PLAIN, bpm: 1e9 }).get("bpm")).toBe("300");
    const s = scoreSearchParams({ abcNotation: ABC, tempo: -1e9, transpose: 99 });
    expect(s.get("tempo")).toBe("40");
    expect(s.get("transpose")).toBe("12");
  });

  it("still rejects a param that isn't a number at all", () => {
    const q = new URLSearchParams({ c: encodeShareParam(PLAIN), bpm: "fast" });
    expect(() => parsePlaySearchParams(q)).toThrow(ShareParamError);
  });

  it("rejects an overflowing literal rather than clamping Infinity to a bound", () => {
    // `1e999` parses to Infinity, which is not a number anyone meant to send.
    const q = new URLSearchParams({ c: encodeShareParam(PLAIN), bpm: "1e999" });
    expect(() => parsePlaySearchParams(q)).toThrow(ShareParamError);
  });
});

describe("toPlayShareArgs folds the visuals preset (F7)", () => {
  it("folds a draw preset into the code the link carries", () => {
    const args = toPlayShareArgs({ code: PLAIN, visuals: "pianoroll" });
    expect(args.code).toContain("pianoroll(");
    expect(args.code).toContain(PLAIN);
  });

  it("folds a hydra preset — the case that linked to an empty page", () => {
    const args = toPlayShareArgs({ code: PLAIN, visuals: "hydra-kaleid" });
    expect(args.code).toContain("initHydra(");
    expect(args.code).toContain("kaleid(");
  });

  it("drops `theme` — editor chrome the standalone page doesn't have", () => {
    const args = toPlayShareArgs({ code: PLAIN, visuals: "none", theme: "nord" });
    expect(args).toEqual({
      code: PLAIN,
      bpm: undefined,
      title: undefined,
      autoplay: undefined,
    });
    expect(JSON.stringify(args)).not.toContain("nord");
  });

  it("leaves code that already visualises alone", () => {
    const own = `${PLAIN}.pianoroll()`;
    expect(toPlayShareArgs({ code: own, visuals: "punchcard" }).code).toBe(own);
  });

  it("passes the other options through, clamping bpm", () => {
    const args = toPlayShareArgs({
      code: PLAIN,
      bpm: 1e9,
      title: "Nocturne",
      autoplay: false,
    });
    expect(args.bpm).toBe(300);
    expect(args.title).toBe("Nocturne");
    expect(args.autoplay).toBe(false);
  });

  it("reaches the URL: a hydra preset survives into the /play link", () => {
    const url = buildShareQueryUrl({
      kind: "play",
      args: toPlayShareArgs({ code: PLAIN, visuals: "hydra-wash" }),
    });
    const code = decodeShareParam(new URL(url!).searchParams.get("c")!);
    expect(code).toContain("initHydra(");
    expect(code).toContain("noise(");
  });
});
