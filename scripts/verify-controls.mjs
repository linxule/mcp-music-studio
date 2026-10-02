// Acceptance check for fader()/pad()/xy() in a real browser, through the real
// widget, in a live session: the strip renders, moving a fader changes what is
// HEARD (measured), and moves reach get-session.
//
//   bun run build
//   bunx vite --config dev/vite.config.ts --port 5177
//   SESSION_ORIGIN=https://music-studio.linxule.com bun scripts/verify-controls.mjs   (or a local wrangler dev)
import { chromium } from "playwright";

const HARNESS = process.env.HARNESS ?? "http://localhost:5177/";
const ORIGIN = process.env.SESSION_ORIGIN ?? "http://127.0.0.1:8799";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};
const ok = (msg) => console.log(`✓ ${msg}`);

const LEVEL_TAP = `(() => {
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

const res = await fetch(`${ORIGIN}/session/new`, { method: "POST" });
const { id } = await res.json();
const state = async () => (await (await fetch(`${ORIGIN}/session/${id}/state?peek=1`)).json()).text;

const CODE = `setcps(0.5)
const vol = fader('vol')
const drop = pad('drop', { toggle: true })
const hold = pad('hold')
const space = xy('space')
s("hh*8").gain(vol).pan(space.x)`;

const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
await context.addInitScript(LEVEL_TAP);
const page = await context.newPage();
await page.goto(HARNESS);
await page.waitForFunction(() => document.getElementById("state")?.textContent?.startsWith("connected"), null, { timeout: 30000 });
await page.evaluate(([sid, origin]) => window.__harness.setResultMeta({ session: { id: sid, origin } }), [id, ORIGIN]);
await page.fill("#args", JSON.stringify({ code: CODE, autoplay: true }));
await page.click("#send");
const frame = () => page.frames().find((f) => f.url().includes("/widgets/"));
for (let i = 0; i < 100 && !frame(); i++) await sleep(100);
await frame().waitForSelector(".ms-controls", { timeout: 20000 });
const kinds = await frame().evaluate(() => [...document.querySelectorAll(".ms-controls > *")].map((e) => e.className));
kinds.join(",") === "ms-fader,ms-pad,ms-pad,ms-xy" ? ok(`strip shows ${kinds.join(", ")}`) : fail(`strip: ${kinds}`);

await sleep(2500);
const quiet = await frame().evaluate(() => { const p = globalThis.__peak; globalThis.__peak = 0; return p; });
quiet < 0.01 ? ok(`fader at 0 → silent (peak ${quiet.toFixed(3)})`) : fail(`fader at 0 but peak ${quiet}`);

// Drag the fader to the top the way a performer would.
const range = await frame().$(".ms-fader input");
const box = await range.boundingBox();
await page.mouse.move(box.x + 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
await page.mouse.up();
await frame().evaluate(() => { globalThis.__peak = 0; });
await sleep(1500);
const loud = await frame().evaluate(() => globalThis.__peak);
loud > 0.05 ? ok(`fader up → audible (peak ${loud.toFixed(3)})`) : fail(`fader up but peak ${loud}`);

// Pads and the xy pad.
const pads = await frame().$$(".ms-pad");
await pads[0].click();
const pb = await pads[1].boundingBox();
await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
await page.mouse.down();
await sleep(300);
await page.mouse.up();
const xyBox = await (await frame().$(".ms-xy")).boundingBox();
await page.mouse.move(xyBox.x + xyBox.width * 0.5, xyBox.y + xyBox.height * 0.5);
await page.mouse.down();
await page.mouse.move(xyBox.x + xyBox.width * 0.1, xyBox.y + xyBox.height * 0.1, { steps: 5 });
await page.mouse.up();

// A re-evaluation keeps the values.
await frame().evaluate(async () => {
  const editor = document.querySelector("strudel-editor")?.editor;
  await editor.evaluate(true);
});
const after = await frame().evaluate(() => [fader('vol').value, pad('drop').value, xy('space').value]);
after[0] > 0.9 && after[1] === 1 && after[2][0] < 0.2 && after[2][1] > 0.8
  ? ok(`values survive re-evaluation: vol ${after[0]}, drop ${after[1]}, space ${after[2].map((v) => v.toFixed(2))}`)
  : fail(`values after re-evaluation: ${JSON.stringify(after)}`);

await sleep(2500);
const text = await state();
/Controls on the player now: vol \(fader 0–1\) 1; drop \(pad\) on; hold \(pad\) off; space \(xy\) x 0\.1/.test(text)
  ? ok("get-session shows the strip as it stands")
  : fail(`strip missing:\n${text}`);
/moved fader 'vol'/.test(text) && /pressed pad 'drop' 1 time/.test(text) && /pressed pad 'hold' 1 time/.test(text) && /moved xy 'space'/.test(text)
  ? ok("every move reached the session")
  : fail(`moves missing:\n${text}`);
/edited the code/.test(text) ? fail("a re-run of unchanged code was logged as an edit") : ok("re-running unchanged code is not an 'edit'");
console.log("\n--- get-session ---\n" + text.slice(0, 1400));
await browser.close();
