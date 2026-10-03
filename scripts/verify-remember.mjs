// Acceptance check for remember() + openStage(), in a real browser, through the
// real widget and the real Durable Object (wrangler dev), with the gallery's
// "Trade a Beat":
//
//   - openStage() shows the stage by itself, so taps reach the drawn grid;
//   - a tap on a drawn cell changes the remembered grid, and the session logs
//     it in the piece's own words (not as a raw tap);
//   - get-session's "Remembered state" block holds the whole grid as JSON;
//   - the AI's merge lands on the swap's bar, on top of the listener's taps,
//     and re-sending the same code does not apply it again;
//   - the music plays throughout.
//
//   bun run build
//   (cd worker && bunx wrangler dev --port 8799)
//   bunx vite --config dev/vite.config.ts --port 5177
//   node scripts/verify-remember.mjs
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const HARNESS = process.env.HARNESS ?? "http://localhost:5177/";
const ORIGIN = process.env.SESSION_ORIGIN ?? "http://127.0.0.1:8799";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};
const ok = (msg) => console.log(`✓ ${msg}`);

const gallery = readFileSync(new URL("../src/strudel-gallery.ts", import.meta.url), "utf8");
const start = gallery.indexOf("const TRADE_A_BEAT = String.raw`") + "const TRADE_A_BEAT = String.raw`".length;
const CODE = gallery.slice(start, gallery.indexOf("`;", start));
if (!CODE.includes("remember('beat'")) throw new Error("could not read TRADE_A_BEAT from the gallery");
// The AI's turn: the same piece with a merge.
const DESCRIBE = "{ describe: v => ROWS.map((r, j) => NAMES[j] + ' on ' + hits(v[r])).join('; ') }";
if (!CODE.includes(DESCRIBE)) throw new Error("the piece's remember() options changed; update this script");
const MERGED = CODE.replace(
  DESCRIBE,
  "{ describe: v => ROWS.map((r, j) => NAMES[j] + ' on ' + hits(v[r])).join('; '), merge: v => { v.oh[7] = 1 }, label: 'open hat on 8' }",
);

const post = async (path, body) => {
  const res = await fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return [res.status, await res.json()];
};
const state = async (id) => (await (await fetch(`${ORIGIN}/session/${id}/state`)).json()).text;
const waitFor = async (id, re, ms = 8000) => {
  let text = "";
  for (let t = 0; t < ms; t += 250) {
    text = await state(id);
    if (re.test(text)) return text;
    await sleep(250);
  }
  return text;
};

const [, { id }] = await post("/session/new");
ok(`session ${id} opened`);

const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
await page.goto(HARNESS);
await page.waitForFunction(() => document.getElementById("state")?.textContent?.startsWith("connected"), null, { timeout: 30000 });
await page.evaluate(([sid, origin]) => window.__harness.setResultMeta({ session: { id: sid, origin } }), [id, ORIGIN]);
await page.fill("#args", JSON.stringify({ code: CODE, autoplay: true }));
await page.click("#send");
const frame = () => page.frames().find((f) => f.url().includes("/widgets/"));
for (let i = 0; i < 100 && !frame(); i++) await sleep(100);

let text = await waitFor(id, /player on[\s\S]*playing/, 30000);
/player on/.test(text) && /playing/.test(text) ? ok("the widget joined and plays") : fail(`no join/playing:\n${text}`);

// openStage(): the stage shows without anyone pressing the button.
let staged = false;
for (let i = 0; i < 40 && !staged; i++) {
  staged = await frame().evaluate(() => document.querySelector(".repl-section")?.classList.contains("stage-on") ?? false);
  if (!staged) await sleep(100);
}
staged ? ok("openStage() opened the stage") : fail("openStage() did not open the stage");

// The initial grid reached the session as remembered state.
text = await waitFor(id, /Remembered state/);
/kick on 1 5 7/.test(text) ? ok("the session holds the grid in the piece's words (kick on 1 5 7)") : fail(`no remembered state:\n${text}`);
/"bd":\[1,0,0,0,1,0,1,0\]/.test(text) ? ok("…and as JSON") : fail(`no JSON for the grid:\n${text}`);

// The listener taps the clap row (5th of 5), step 4 (of 8).
const box = await frame().evaluate(() => {
  const r = document.querySelector(".repl-section").getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const frameBox = await (await page.$("iframe")).boundingBox();
await page.mouse.click(frameBox.x + box.x + box.w * (3.5 / 8), frameBox.y + box.y + box.h * (4.5 / 5));
text = await waitFor(id, /clap on at step 4/);
/the human changed 'beat'/.test(text) && /clap on at step 4/.test(text)
  ? ok("the tap reached the session as the piece's label: \"clap on at step 4\"")
  : fail(`tap label missing:\n${text}`);
/the human tapped/.test(text) ? fail("the same tap was ALSO logged as a raw tap") : ok("…and not twice as a raw tap");
text = await waitFor(id, /clap on 4/);
/clap on 4/.test(text) ? ok("the remembered grid now has the clap on 4") : fail(`state not updated:\n${text}`);

// The tapped cell SOUNDS: the pattern the scheduler plays has a clap on step 4
// of the bar (and the snare row its two steps) — the gallery's first version
// used .mask(), which kept only beat 1 of every row (Codex review).
const scheduled = await frame().evaluate(() => {
  const pat = document.querySelector("strudel-editor")?.editor?.repl?.scheduler?.pattern;
  if (!pat) return null;
  const c = Math.ceil(Number(globalThis.cycle?.() ?? 0)) + 1;
  const at = (s) =>
    pat.queryArc(c, c + 1)
      .filter((h) => h.hasOnset() && h.value?.s === s)
      .map((h) => Math.round((Number(h.whole.begin) - c) * 8))
      .sort((a, b) => a - b);
  return { cp: at("cp"), sd: at("sd") };
});
scheduled && JSON.stringify(scheduled.cp) === "[3]" && JSON.stringify(scheduled.sd) === "[2,6]"
  ? ok(`the scheduler plays the clap on step 4 and the snare on 3 and 7 (${JSON.stringify(scheduled)})`)
  : fail(`scheduled steps: ${JSON.stringify(scheduled)}`);

// The AI answers with a merge, quantized to 2 bars.
const [status, outcome] = await post(`/session/${id}/update`, { code: MERGED, quantize: 2 });
const boundary = outcome.applied?.cycle;
status === 200 && outcome.applied?.ok && Number.isInteger(boundary)
  ? ok(`the merge's update applied at cycle ${boundary}`)
  : fail(`update: ${status} ${JSON.stringify(outcome)}`);
text = await waitFor(id, /your merge applied to 'beat'/);
const merged = text.match(/cycle ([\d.]+): your merge applied to 'beat'[^\n]*/);
merged ? ok(`get-session: "${merged[0].trim()}"`) : fail(`no merge event:\n${text}`);
if (merged && Number.isInteger(boundary)) {
  const at = Number(merged[1]);
  at === boundary
    ? ok(`the merge landed on the bar (cycle ${at} vs bar ${boundary})`)
    : fail(`the merge landed at cycle ${at}, the bar was ${boundary}`);
}
text = await waitFor(id, /open hat on 8/);
/open hat on 8/.test(text) && /clap on 4/.test(text)
  ? ok("the merge sits on top of the listener's clap (open hat on 8, clap on 4)")
  : fail(`merge or tap lost:\n${text}`);

// The same code again: the merge must not apply twice.
const [status2, outcome2] = await post(`/session/${id}/update`, { code: MERGED, quantize: 0 });
status2 === 200 && outcome2.applied?.ok ? ok("the same code re-sent applied") : fail(`re-send: ${status2} ${JSON.stringify(outcome2)}`);
await sleep(3000);
// Reading marks events as read: anything new since the read above would show here.
text = await state(id);
/your merge applied to 'beat'/.test(text) ? fail(`the merge ran again:\n${text}`) : ok("…and its merge did not run again");

const errors = consoleErrors.filter((e) => !/favicon|DevTools/.test(e));
errors.length === 0 ? ok("no console errors") : fail(`console errors:\n${errors.join("\n")}`);
await browser.close();
