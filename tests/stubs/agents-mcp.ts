// Stand-in for `agents/mcp`, aliased by vitest.config.ts.
//
// `agents` is a dependency of worker/ only — it is never installed at the repo
// root, so importing worker/src/index.ts from a root test would fail on module
// resolution alone. The parity and request-layer tests exercise
// `createMusicServer` and the non-/mcp routes; `createLegacyMcpHandler` only wires the
// MCP transport onto /mcp. worker/tests/mcp.test.mjs separately exercises that
// adapter inside real workerd, without this stub.

export function createLegacyMcpHandler(): (
  request: Request,
  env: unknown,
  ctx: unknown,
) => Promise<Response> {
  return async () =>
    new Response(JSON.stringify({ stub: "agents/mcp" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}
