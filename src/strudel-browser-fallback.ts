// =============================================================================
// Strudel browser fallback — standalone HTML with @strudel/repl
// In browser mode (not iframe sandbox), the full REPL renders correctly.
// =============================================================================

import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface StrudelPlayerOptions {
  code: string;
  bpm?: number;
  autoplay?: boolean;
  show_code?: boolean;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function generateStrudelPlayerHtml(options: StrudelPlayerOptions): string {
  const { code, bpm, autoplay = true } = options;

  let finalCode = code;
  if (bpm) {
    const cps = Math.round((bpm / 60 / 4) * 10000) / 10000;
    if (/setcps\s*\(/.test(finalCode)) {
      finalCode = finalCode.replace(/setcps\s*\([^)]*\)/, `setcps(${cps})`);
    } else {
      finalCode = `setcps(${cps})\n${finalCode}`;
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Strudel Live Pattern — MCP Music Studio</title>
<style>
  :root { color-scheme: dark; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    background: #1a1a1a;
    color: #e0e0e0;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }
  header {
    padding: 12px 16px;
    border-bottom: 1px solid #333;
    background: #252525;
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
  }
  h1 { font-size: 16px; font-weight: 600; }
  .subtitle { font-size: 12px; color: #999; }
  .controls { margin-left: auto; display: flex; gap: 8px; align-items: center; }
  button {
    padding: 6px 16px;
    border: 1px solid #444;
    border-radius: 6px;
    background: #333;
    color: #e0e0e0;
    cursor: pointer;
    font-size: 13px;
    transition: all 0.15s;
  }
  button:hover { border-color: #7c3aed; color: #a78bfa; }
  button.active { background: #7c3aed; color: white; border-color: #7c3aed; }
  #status { font-size: 12px; color: #999; }
  #status.playing { color: #10b981; }
  main { flex: 1; display: flex; flex-direction: column; }
  strudel-editor { display: block; width: 100%; min-height: 400px; }
</style>
</head>
<body>
<header>
  <div>
    <h1>Strudel Live Pattern</h1>
    <div class="subtitle">MCP Music Studio</div>
  </div>
  <div class="controls">
    <button id="play-btn" onclick="togglePlay()">Play</button>
    <button onclick="stopPattern()">Stop</button>
    <span id="status">Loading...</span>
  </div>
</header>
<main>
  <strudel-editor id="editor"><!--
${escapeHtml(finalCode)}
--></strudel-editor>
</main>
<script src="https://unpkg.com/@strudel/repl@1.3.0"></script>
<script>
  const editorEl = document.getElementById('editor');
  const playBtn = document.getElementById('play-btn');
  const statusEl = document.getElementById('status');
  let playing = false;

  function getEditor() { return editorEl?.editor || null; }

  function waitForEditor() {
    return new Promise((resolve) => {
      const check = () => {
        const ed = getEditor();
        if (ed?.setCode) resolve(ed);
        else setTimeout(check, 150);
      };
      check();
    });
  }

  function togglePlay() {
    if (playing) stopPattern();
    else startPattern();
  }

  async function startPattern() {
    const ed = getEditor();
    if (!ed) { statusEl.textContent = 'Initializing...'; return; }
    try {
      const code = ed.code || editorEl.textContent;
      ed.evaluate(code, true);
      playing = true;
      playBtn.textContent = 'Playing';
      playBtn.classList.add('active');
      statusEl.textContent = 'Playing...';
      statusEl.className = 'playing';
    } catch (e) {
      statusEl.textContent = 'Error: ' + e.message;
    }
  }

  function stopPattern() {
    const ed = getEditor();
    if (!ed) return;
    try {
      ed.stop();
      playing = false;
      playBtn.textContent = 'Play';
      playBtn.classList.remove('active');
      statusEl.textContent = 'Stopped';
      statusEl.className = '';
    } catch (e) {
      statusEl.textContent = 'Error: ' + e.message;
    }
  }

  waitForEditor().then(() => {
    statusEl.textContent = 'Click Play to start';
  });

  ${autoplay ? `
  document.addEventListener('click', function autoStart() {
    startPattern();
  }, { once: true });
  ` : ''}
</script>
</body>
</html>`;
}

export async function openStrudelInBrowser(
  options: StrudelPlayerOptions,
  outputDir?: string,
): Promise<string> {
  const html = generateStrudelPlayerHtml(options);

  const dir = outputDir ?? path.join(os.homedir(), "Desktop", "mcp-music-studio");
  await fs.mkdir(dir, { recursive: true });

  const filename = `strudel-${Date.now()}.html`;
  const filepath = path.join(dir, filename);
  await fs.writeFile(filepath, html, "utf-8");

  const cmd =
    process.platform === "darwin"
      ? `open "${filepath}"`
      : process.platform === "win32"
        ? `start "" "${filepath}"`
        : `xdg-open "${filepath}"`;

  exec(cmd, () => {});

  return filepath;
}
