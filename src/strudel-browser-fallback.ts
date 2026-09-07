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
  /** Page heading and document title. Falls back to "Strudel Live Pattern". */
  title?: string;
}

const DEFAULT_TITLE = "Strudel Live Pattern";

/** Mirrors escapeHtml() in src/browser-fallback.ts (the ABC page). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function generateStrudelPlayerHtml(options: StrudelPlayerOptions): string {
  const { code, bpm, autoplay = true } = options;

  // Tempo policy lives in src/shared/tempo.ts and is shared with the ext-apps
  // widget. Run it ONCE here and carry the whole result into the page: three of
  // its branches bake the tempo into the source, but "unchanged-ambiguous"
  // deliberately returns the code untouched (the pattern binds or aliases
  // `setcps` itself, so prepending a call would throw), and then `cps` is the
  // ONLY way the requested tempo can reach the pattern — the page applies it
  // through the runtime API after evaluation instead.
  const tempo = bpm ? injectTempo(code, bpm) : null;
  const finalCode = tempo ? tempo.code : code;

  const displayTitle = options.title?.trim() || DEFAULT_TITLE;

  // The pattern travels as JSON in a <script type="application/json"> block, not
  // as HTML-escaped text inside <strudel-editor>. `<strudel-editor>` reads its
  // own innerHTML verbatim and never entity-decodes it, so an HTML-escaped
  // `sound(&quot;bd&quot;)` reached the evaluator literally and threw a
  // SyntaxError — every pattern containing a quote was dead on arrival.
  const initData = safeJsonForScript({
    code: finalCode,
    autoplay,
    cps: tempo ? tempo.cps : null,
    tempoPolicy: tempo ? tempo.policy : null,
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(displayTitle)} — MCP Music Studio</title>
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
  button[hidden] { display: none; }
  button:disabled { opacity: 0.5; cursor: default; }
  #status { font-size: 12px; color: #999; max-width: 46ch; }
  #status.playing { color: #10b981; }
  #status.error { color: #ef4444; }
  main { flex: 1; display: flex; flex-direction: column; }
  strudel-editor { display: block; width: 100%; min-height: 400px; }
</style>
</head>
<body>
<header>
  <div>
    <h1>${escapeHtml(displayTitle)}</h1>
    <div class="subtitle">MCP Music Studio</div>
  </div>
  <div class="controls">
    <button id="play-btn">Play</button>
    <button id="stop-btn">Stop</button>
    <button id="retry-btn" hidden>Retry</button>
    <span id="status" role="status" aria-live="polite">Loading...</span>
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
  const stopBtn = document.getElementById('stop-btn');
  const retryBtn = document.getElementById('retry-btn');
  const statusEl = document.getElementById('status');
  let playing = false;
  let ready = false;

  // How long to wait for <strudel-editor> to define itself before saying the
  // CDN never arrived. The old loop polled forever, so a blocked or offline
  // unpkg left the page sitting on "Loading..." with nothing to click.
  const EDITOR_TIMEOUT_MS = 20000;

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = kind || '';
  }

  function getEditor() { return editorEl?.editor || null; }

  function waitForEditor(timeoutMs) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        const ed = getEditor();
        if (ed?.setCode) { resolve(ed); return; }
        if (Date.now() - start > timeoutMs) {
          reject(new Error('Strudel editor did not initialize'));
          return;
        }
        setTimeout(check, 150);
      };
      check();
    });
  }

  function showLoadError() {
    ready = false;
    setStatus("Couldn't load the Strudel player (network or CDN issue).", 'error');
    retryBtn.hidden = false;
  }

  // The requested tempo could not be written into the source (the pattern binds
  // or aliases setcps itself), so apply it through the runtime API once the
  // scheduler is up. Only this one policy needs it — the others baked it in.
  let tempoNote = '';
  function applyRuntimeTempo(ed) {
    tempoNote = '';
    if (INIT.tempoPolicy !== 'unchanged-ambiguous' || !INIT.cps) return;
    try {
      if (typeof ed?.repl?.setCps === 'function') {
        ed.repl.setCps(INIT.cps);
      } else if (typeof setcps === 'function') {
        setcps(INIT.cps);
      } else {
        return;
      }
      tempoNote = ' (tempo applied at runtime: the pattern defines its own setcps)';
    } catch (e) { /* the pattern still plays, at its own tempo */ }
  }

  function togglePlay() {
    if (playing) stopPattern();
    else startPattern();
  }

  async function startPattern() {
    const ed = getEditor();
    if (!ed || !ready) { setStatus('Initializing...'); return; }
    playBtn.disabled = true;
    try {
      // StrudelMirror.evaluate() takes ONE boolean (shouldPlay) and always
      // evaluates its own buffer — passing the code as the first argument
      // silently made the boolean the second, ignored, parameter.
      //
      // It also NEVER rejects: repl.evaluate() catches everything and parks the
      // failure on repl.state.evalError while logging to the console. A broken
      // pattern therefore used to sit at "Playing..." forever. Read the outcome
      // out of the repl state instead of assuming success.
      await ed.evaluate(true);
      const state = ed.repl?.state || {};
      const err = state.evalError || state.schedulerError;
      if (err) {
        playing = false;
        playBtn.textContent = 'Play';
        playBtn.classList.remove('active');
        setStatus('Error: ' + (err.message || String(err)), 'error');
        return;
      }
      applyRuntimeTempo(ed);
      playing = state.started !== false;
      playBtn.textContent = playing ? 'Playing' : 'Play';
      playBtn.classList.toggle('active', playing);
      setStatus(
        playing ? 'Playing...' + tempoNote : 'Loaded — press Play',
        playing ? 'playing' : '',
      );
    } catch (e) {
      playing = false;
      setStatus('Error: ' + e.message, 'error');
    } finally {
      playBtn.disabled = false;
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
      setStatus('Stopped');
    } catch (e) {
      setStatus('Error: ' + e.message, 'error');
    }
  }

  playBtn.addEventListener('click', togglePlay);
  stopBtn.addEventListener('click', stopPattern);
  retryBtn.addEventListener('click', () => location.reload());

  waitForEditor(EDITOR_TIMEOUT_MS).then((ed) => {
    ed.setCode(INIT.code);
    ready = true;
    retryBtn.hidden = true;
    setStatus('Click Play to start');
  }).catch(showLoadError);

  ${
    autoplay
      ? `
  // Browsers keep the AudioContext suspended until a user gesture, so autoplay
  // means "start on the first click anywhere". The Play button's own click also
  // bubbles to document — without these guards it evaluated the pattern twice.
  async function autoStart(ev) {
    if (playing) { document.removeEventListener('click', autoStart); return; }
    if (ev.target && ev.target.closest && ev.target.closest('.controls')) return;
    await startPattern();
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
