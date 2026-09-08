// Render title cards as 1280x800 PNGs with Playwright (ffmpeg drawtext needs
// fonts we don't want to hunt for; a browser already has them).
import { chromium } from '/Users/xulelin/node_modules/playwright/index.mjs';
import fs from 'node:fs';

const OUT = '/tmp/ms-showcase/cards';
const manifest = JSON.parse(fs.readFileSync('/tmp/ms-showcase/manifest.json', 'utf8'));

const page = (title, sub, kicker = '') => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:1280px;height:800px;background:#0b0b10;color:#f2f0ff;font-family:-apple-system,"SF Pro Display",Inter,Helvetica,Arial,sans-serif;overflow:hidden}
  .wrap{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 120px;box-sizing:border-box}
  .glow{position:absolute;width:900px;height:900px;border-radius:50%;filter:blur(160px);opacity:.45;background:radial-gradient(circle,#7c5cff,#1c2b6b 60%,transparent 70%);left:600px;top:-150px}
  .kicker{font-size:22px;letter-spacing:.18em;text-transform:uppercase;color:#a99cff;margin-bottom:22px;font-weight:600}
  h1{font-size:64px;line-height:1.08;margin:0 0 26px;font-weight:700;letter-spacing:-.01em;position:relative}
  p{font-size:28px;line-height:1.4;margin:0;color:#c9c5e6;max-width:920px;position:relative}
  code{font-family:"SF Mono",Menlo,monospace;font-size:.9em;color:#ffd580}
</style></head><body><div class="glow"></div><div class="wrap">
  ${kicker ? `<div class="kicker">${kicker}</div>` : ''}<h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}
</div></body></html>`;

const md = s => s.replace(/`([^`]+)`/g, '<code>$1</code>');

const cards = [
  ['00-intro', page('MCP Music Studio <span style="color:#a99cff">v0.5</span>', 'What\'s new: Hydra shaders behind the code, audio-reactive visuals, honest feedback to the model, a sheet-music editor.', 'mcp-music-studio')],
  ...manifest.filter(m => m.card).map(m => [`${m.id}`, page(md(m.card[0]), md(m.card[1]), 'new in 0.5')]),
  ['99-outro', page('Try it', '<code>npx mcp-music-studio</code> · remote: <code>mcp-music-studio.linxule.workers.dev/mcp</code><br>Recorded in the dev ext-apps harness, headless Chromium — every frame is the shipped widget.', 'github.com/linxule/mcp-music-studio')],
];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const p = await ctx.newPage();
fs.mkdirSync(OUT, { recursive: true });
for (const [name, html] of cards) {
  await p.setContent(html, { waitUntil: 'load' });
  await p.waitForTimeout(150);
  await p.screenshot({ path: `${OUT}/${name}.png` });
  console.log('card', name);
}
await browser.close();
