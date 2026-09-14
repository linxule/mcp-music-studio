import assert from "node:assert/strict";
import { test } from "node:test";
import { unstable_dev } from "wrangler";

test("real worker preserves JSON MCP tools and widget resources", { timeout: 60_000 }, async () => {
  const worker = await unstable_dev("src/entry.ts", {
    config: "wrangler.jsonc", local: true, ip: "127.0.0.1", port: 0,
    persist: false, logLevel: "error",
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true },
  });
  let id = 0;
  async function rpc(method, params = {}, path = "/mcp") {
    const response = await worker.fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/json/);
    const message = await response.json();
    assert.equal(message.error, undefined, JSON.stringify(message));
    return message.result;
  }
  try {
    for (const path of ["/mcp", "/mcp/"]) {
      const result = await rpc("initialize", {
        protocolVersion: "2025-03-26", capabilities: {},
        clientInfo: { name: "worker-regression", version: "1.0.0" },
      }, path);
      assert.equal(result.serverInfo.name, "Music Studio");
    }
    const { tools } = await rpc("tools/list");
    assert.equal(tools.length, 7);
    assert.ok(tools.some(tool => tool.name === "play-sheet-music"));
    assert.ok(tools.some(tool => tool.name === "play-live-pattern"));
    const score = await rpc("tools/call", {
      name: "play-sheet-music", arguments: { abcNotation: "X:1\nT:Regression\nM:4/4\nL:1/4\nK:C\nC D E F|" },
    });
    assert.notEqual(score.isError, true);
    assert.ok(score.content.some(item => item.type === "resource_link"));
    const bad = await rpc("tools/call", { name: "play-sheet-music", arguments: { tempo: 9999 } });
    assert.equal(bad.isError, true);
    for (const uri of ["ui://sheet-music/mcp-app.html", "ui://strudel/strudel-app.html"]) {
      const { contents } = await rpc("resources/read", { uri });
      assert.equal(contents[0].mimeType, "text/html;profile=mcp-app");
      assert.match(contents[0].text, /<!doctype html>/i);
      assert.ok(contents[0].text.length > 100_000);
    }
    const health = await (await worker.fetch("/health")).json();
    assert.equal(health.status, "ok");
    assert.ok(health.widgets);
  } finally {
    await worker.stop();
  }
});
