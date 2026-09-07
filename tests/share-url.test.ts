import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHARE_ORIGIN,
  SHARE_PARAM_MAX_BYTES,
  SHARE_QUERY_MAX_CHARS,
  ShareParamError,
  buildPlayerCsp,
  buildShareQueryUrl,
  buildStoredShareUrl,
  decodeShareParam,
  encodeShareParam,
  isValidShareId,
  parsePlaySearchParams,
  parseScoreSearchParams,
  playSearchParams,
  scoreSearchParams,
  shareId,
  shareKvKey,
} from "../src/shared/share-url";

// =============================================================================
// share-url — the pure half of the click-to-play links
// =============================================================================

describe("encodeShareParam / decodeShareParam", () => {
  const ROUND_TRIP: Record<string, string> = {
    empty: "",
    ascii: 'sound("bd sd")',
    // A Strudel pattern is JavaScript: quotes, newlines, braces, backslashes.
    pattern:
      'stack(\n  s("bd*2 sd").gain(.8),\n  note("c e g").s("gm_flute")\n).cpm(120)',
    // The reason the payload is base64 at all: raw ABC is full of characters
    // that would need per-context escaping.
    abc: "X:1\nT:Tune & Co\nM:4/4\nK:C\n|:C D E F|G A B c:|",
    // `-->` closes an HTML comment; base64 must neutralise it so the payload
    // can never break out of the page it is inlined into.
    htmlComment: "<!-- x --> </script><script>alert(1)</script>",
    unicode: "🎹 café — ノート ♭♯ 𝄞",
    // Multi-byte characters straddling the 3-byte base64 grouping.
    surrogates: "𝄞𝄞𝄞",
    whitespace: "  \t\n\r  ",
  };

  it.each(Object.entries(ROUND_TRIP))("round-trips %s", (_name, value) => {
    expect(decodeShareParam(encodeShareParam(value))).toBe(value);
  });

  it("emits unpadded base64url that survives a query string untouched", () => {
    for (const value of Object.values(ROUND_TRIP)) {
      const encoded = encodeShareParam(value);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(encoded).not.toContain("=");
      // No character that URLSearchParams would percent-escape.
      expect(new URLSearchParams({ c: encoded }).toString()).toBe(
        `c=${encoded}`,
      );
    }
  });

  it("round-trips a payload at the size cap", () => {
    const value = "x".repeat(SHARE_PARAM_MAX_BYTES);
    expect(decodeShareParam(encodeShareParam(value))).toBe(value);
  });

  it("refuses to encode a payload over the size cap", () => {
    const tooBig = "x".repeat(SHARE_PARAM_MAX_BYTES + 1);
    expect(() => encodeShareParam(tooBig)).toThrow(ShareParamError);
    try {
      encodeShareParam(tooBig);
    } catch (err) {
      expect((err as ShareParamError).status).toBe(413);
    }
  });

  it("counts BYTES, not characters, against the cap", () => {
    // 4 bytes per astral character — a string well under the cap in characters
    // is over it in bytes.
    const value = "𝄞".repeat(SHARE_PARAM_MAX_BYTES / 4 + 1);
    expect(value.length).toBeLessThan(SHARE_PARAM_MAX_BYTES);
    expect(() => encodeShareParam(value)).toThrow(/limit is/);
  });

  it("rejects an oversized param on decode without decoding it (413)", () => {
    // Never produced by encodeShareParam — this is the hostile-input path.
    const huge = "A".repeat(SHARE_PARAM_MAX_BYTES * 2);
    try {
      decodeShareParam(huge);
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ShareParamError);
      expect((err as ShareParamError).status).toBe(413);
    }
  });

  it.each([
    ["standard base64 padding", "aGVsbG8="],
    ["standard base64 alphabet", "a+b/c"],
    ["a percent escape", "aGV%20sbG8"],
    ["a space", "aGVs bG8"],
    ["a dot", "aGVs.bG8"],
    ["a lone trailing char (bad length)", "aGVsbG8ha"],
  ])("rejects %s with 400", (_name, param) => {
    try {
      decodeShareParam(param);
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ShareParamError);
      expect((err as ShareParamError).status).toBe(400);
    }
  });

  it("rejects valid base64 that is not valid UTF-8 (400)", () => {
    // 0xff 0xfe is a well-formed byte pair and an invalid UTF-8 sequence.
    const param = encodeBytes(new Uint8Array([0xff, 0xfe]));
    try {
      decodeShareParam(param);
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ShareParamError);
      expect((err as ShareParamError).status).toBe(400);
      expect((err as ShareParamError).message).toMatch(/UTF-8/);
    }
  });
});

function encodeBytes(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("query params", () => {
  it("round-trips every play option", () => {
    const args = {
      code: 's("bd sd").gain(0.8) // & <ok>',
      bpm: 128,
      title: "Midnight Rain",
      autoplay: false,
    };
    expect(parsePlaySearchParams(playSearchParams(args))).toEqual(args);
  });

  it("round-trips every score option", () => {
    const args = {
      abcNotation: "X:1\nT:Test\nK:C\nCDEF|",
      title: "Test",
      instrument: "Flute",
      style: "jazz",
      tempo: 120,
      swing: 0.3,
      drumIntro: 2,
      transpose: -2,
    };
    expect(parseScoreSearchParams(scoreSearchParams(args))).toEqual(args);
  });

  it("omits absent options rather than emitting empty values", () => {
    const q = playSearchParams({ code: "s('bd')" });
    expect([...q.keys()]).toEqual(["c"]);
    const parsed = parsePlaySearchParams(q);
    expect(parsed.bpm).toBeUndefined();
    expect(parsed.title).toBeUndefined();
    // autoplay defaults to true in the generator; absent means "don't override".
    expect(parsed.autoplay).toBeUndefined();
  });

  it("only serialises autoplay when it is being turned OFF", () => {
    expect(playSearchParams({ code: "x", autoplay: true }).has("autoplay")).toBe(
      false,
    );
    expect(playSearchParams({ code: "x", autoplay: false }).get("autoplay")).toBe(
      "0",
    );
  });

  it.each(["0", "false", "FALSE"])("reads autoplay=%s as false", (raw) => {
    const q = new URLSearchParams({ c: encodeShareParam("x"), autoplay: raw });
    expect(parsePlaySearchParams(q).autoplay).toBe(false);
  });

  it("throws 400 when the code payload is missing entirely", () => {
    try {
      parsePlaySearchParams(new URLSearchParams({ bpm: "120" }));
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ShareParamError);
      expect((err as ShareParamError).status).toBe(400);
      expect((err as ShareParamError).message).toMatch(/"c"/);
    }
  });

  it("throws 400 on a non-numeric numeric param", () => {
    const q = new URLSearchParams({ c: encodeShareParam("x"), bpm: "fast" });
    expect(() => parsePlaySearchParams(q)).toThrow(/must be a number/);
  });

  it("truncates an over-long title instead of rejecting the link", () => {
    const q = playSearchParams({ code: "x", title: "T".repeat(500) });
    expect(parsePlaySearchParams(q).title).toHaveLength(200);
  });
});

describe("buildShareQueryUrl", () => {
  it("builds a /play URL whose code survives the round trip", () => {
    const code = 'stack(s("bd*4"), note("c e g"))';
    const url = buildShareQueryUrl({ kind: "play", args: { code, bpm: 90 } });
    expect(url).not.toBeNull();
    const parsed = new URL(url!);
    expect(parsed.origin).toBe(DEFAULT_SHARE_ORIGIN);
    expect(parsed.pathname).toBe("/play");
    expect(parsePlaySearchParams(parsed.searchParams)).toMatchObject({
      code,
      bpm: 90,
    });
  });

  it("builds a /score URL whose notation survives the round trip", () => {
    const abcNotation = "X:1\nT:Tune\nK:G\nGABc|";
    const url = buildShareQueryUrl({
      kind: "score",
      args: { abcNotation, style: "folk" },
    });
    const parsed = new URL(url!);
    expect(parsed.pathname).toBe("/score");
    expect(parseScoreSearchParams(parsed.searchParams)).toMatchObject({
      abcNotation,
      style: "folk",
    });
  });

  it("honours the request origin and strips a trailing slash", () => {
    const url = buildShareQueryUrl(
      { kind: "play", args: { code: "x" } },
      "https://music.example.com/",
    );
    expect(url!.startsWith("https://music.example.com/play?")).toBe(true);
  });

  it("returns null when the payload is too long for a query string", () => {
    // Just over the encoded ceiling: 4 base64 chars per 3 source bytes.
    const code = "x".repeat(Math.ceil((SHARE_QUERY_MAX_CHARS * 3) / 4) + 16);
    expect(buildShareQueryUrl({ kind: "play", args: { code } })).toBeNull();
  });

  it("still builds a URL for a payload just under the ceiling", () => {
    const code = "x".repeat(Math.floor((SHARE_QUERY_MAX_CHARS * 3) / 4) - 16);
    expect(buildShareQueryUrl({ kind: "play", args: { code } })).not.toBeNull();
  });

  it("returns null (not a throw) for a payload past the hard byte cap", () => {
    const code = "x".repeat(SHARE_PARAM_MAX_BYTES + 1);
    expect(buildShareQueryUrl({ kind: "play", args: { code } })).toBeNull();
  });
});

describe("stored shares", () => {
  it("addresses a share by a 32-hex-char content digest", async () => {
    const id = await shareId({ kind: "play", args: { code: "s('bd')" } });
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(isValidShareId(id)).toBe(true);
    expect(shareKvKey(id)).toBe(`share:${id}`);
  });

  it("is content-addressed: same payload → same id, different → different", async () => {
    const a = await shareId({ kind: "play", args: { code: "s('bd')" } });
    const b = await shareId({ kind: "play", args: { code: "s('bd')" } });
    const c = await shareId({ kind: "play", args: { code: "s('sd')" } });
    const d = await shareId({ kind: "score", args: { abcNotation: "s('bd')" } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    // The kind is part of the digest, so a play and a score never collide.
    expect(a).not.toBe(d);
  });

  it("builds the /p/<id> URL", async () => {
    const id = await shareId({ kind: "play", args: { code: "x" } });
    expect(buildStoredShareUrl(id, "https://music.example.com")).toBe(
      `https://music.example.com/p/${id}`,
    );
    expect(buildStoredShareUrl(id)).toBe(`${DEFAULT_SHARE_ORIGIN}/p/${id}`);
  });

  it.each([
    "",
    "../secret",
    "share:abc",
    "ABCDEF0123456789abcdef0123456789",
    "0123456789abcdef0123456789abcde",
    "0123456789abcdef0123456789abcdef0",
  ])("rejects %s as a share id", (id) => {
    expect(isValidShareId(id)).toBe(false);
  });
});

describe("buildPlayerCsp", () => {
  it("carries every declared domain into the fetching directives", () => {
    const csp = buildPlayerCsp({
      resourceDomains: ["https://unpkg.com"],
      connectDomains: ["https://felixroos.github.io"],
    });
    expect(csp).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com");
    expect(csp).toContain("https://felixroos.github.io");
    // A resource domain must also be reachable by fetch (soundfont JSON etc).
    expect(csp).toMatch(/connect-src[^;]*https:\/\/unpkg\.com/);
  });

  it("locks down everything the pages don't need", () => {
    const csp = buildPlayerCsp({});
    expect(csp.startsWith("default-src 'none'")).toBe(true);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
  });

  it("emits no empty or dangling directives when a list is absent", () => {
    for (const directive of buildPlayerCsp({}).split("; ")) {
      expect(directive.trim()).toBe(directive);
      expect(directive).not.toMatch(/\s{2,}/);
      expect(directive.split(" ").length).toBeGreaterThan(1);
    }
  });
});
