// Acceptance check for the WebMCP relay on the share page, in a real browser,
// against the real Worker (wrangler dev):
//   - /play hosts the widget AND offers its MCP Apps tools on the TOP-LEVEL
//     document.modelContext (the only place a browser agent looks);
//   - the review tools stay off, descriptions say what they control;
//   - nothing runs until Play is pressed on the page: play-current-music and
//     swap-pattern are NOT offered until Play was pressed in the player
//     (a real, trusted click); then they appear;
//   - an agent's get-studio-state -> set-pattern (instanceId + revision) ->
//     play-current-music -> stop-music works, audibly (measured), and a stale
//     revision comes back as a readable result;
//   - every relayed tool, writes included, carries untrustedContentHint;
//   - dispose() takes the tools off the page again;
//   - /score does the same for the sheet widget: set-score, stop, undo before ▶;
//     play-current-music only after a press of ▶ in the score; then audible.
//
//   bun run build
//   (cd worker && bun install && bunx wrangler dev --port 8798)
//   bun scripts/verify-share-webmcp.mjs
//
// Chromium exposes document.modelContext behind --enable-experimental-web-platform-features
// (measured on 153: registerTool/getTools/executeTool; executeTool takes the input as a
// JSON STRING there, the spec says object - both are tried).
import { engine } from "./lib/engine.mjs";

const ORIGIN = process.env.ORIGIN ?? "http://127.0.0.1:8798";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};
const ok = (msg) => console.log(`✓ ${msg}`);
const check = (cond, pass, bad) => (cond ? ok(pass) : fail(bad ?? pass));

const LEVEL_TAP = `(() => {
  if (!globalThis.BaseAudioContext) return;
  const desc = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'destination');
  const taps = new WeakMap();
  globalThis.__peak = 0;
  Object.defineProperty(BaseAudioContext.prototype, 'destination', { configurable: true, get() {
    if (this instanceof OfflineAudioContext) return desc.get.call(this);
    let t = taps.get(this);
    if (!t) {
      const real = desc.get.call(this), g = this.createGain(), a = this.createAnalyser();
      a.fftSize = 512; g.connect(real); g.connect(a);
      Object.defineProperty(g, 'maxChannelCount', { value: real.maxChannelCount || 2 });
      const buf = new Float32Array(512);
      setInterval(() => { a.getFloatTimeDomainData(buf); let p = 0; for (const v of buf) p = Math.max(p, Math.abs(v)); globalThis.__peak = Math.max(globalThis.__peak, p); }, 10);
      t = g; taps.set(this, t);
    }
    return t;
  } });
})();`;

const b64 = (s) => Buffer.from(s, "utf8").toString("base64url");
const SEED = `s("bd*2").gain(0.3)`;
const NEXT = `s("bd*4, hh*8").gain(0.8)`;

const browser = await engine.launch({
  headless: true,
  args: ["--enable-experimental-web-platform-features", "--autoplay-policy=no-user-gesture-required"],
});
const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
await context.addInitScript(LEVEL_TAP);
const page = await context.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

const res = await page.goto(`${ORIGIN}/play?c=${b64(SEED)}&title=${encodeURIComponent("WebMCP check")}`);
check(res.status() === 200, "/play answers 200", `/play answered ${res.status()}`);
check(await page.evaluate(() => !!document.modelContext), "document.modelContext exists in this Chromium", "no document.modelContext: is the flag on?");
if (!(await page.evaluate(() => !!document.modelContext))) {
  await browser.close();
  process.exit(1);
}

// What an agent does: list, then execute by RegisteredTool. Input as a string first (Chromium 153), object second (spec).
const tools = () =>
  page.evaluate(async () =>
    (await document.modelContext.getTools()).map((t) => ({
      name: t.name,
      description: t.description,
      annotations: t.annotations,
      schema: typeof t.inputSchema === "string" ? JSON.parse(t.inputSchema) : t.inputSchema,
    })),
  );
const run = (name, input = {}) =>
  page.evaluate(
    async ([n, i]) => {
      const tool = (await document.modelContext.getTools()).find((t) => t.name === n);
      if (!tool) throw new Error(`not listed: ${n}`);
      let out;
      try {
        out = await document.modelContext.executeTool(tool, JSON.stringify(i));
      } catch {
        out = await document.modelContext.executeTool(tool, i);
      }
      try {
        return JSON.parse(out);
      } catch {
        return out;
      }
    },
    [name, input],
  );

// An agent would watch ontoolchange; polling does the same here. The relay waits for
// the widget to apply the shared pattern before offering tools, so the first read is real.
for (let i = 0; i < 90 && !(await tools()).some((t) => t.name === "get-studio-state"); i++) await sleep(500);
const listed = await tools();
const names = listed.map((t) => t.name).sort();
console.log(`  tools: ${names.join(", ")}`);
for (const want of ["get-studio-state", "set-pattern", "stop-music", "undo-studio-edit"]) {
  check(names.includes(want), `relayed: ${want}`, `missing: ${want}`);
}
check(
  !names.includes("play-current-music") && !names.includes("swap-pattern"),
  "before a press of Play: play-current-music and swap-pattern are NOT offered",
  `offered before a press of Play: ${names.filter((n) => n === "play-current-music" || n === "swap-pattern").join(", ")}`,
);
check(!names.includes("explain-selection") && !names.includes("suggest-edit"), "the review tools are not offered (no review panel here)");
const set = listed.find((t) => t.name === "set-pattern");
check(set?.description?.includes("This controls the music player on this page."), "descriptions carry the 'controls the player on this page' line", `description: ${set?.description}`);
check(set?.schema?.properties?.expectedRevision && set?.schema?.properties?.instanceId, "the widget's input schema came through (instanceId, expectedRevision)", `schema: ${JSON.stringify(set?.schema)}`);
const get = listed.find((t) => t.name === "get-studio-state");
check(get?.annotations?.readOnlyHint === true, "read-only annotation preserved", `annotations: ${JSON.stringify(get?.annotations)}`);
console.log(
  `  untrustedContentHint: get-studio-state ${JSON.stringify(get?.annotations?.untrustedContentHint)}, set-pattern ${JSON.stringify(set?.annotations?.untrustedContentHint)} (this Chromium may not surface annotations)`,
);
// What the relay itself registered (the page's own handle), independent of what Chromium surfaces.
const hints = await page.evaluate(() => window.__share?.relayAnnotations?.() ?? null);
if (hints) check(Object.values(hints).every((a) => a?.untrustedContentHint === true), `every relayed tool is marked untrustedContentHint (${Object.keys(hints).length})`, `annotations: ${JSON.stringify(hints)}`);

let state = await run("get-studio-state");
check(typeof state?.instanceId === "string" && Number.isInteger(state?.revision) && state?.mode === "live", `get-studio-state -> ${state?.mode} rev ${state?.revision}`, `state: ${JSON.stringify(state).slice(0, 200)}`);
check(String(state?.args?.code ?? "").includes('s("bd*2")'), "it is the shared pattern, stopped", `code: ${state?.args?.code}`);
check(state?.playback === "stopped", "nothing plays until asked", `playback: ${state?.playback}`);

const stale = await run("set-pattern", { instanceId: state.instanceId, expectedRevision: state.revision + 9, code: NEXT });
check(stale?.isError === true && /revision/i.test(stale?.error ?? ""), `a stale revision is a readable result: ${String(stale?.error).slice(0, 70)}`, `stale: ${JSON.stringify(stale)}`);

const staged = await run("set-pattern", { instanceId: state.instanceId, expectedRevision: state.revision, code: NEXT });
check(staged?.args?.code?.includes("hh*8") && staged.revision > state.revision, `set-pattern staged it (rev ${staged?.revision}), still stopped: ${staged?.playback}`, `staged: ${JSON.stringify(staged).slice(0, 200)}`);

const frame = page.frames().find((f) => f.url().includes("/widget/strudel"));
// Play is pressed — a real click inside the player, after Strudel loaded.
await frame.waitForSelector(".cm-content", { timeout: 30000 });
await frame.waitForFunction(() => typeof globalThis.getAudioContext === "function", null, { timeout: 30000 });
await sleep(800);
await frame.click("#play-btn");
let opened = [];
for (let i = 0; i < 40; i++) {
  opened = (await tools()).map((t) => t.name);
  if (opened.includes("play-current-music") && opened.includes("swap-pattern")) break;
  await sleep(250);
}
check(
  opened.includes("play-current-music") && opened.includes("swap-pattern"),
  "after a press of Play: play-current-music and swap-pattern appear",
  `after a press of Play: ${opened.join(", ")}`,
);
const pressedState = await run("get-studio-state");
check(pressedState?.playPressed === true && pressedState?.playback === "playing", "the widget says playPressed and is playing", `state: ${JSON.stringify(pressedState).slice(0, 160)}`);
await run("stop-music", { instanceId: pressedState.instanceId });
const ready = await run("get-studio-state");
await frame.evaluate(() => { globalThis.__peak = 0; });
const played = await run("play-current-music", { instanceId: ready.instanceId, expectedRevision: ready.revision });
console.log(`  play-current-music -> playback ${played?.playback}${played?.error ? `, error ${played.error}` : ""}`);
await sleep(3000);
const peak = await frame.evaluate(() => globalThis.__peak ?? 0);
check(peak > 0.05, `audible after the agent's play (peak ${peak.toFixed(3)})`, `no sound after play (peak ${peak}, playback ${played?.playback})`);

const stopped = await run("stop-music", { instanceId: staged.instanceId });
check(stopped?.playback === "stopped", "stop-music stops it", `stop: ${JSON.stringify(stopped).slice(0, 160)}`);
const undone = await run("undo-studio-edit", { instanceId: staged.instanceId, expectedRevision: stopped.revision });
check(String(undone?.args?.code ?? "").includes('s("bd*2")'), "undo-studio-edit restores the shared pattern", `undo: ${JSON.stringify(undone).slice(0, 160)}`);

// Teardown: the page's own handle (what pagehide calls) takes the tools off WebMCP.
// Only OUR tools: in production Cloudflare's zone-level WebMCP bridge
// (/.webmcp/bridge.js) also registers the /mcp server's tools and C2PA tools.
const ours = new Set(await page.evaluate(() => window.__share.relay.tools()));
await page.evaluate(() => window.__share.relay.dispose());
const after = (await tools()).filter((t) => ours.has(t.name));
check(ours.size > 0 && after.length === 0, `dispose() unregisters every relayed tool (${ours.size})`, `still listed: ${after.map((t) => t.name).join(", ")}`);

// ---- A score's full player (/score): the sheet widget's 7 studio tools, same policy ----
const ABC = `X:1\nT:WebMCP score\nM:4/4\nL:1/8\nK:C\n"C"C2E2 G2E2|"F"F2A2 "G"G4|"C"c8|]`;
await page.goto(`${ORIGIN}/score?a=${b64(ABC)}`);
for (let i = 0; i < 90 && !(await tools()).some((t) => t.name === "get-studio-state"); i++) await sleep(500);
const scoreNames = (await tools()).map((t) => t.name).filter((n) => !/^(c2pa|mcp)/i.test(n)).sort();
console.log(`  score tools: ${scoreNames.join(", ")}`);
check(
  JSON.stringify(scoreNames) === JSON.stringify(["get-studio-state", "set-score", "stop-music", "undo-studio-edit"]),
  "score page, before ▶: get-studio-state, set-score, stop-music, undo-studio-edit (no play, no review pair)",
  `score page before ▶: ${scoreNames.join(", ")}`,
);
const scoreHints = await page.evaluate(() => window.__share?.relayAnnotations?.() ?? null);
if (scoreHints) check(Object.values(scoreHints).every((a) => a?.untrustedContentHint === true), "every relayed score tool is marked untrustedContentHint");
const scoreState = await run("get-studio-state");
check(scoreState?.mode === "score" && String(scoreState?.args?.abcNotation ?? "").includes("WebMCP score") && scoreState?.playback === "stopped", "get-studio-state reads the shared score, stopped", `score state: ${JSON.stringify(scoreState).slice(0, 200)}`);
const sheet = page.frames().find((f) => f.url().includes("/widget/sheet"));
await sheet.waitForSelector(".abcjs-midi-start", { timeout: 30000 });
await sheet.click(".abcjs-midi-start");
let scoreOpened = [];
for (let i = 0; i < 60; i++) {
  scoreOpened = (await tools()).map((t) => t.name);
  if (scoreOpened.includes("play-current-music")) break;
  await sleep(250);
}
check(scoreOpened.includes("play-current-music"), "after ▶ on the score: play-current-music appears", `after ▶: ${scoreOpened.join(", ")}`);
const playingScore = await run("get-studio-state");
await run("stop-music", { instanceId: playingScore.instanceId });
const stagedScore = await run("set-score", { instanceId: playingScore.instanceId, expectedRevision: (await run("get-studio-state")).revision, abcNotation: ABC.replace("WebMCP score", "Agent edit") });
check(stagedScore?.args?.abcNotation?.includes("Agent edit") && stagedScore?.playback === "stopped", "set-score staged an edit, stopped", `set-score: ${JSON.stringify(stagedScore).slice(0, 200)}`);
await sheet.evaluate(() => { globalThis.__peak = 0; });
const playedScore = await run("play-current-music", { instanceId: stagedScore.instanceId, expectedRevision: stagedScore.revision });
let scorePeak = 0;
for (let i = 0; i < 30 && scorePeak <= 0.05; i++) {
  await sleep(500);
  scorePeak = await sheet.evaluate(() => globalThis.__peak ?? 0);
}
check(scorePeak > 0.05, `the agent's play-current-music on the score is audible (peak ${scorePeak.toFixed(3)})`, `no sound (peak ${scorePeak}, playback ${playedScore?.playback})`);
await run("stop-music", { instanceId: stagedScore.instanceId });

// "Hash of blocked script: eval-sha256-..." is what Chromium 153 logs for the Strudel REPL's eval
// under --enable-experimental-web-platform-features; the production page logs it too, the flag is the cause.
const real = errors.filter((e) => !/favicon|AudioContext was not allowed|Hash of blocked script: "eval-sha256/i.test(e));
real.length ? fail(`console errors: ${real.slice(0, 3).map((e) => e.slice(0, 400)).join(" | ")}`) : ok("no console errors");
await browser.close();
