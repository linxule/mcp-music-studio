import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createServer } from "../server";
import { createMusicServer } from "../worker/src/index";
import { ABC_GUIDE_TOPICS } from "../src/abc-guide";
import { STRUDEL_GUIDE_TOPICS } from "../src/strudel-guide";
import { MUSIC_PROMPTS } from "../src/shared/tool-defs";

// =============================================================================
// Local (stdio/HTTP) vs Cloudflare Worker parity
// =============================================================================
//
// Both transports import their tool definitions from src/shared/tool-defs, but
// they each do their own registration wiring: server.ts goes through
// @modelcontextprotocol/ext-apps' registerAppTool/registerAppResource and reads
// widget HTML from disk, while the Worker calls registerTool/resource directly
// with the HTML inlined at build time. Nothing structural forced those two call
// sites to agree — the `_meta` resourceUri pair was hand-written in both places
// and had already drifted (the Worker emitted the legacy flat spelling, the
// local server didn't). This test drives real clients over InMemoryTransport and
// diffs the wire-level listings, so drift fails here instead of in a host.
//
// The Worker's `env` is only read inside tool handlers (KV cache, analytics,
// API key). Listing never touches it, so an empty object is enough.
const WORKER_ENV = {} as never;

async function connect(server: McpServer) {
  const client = new Client({ name: "parity-test", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
}

// The local server's play-tool descriptions vary with --render-mode; "auto" is
// the default and the mode whose wording matches the (always ext-apps) Worker.
const local = await connect(createServer({ defaultRenderMode: "auto" }));
const worker = await connect(createMusicServer(WORKER_ENV));

const byName = <T extends { name: string }>(xs: T[]) =>
  [...xs].sort((a, b) => a.name.localeCompare(b.name));
const byUri = <T extends { uri: string }>(xs: T[]) =>
  [...xs].sort((a, b) => a.uri.localeCompare(b.uri));

describe("tools/list parity", () => {
  it("exposes the same tool names on both transports", async () => {
    const l = byName((await local.listTools()).tools).map((t) => t.name);
    const w = byName((await worker.listTools()).tools).map((t) => t.name);
    expect(l).toEqual(w);
    // Guard against a listing that is empty on both sides passing vacuously.
    // Counts stay open-ended on purpose — adding a tool should not fail parity.
    expect(l).toContain("play-sheet-music");
    expect(l).toContain("play-live-pattern");
    expect(l.length).toBeGreaterThanOrEqual(5);
  });

  it("exposes identical tool definitions (title, description, schema, annotations, _meta)", async () => {
    const l = byName((await local.listTools()).tools);
    const w = byName((await worker.listTools()).tools);
    expect(l).toEqual(w);
  });

  it("links both play tools to their UI resource in both _meta spellings", async () => {
    for (const client of [local, worker]) {
      const tools = (await client.listTools()).tools;
      const sheet = tools.find((t) => t.name === "play-sheet-music");
      const strudel = tools.find((t) => t.name === "play-live-pattern");
      expect(sheet?._meta).toEqual({
        ui: { resourceUri: "ui://sheet-music/mcp-app.html" },
        "ui/resourceUri": "ui://sheet-music/mcp-app.html",
      });
      expect(strudel?._meta).toEqual({
        ui: { resourceUri: "ui://strudel/strudel-app.html" },
        "ui/resourceUri": "ui://strudel/strudel-app.html",
      });
    }
  });

  it("marks the play tools non-idempotent (each call starts audio)", async () => {
    for (const client of [local, worker]) {
      const tools = (await client.listTools()).tools;
      for (const name of ["play-sheet-music", "play-live-pattern"]) {
        expect(tools.find((t) => t.name === name)?.annotations).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        });
      }
    }
  });
});

describe("resources/list parity", () => {
  it("exposes identical resource listings", async () => {
    const l = byUri((await local.listResources()).resources);
    const w = byUri((await worker.listResources()).resources);
    expect(l).toEqual(w);
    expect(l.map((r) => r.uri)).toContain("ui://sheet-music/mcp-app.html");
    expect(l.map((r) => r.uri)).toContain("ui://strudel/strudel-app.html");
    // Both guide families are mirrored as resources, one per topic — derived
    // from the topic lists so adding a topic doesn't need a test edit, but a
    // transport that forgets to mirror one still fails.
    expect(l.filter((r) => r.uri.startsWith("music://guide/")).length).toBe(
      ABC_GUIDE_TOPICS.length,
    );
    expect(
      l.filter((r) => r.uri.startsWith("music://strudel-guide/")).length,
    ).toBe(STRUDEL_GUIDE_TOPICS.length);
  });

  it("serves both UI resources with the ext-apps mime type and CSP _meta", async () => {
    for (const client of [local, worker]) {
      const sheet = await client.readResource({
        uri: "ui://sheet-music/mcp-app.html",
      });
      expect(sheet.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
      expect(sheet.contents[0]?._meta).toEqual({
        ui: { csp: { connectDomains: ["https://paulrosen.github.io"] } },
      });

      const strudel = await client.readResource({
        uri: "ui://strudel/strudel-app.html",
      });
      expect(strudel.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
      const csp = (
        strudel.contents[0]?._meta as {
          ui: { csp: { resourceDomains: string[]; connectDomains: string[] } };
        }
      ).ui.csp;
      expect(csp.resourceDomains).toContain("https://unpkg.com");
      expect(csp.connectDomains).toContain("https://felixroos.github.io");
    }
  });
});

describe("prompts/list parity", () => {
  it("exposes identical prompt listings", async () => {
    const l = byName((await local.listPrompts()).prompts);
    const w = byName((await worker.listPrompts()).prompts);
    expect(l).toEqual(w);
    expect(l.map((p) => p.name)).toEqual(
      MUSIC_PROMPTS.map((p) => p.name).sort((a, b) => a.localeCompare(b)),
    );
    expect(l.length).toBeGreaterThan(0);
  });
});

describe("tool results — the click-to-play link", () => {
  // Listings are origin-independent (that is what keeps the two transports
  // diffable above), but RESULTS carry a share URL, and the Worker builds it
  // from the origin the request arrived on. That is one of the two deliberate
  // ways the transports' output differs (the other is Strudel validation, at
  // the bottom of this block) — both pinned here so they stay deliberate.

  const linkOf = (content: unknown) =>
    (content as { type: string; uri?: string }[]).find(
      (c) => c.type === "resource_link",
    );

  it("both transports return a resource_link plus the URL in the text", async () => {
    for (const client of [local, worker]) {
      const res = await client.callTool({
        name: "play-live-pattern",
        arguments: { code: 's("bd sd")' },
      });
      const link = linkOf(res.content);
      expect(link?.uri).toContain("/play?c=");
      const text = (res.content as { type: string; text?: string }[])[0]!.text!;
      expect(text).toContain(link!.uri!);
      // The honest tail is replaced, not merely appended to.
      expect(text).not.toContain("nothing has played yet");
    }
  });

  // T6: the local server now RUNS the Strudel it is handed, so a terminal
  // client gets a real report. The Worker deliberately does not, and this is
  // the second whitelisted difference between the transports — the first being
  // the share-link origin above.
  //
  // The reason is not bundle size (the @strudel packages fit the isolate: +215
  // KiB gzip, measured with `wrangler deploy --dry-run`). It is that Strudel's
  // evaluate() runs the transpiled pattern through `new Function`, and workerd
  // answers "EvalError: Code generation from strings disallowed for this
  // context" — a platform rule with no flag. So the Worker says so instead of
  // quietly returning a weaker receipt.
  const textOf = (r: { content: unknown }) =>
    (r.content as { type: string; text?: string }[])[0]!.text!;

  it("the local server reports what the pattern does", async () => {
    const res = await local.callTool({
      name: "play-live-pattern",
      arguments: {
        code: 'setcps(0.5)\nstack(s("bd*4"), s("~ cp ~ cp").bank("RolandTR909"))',
      },
    });
    expect(textOf(res)).toContain("parses OK: 2 layers, 6 events/cycle, cps 0.5");
    expect(textOf(res)).toContain("sounds: RolandTR909:cp bd (all registered)");
  });

  it("the Worker says it could not check, rather than implying it did", async () => {
    const res = await worker.callTool({
      name: "play-live-pattern",
      arguments: { code: 's("bd sd")' },
    });
    expect(res.isError).toBeUndefined();
    expect(textOf(res)).toContain("Not verified:");
    expect(textOf(res)).toContain("dynamic code generation");
    expect(textOf(res)).not.toContain("parses OK");
  });

  it("only the local server can reject broken Strudel", async () => {
    const args = { code: 'stack(\n  s("bd*4"),\n  s("hh*8"]\n)' };

    const l = await local.callTool({ name: "play-live-pattern", arguments: args });
    expect(l.isError, "code that does not evaluate must not read as ready").toBe(true);
    expect(textOf(l)).toContain("failed to evaluate");
    expect(textOf(l)).toContain("(3:10)");
    // Unlike a broken SCORE, broken Strudel keeps its link: the page it opens
    // is an editable REPL, which is where the fix happens.
    expect(linkOf(l.content)?.uri).toContain("/play?c=");

    // The Worker cannot know it is broken — but it never claimed otherwise.
    const w = await worker.callTool({ name: "play-live-pattern", arguments: args });
    expect(w.isError).toBeUndefined();
    expect(textOf(w)).toContain("Not verified:");
  });

  // T5: the Worker used to return an unconditional "sheet music ready" receipt
  // while the local server ran the same ABC through abcjs. Both now validate.
  it("both transports reject the same broken ABC, identically", async () => {
    const args = { abcNotation: "X:1\nK:C\n{}[|" };
    const results = [];
    for (const client of [local, worker]) {
      const res = await client.callTool({ name: "play-sheet-music", arguments: args });
      expect(res.isError, "broken notation must not be reported as ready").toBe(
        true,
      );
      // No point minting a share link to a page that renders an error.
      expect(linkOf(res.content)).toBeUndefined();
      results.push((res.content as { text?: string }[])[0]?.text);
    }
    expect(results[0]).toContain("ABC notation has errors");
    expect(results[0]).toBe(results[1]);
  });

  it("both transports reject a score with no notes or rests", async () => {
    for (const client of [local, worker]) {
      const res = await client.callTool({
        name: "play-sheet-music",
        arguments: { abcNotation: "X:1\nT:Nothing\nK:C\n" },
      });
      expect(res.isError).toBe(true);
      expect((res.content as { text?: string }[])[0]?.text).toContain(
        "no notes or rests",
      );
    }
  });

  it("differs on a good score ONLY by the local --render-mode hint", async () => {
    const args = { abcNotation: "X:1\nK:C\nCDEF|" };
    const [l, w] = await Promise.all([
      local.callTool({ name: "play-sheet-music", arguments: args }),
      worker.callTool({ name: "play-sheet-music", arguments: args }),
    ]);
    const textOf = (r: typeof l) =>
      (r.content as { type: string; text?: string }[])[0]!.text!;
    // The worker has no --render-mode flag, so it omits that one sentence...
    expect(textOf(w)).not.toContain("--render-mode");
    expect(textOf(l)).toContain("--render-mode browser");
    // ...and with the hint and the (origin-specific) link line removed, the
    // two results are the same text.
    const strip = (t: string) =>
      t
        .replace(
          " Re-run with --render-mode browser to open a playable version in your browser.",
          "",
        )
        .replace(/\n\n▶ Play in browser: \S+/, "")
        .trim();
    expect(strip(textOf(l))).toBe(strip(textOf(w)));
  });

  it("the Worker links the origin it was reached on; stdio links the hosted one", async () => {
    const custom = await connect(
      createMusicServer(WORKER_ENV, "https://music.example.com"),
    );
    const res = await custom.callTool({
      name: "play-live-pattern",
      arguments: { code: 's("bd")' },
    });
    expect(linkOf(res.content)?.uri).toContain("https://music.example.com/play?");

    // A stdio server has no request context, so it points at the deployed worker.
    const localRes = await local.callTool({
      name: "play-live-pattern",
      arguments: { code: 's("bd")' },
    });
    expect(linkOf(localRes.content)?.uri).toContain(
      "https://mcp-music-studio.linxule.workers.dev/play?",
    );
  });
});

describe("serverInfo — documented, deliberate differences", () => {
  it("shares name, version and instructions", () => {
    const l = local.getServerVersion();
    const w = worker.getServerVersion();
    expect(l?.name).toBe(w?.name);
    expect(l?.version).toBe(w?.version);
    expect(local.getInstructions()).toBe(worker.getInstructions());
    expect(local.getInstructions()).toBeTruthy();
  });

  it("differs ONLY in the icon URL — the worker serves its own same-origin /icon.png", () => {
    const l = local.getServerVersion() as { icons?: { src: string }[] };
    const w = worker.getServerVersion() as { icons?: { src: string }[] };

    expect(l.icons?.[0]?.src).toBe(
      "https://raw.githubusercontent.com/linxule/mcp-music-studio/main/assets/icons/logo-256.png",
    );
    expect(w.icons?.[0]?.src).toBe(
      "https://mcp-music-studio.linxule.workers.dev/icon.png",
    );

    // Everything else about serverInfo is identical — normalise the one
    // whitelisted field and the two records must match exactly.
    const norm = (v: unknown) => ({
      ...(v as Record<string, unknown>),
      icons: undefined,
    });
    expect(norm(l)).toEqual(norm(w));
  });
});
