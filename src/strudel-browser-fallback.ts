// =============================================================================
// Strudel browser fallback — standalone HTML with @strudel/repl
// In browser mode (not iframe sandbox), the full REPL renders correctly.
// =============================================================================

// Runtime-agnostic: no node: imports here, so the Cloudflare Worker can render
// the same page for its /play route. The disk-writing + browser-launching half
// lives in src/open-in-browser.ts.
import { safeJsonForScript } from "./shared/safe-json.js";
import { injectTempo } from "./shared/tempo.js";

export interface StrudelPlayerOptions {
  code: string;
  bpm?: number;
  autoplay?: boolean;
  show_code?: boolean;
}

export function generateStrudelPlayerHtml(options: StrudelPlayerOptions): string {
  const { code, bpm, autoplay = true } = options;

  // Tempo policy (replace an unambiguous top-level setter, otherwise prepend)
  // lives in src/shared/tempo.ts and is shared with the ext-apps widget.
  const finalCode = bpm ? injectTempo(code, bpm).code : code;

  // The pattern travels as JSON in a <script type="application/json"> block, not
  // as HTML-escaped text inside <strudel-editor>. `<strudel-editor>` reads its
  // own innerHTML verbatim and never entity-decodes it, so an HTML-escaped
  // `sound(&quot;bd&quot;)` reached the evaluator literally and threw a
  // SyntaxError — every pattern containing a quote was dead on arrival.
  const initData = safeJsonForScript({ code: finalCode, autoplay });

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
  <strudel-editor id="editor"></strudel-editor>
</main>
<script type="application/json" id="init-data">${initData}</script>
<script src="https://unpkg.com/@strudel/repl@1.3.0"></script>
<script>
  const INIT = JSON.parse(document.getElementById('init-data').textContent);
  const editorEl = document.getElementById('editor');
  const playBtn = document.getElementById('play-btn');
  const statusEl = document.getElementById('status');
  let playing = false;
  let ready = false;

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
    if (!ed || !ready) { statusEl.textContent = 'Initializing...'; return; }
    try {
      // StrudelMirror.evaluate() takes ONE boolean (shouldPlay) and always
      // evaluates its own buffer — passing the code as the first argument
      // silently made the boolean the second, ignored, parameter.
      ed.evaluate(true);
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

  waitForEditor().then((ed) => {
    ed.setCode(INIT.code);
    ready = true;
    statusEl.textContent = 'Click Play to start';
  });

  ${
    autoplay
      ? `
  // Browsers keep the AudioContext suspended until a user gesture, so autoplay
  // means "start on the first click anywhere". The Play button's own click also
  // bubbles to document — without these guards it evaluated the pattern twice.
  function autoStart(ev) {
    if (playing) { document.removeEventListener('click', autoStart); return; }
    if (ev.target && ev.target.closest && ev.target.closest('.controls')) return;
    startPattern();
    if (playing) document.removeEventListener('click', autoStart);
  }
  document.addEventListener('click', autoStart);
  `
      : ""
  }
</script>
</body>
</html>`;
}
