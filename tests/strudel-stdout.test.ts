import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateStrudelCode } from "../src/shared/strudel-validate";

/**
 * Its own file on purpose: vitest isolates each test file's module graph, so
 * this is the only place the FIRST import of @strudel/core can be observed.
 *
 * `@strudel/core` prints "🌀 @strudel/core loaded 🌀" through console.log the
 * moment it is imported. main.ts's standing invariant is that "a stdio
 * transport's stdout stays pure JSON-RPC" — and that banner landed in front of
 * the first tool response until strudel-validate stopped importing the
 * evaluator statically. A static `import` anywhere in the chain brings it back,
 * silently, and only on a real stdio client.
 */
describe("the @strudel import banner never reaches stdout", () => {
  it("writes nothing to console.log on the first validation", async () => {
    const written: unknown[][] = [];
    const log = console.log;
    const info = console.info;
    console.log = (...args: unknown[]) => void written.push(args);
    console.info = console.log;
    try {
      const v = await validateStrudelCode('s("bd sd")');
      expect(v.ok).toBe(true);
    } finally {
      console.log = log;
      console.info = info;
    }
    expect(written).toEqual([]);
  });
});

/**
 * The other half of the same invariant, over a real stdio transport.
 *
 * Validation runs in a forked child now, and a child inherits its parent's file
 * descriptors by default — so `console.log` from a pattern, or any banner from
 * a package the child imports, would land in the SERVER's stdout, which is the
 * JSON-RPC channel. strudel-validate-host.ts forks with
 * `stdio: ["ignore", "ignore", "pipe", "ipc"]` for exactly that reason. Nothing
 * in-process can prove it: the assertion has to be made against a real process,
 * over a real pipe, against the BUILT binary — which also pins that the
 * packaged child (dist/strudel-validate-child.js) resolves at all, since a
 * source-tree run takes a different branch of resolveChildEntry().
 */
const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));

interface RpcResponse {
  id?: number;
  result?: { content?: { type: string; text?: string }[] };
}

/** Minimal newline-delimited JSON-RPC client, so this needs no SDK transport. */
function startServer() {
  const cp = spawn(process.execPath, [BIN, "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
  const lines: string[] = [];
  const waiting = new Map<number, (r: RpcResponse) => void>();
  let buffer = "";
  cp.stdout.setEncoding("utf8");
  cp.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const line of parts) {
      if (!line.trim()) continue;
      lines.push(line);
      let parsed: RpcResponse;
      try {
        parsed = JSON.parse(line) as RpcResponse;
      } catch {
        continue; // still recorded in `lines`; the purity assertion catches it
      }
      if (typeof parsed.id === "number") waiting.get(parsed.id)?.(parsed);
    }
  });

  return {
    lines,
    stop: () => void cp.kill("SIGKILL"),
    call(id: number, method: string, params?: unknown): Promise<RpcResponse> {
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        cp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    notify(method: string): void {
      cp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
    },
  };
}

const textOf = (r: RpcResponse): string =>
  r.result?.content?.find((c) => c.type === "text")?.text ?? "";

// The built binary is the subject; CI runs `bun run build` before vitest.
describe.skipIf(!existsSync(BIN))("the built server's stdout over real stdio", () => {
  it("stays pure JSON-RPC while validating hostile patterns", async () => {
    const server = startServer();
    try {
      await server.call(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "stdout-purity", version: "0" },
      });
      server.notify("notifications/initialized");

      const play = (id: number, code: string) =>
        server.call(id, "tools/call", { name: "play-live-pattern", arguments: { code } });

      // A pattern that would announce itself if it could see the server, and
      // that tries to write to stdout on its way past.
      const probe = await play(
        2,
        `console.log("STDOUT-POLLUTION")\n` +
          `if (typeof process !== 'undefined') { throw new Error('SERVER-PROCESS-VISIBLE') }\n` +
          `s("bd sd").bank("RolandTR909")`,
      );
      expect(textOf(probe)).not.toMatch(/SERVER-PROCESS-VISIBLE/);
      expect(textOf(probe)).toMatch(/RolandTR909:bd/);

      // A pattern that wedges its child. The server must answer this one AND
      // the next, on the same connection.
      const wedged = await play(3, "while(true){}; note('c4')");
      expect(textOf(wedged)).toMatch(/timed out/);

      const after = await play(4, 's("hh*4")');
      expect(textOf(after)).toMatch(/sounds: hh/);

      // Every byte the server wrote to stdout is a JSON-RPC message.
      expect(server.lines.length).toBeGreaterThanOrEqual(4);
      for (const line of server.lines) {
        const parsed = JSON.parse(line) as { jsonrpc?: string };
        expect(parsed.jsonrpc).toBe("2.0");
      }
    } finally {
      server.stop();
    }
  }, 60_000);
});
