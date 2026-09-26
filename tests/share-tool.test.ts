import { afterEach, describe, expect, it, vi } from "vitest";
import { createShareInputSchema, createShareResult, uploadShare } from "../src/shared/share-tool";
import { DEFAULT_SHARE_ORIGIN, SHARE_PARAM_MAX_BYTES } from "../src/shared/share-url";

afterEach(() => vi.unstubAllGlobals());

describe("explicit sharing", () => {
  it("uploads exactly the selected piece and explains access and expiry", async () => {
    const store = vi.fn(async () => `${DEFAULT_SHARE_ORIGIN}/p/${"a".repeat(32)}`);
    const args = createShareInputSchema.parse({
      kind: "score", score: { abcNotation: "X:1\nK:C\nCDEF|", title: "Sketch" },
    });
    const result = await createShareResult(args, store);
    expect(store).toHaveBeenCalledExactlyOnceWith({ kind: "score", args: args.score });
    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result.content)).toContain("Anyone with this link");
    expect(JSON.stringify(result.content)).toContain("30 days");
    expect(JSON.stringify(result.content)).toContain("refreshes");
  });

  it("folds the live visual preset into the shared pattern", async () => {
    const store = vi.fn(async () => `${DEFAULT_SHARE_ORIGIN}/p/${"b".repeat(32)}`);
    await createShareResult(createShareInputSchema.parse({
      kind: "play", pattern: { code: 's("bd")', visuals: "pianoroll" },
    }), store);
    expect(store.mock.calls[0]![0]).toMatchObject({ kind: "play", args: {
      code: expect.stringContaining("pianoroll"),
    } });
  });

  it.each([
    { kind: "play" as const },
    { kind: "score" as const, pattern: { code: 's("bd")' } },
    { kind: "play" as const, pattern: { code: 's("bd")' }, score: { abcNotation: "X:1\nK:C\nC|" } },
  ])("does not store missing, mismatched or ambiguous inputs", async (args) => {
    const store = vi.fn();
    const result = await createShareResult(args, store);
    expect(result.isError).toBe(true);
    expect(store).not.toHaveBeenCalled();
  });

  it("rejects an oversized UTF-8 upload before storage", async () => {
    const store = vi.fn();
    const result = await createShareResult({
      kind: "play", pattern: { code: "音".repeat(SHARE_PARAM_MAX_BYTES / 2) },
    }, store);
    expect(result.isError).toBe(true);
    expect(store).not.toHaveBeenCalled();
  });

  it("reports storage failure instead of returning a dead link", async () => {
    const result = await createShareResult({ kind: "play", pattern: { code: 's("bd")' } },
      async () => { throw new Error("Storage unavailable."); });
    expect(result.isError).toBe(true);
    expect(result.content.some(c => c.type === "resource_link")).toBe(false);
  });

  it("local sharing sends only the selected payload to the fixed service", async () => {
    const url = `${DEFAULT_SHARE_ORIGIN}/p/${"a".repeat(32)}`;
    const fetcher = vi.fn(async () => Response.json({ url }));
    vi.stubGlobal("fetch", fetcher);
    const payload = { kind: "play" as const, args: { code: 's("bd")' } };
    expect(await uploadShare(payload)).toBe(url);
    expect(fetcher).toHaveBeenCalledWith(`${DEFAULT_SHARE_ORIGIN}/share`, expect.objectContaining({
      method: "POST", redirect: "error", body: JSON.stringify(payload),
    }));
  });

  it("reports a rate limit and rejects an unexpected returned origin", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("limited", { status: 429 }))
      .mockResolvedValueOnce(Response.json({ url: "https://unexpected.example/p/abc" }));
    vi.stubGlobal("fetch", fetcher);
    const payload = { kind: "play" as const, args: { code: 's("bd")' } };
    await expect(uploadShare(payload)).rejects.toThrow("Too many share requests");
    await expect(uploadShare(payload)).rejects.toThrow("invalid link");
  });
});
