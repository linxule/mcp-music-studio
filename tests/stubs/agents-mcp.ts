// Stand-in for `agents/mcp`, aliased by vitest.config.ts.
//
// `agents` is a dependency of worker/ only — it is never installed at the repo
// root, so importing worker/src/index.ts from a root test would fail on module
// resolution alone. The parity and request-layer tests exercise
// `createMusicServer` and the non-/mcp routes; `createMcpHandler` only wires the
// MCP transport onto /mcp, which the SDK covers and which InMemoryTransport
// stands in for.

export function createMcpHandler(): (
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
