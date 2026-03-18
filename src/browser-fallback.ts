/**
 * Browser fallback for non-UI MCP clients.
 * Generates a self-contained HTML player and opens it in the default browser.
 */
import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  INSTRUMENTS,
  STYLE_PRESETS,
  STYLE_NAMES,
  type StyleName,
  findInstrument,
  injectTempoAndTranspose,
} from "./music-logic.js";

export interface BrowserPlayerOptions {
  abcNotation: string;
  style?: string;
  instrument?: string;
  tempo?: number;
  swing?: number;
  transpose?: number;
}

const STYLE_DISPLAY: Record<string, string> = {
  rock: "Rock",
  jazz: "Jazz",
  bossa: "Bossa Nova",
  waltz: "Waltz",
  march: "March",
  reggae: "Reggae",
  folk: "Folk",
  classical: "Classical",
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// JSON.stringify doesn't escape <, >, & — if embedded in <script>, a payload
// like </script><script>alert(1) would break out. Unicode-escape them.
function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

function extractMeta(abc: string) {
  const title = abc.match(/^T:(.+)$/m)?.[1]?.trim() ?? "Untitled";
  const key = abc.match(/^K:(.+)$/m)?.[1]?.trim() ?? "";
  const tempoRaw = abc.match(/^Q:.*?(\d+)\s*$/m)?.[1] ?? "";
  return { title, key, tempo: tempoRaw };
}

function formatKey(raw: string): string {
  if (!raw) return "";
  return raw.replace(/([A-G])b/g, "$1♭").replace(/([A-G])#/g, "$1♯");
}

// ABCJS ≤6.6.2 fails to render notation when V: lines use quoted name
// attributes (e.g. name="Melody"). Strip the quotes so ABCJS can parse them.
function stripVoiceNameQuotes(abc: string): string {
  return abc.replace(/^(V:\S+.*?\bname=)"([^"]*)"(.*)$/gm, "$1$2$3");
}

export function generatePlayerHtml(options: BrowserPlayerOptions): string {
  // Process ABC (tempo/transpose injection — baked into notation)
  let abc = stripVoiceNameQuotes(options.abcNotation);
  if (options.tempo !== undefined || options.transpose !== undefined) {
    abc = injectTempoAndTranspose(abc, {
      tempo: options.tempo,
      transpose: options.transpose,
    });
  }

  // Resolve instrument
  const instrumentName = options.instrument
    ? (findInstrument(options.instrument) ?? "Acoustic Grand Piano")
    : "Acoustic Grand Piano";
  const instrumentProgram = INSTRUMENTS[instrumentName] ?? 0;

  // Resolve style
  const style =
    options.style && STYLE_NAMES.includes(options.style as StyleName)
      ? options.style
      : "";

  const meta = extractMeta(abc);
  const keyDisplay = formatKey(meta.key);

  // Build metadata fragments
  const metaParts: string[] = [];
  if (keyDisplay) metaParts.push(keyDisplay);
  if (meta.tempo) metaParts.push(`${meta.tempo} BPM`);
  if (style) metaParts.push(STYLE_DISPLAY[style] ?? style);

  // Build select options
  const styleOptionsHtml = [
    '<option value="">None (melody only)</option>',
    ...STYLE_NAMES.map(
      (name) =>
        `<option value="${name}"${name === style ? " selected" : ""}>${STYLE_DISPLAY[name] ?? name}</option>`,
    ),
  ].join("");

  const instrumentOptionsHtml = Object.entries(INSTRUMENTS)
    .map(
      ([name, prog]) =>
        `<option value="${prog}"${prog === instrumentProgram ? " selected" : ""}>${escapeHtml(name)}</option>`,
    )
    .join("");

  // Data for JS — use safe serialization to prevent </script> breakout
  const initData = safeJsonForScript({
    abc,
    style,
    instrumentProgram,
    swing: options.swing ?? 0,
  });
  const presetsJson = safeJsonForScript(STYLE_PRESETS);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark">
  <title>${escapeHtml(meta.title)} — Music Studio</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>♪</text></svg>">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/abcjs@6.6.2/abcjs-audio.css">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    :root{
      --bg:#0c1220;
      --surface:#151d2e;
      --border:#252f42;
      --border-subtle:#1e2840;
      --text:#e2e8f0;
      --text-secondary:#8b99b0;
      --text-dim:#4a5672;
      --accent:#5b9cf6;
      --accent-glow:rgba(91,156,246,0.08);
      --sheet-bg:#fafaf9;
      --success:#34d399;
      --radius:12px;
      --radius-sm:8px;
    }
    html{height:100%}
    body{
      font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
      background:var(--bg);
      background-image:radial-gradient(ellipse at 50% 0%,rgba(91,156,246,0.04) 0%,transparent 50%);
      color:var(--text);
      min-height:100%;
      -webkit-font-smoothing:antialiased;
    }
    .player{max-width:820px;margin:0 auto;padding:40px 28px 60px}
    .player-header{margin-bottom:36px}
    .brand{
      font-size:0.65rem;font-weight:600;
      text-transform:uppercase;letter-spacing:0.25em;
      color:var(--text-dim);
    }
    .piece-info{margin-bottom:28px}
    .piece-title{
      font-family:Georgia,'Noto Serif','Times New Roman',serif;
      font-size:1.85rem;font-weight:400;
      letter-spacing:-0.015em;line-height:1.25;
      margin-bottom:8px;
    }
    .piece-meta{
      display:flex;gap:0;
      font-family:ui-monospace,'SF Mono','Cascadia Mono','Fira Code',monospace;
      font-size:0.7rem;color:var(--text-secondary);
      text-transform:uppercase;letter-spacing:0.08em;
    }
    .piece-meta span+span::before{
      content:'·';margin:0 8px;color:var(--text-dim);
    }
    .audio-section{margin-bottom:16px}
    .audio-section:empty{display:none}

    /* ABCJS dark-theme overrides */
    .abcjs-inline-audio{
      border-radius:var(--radius-sm)!important;
      background:var(--surface)!important;
      border:1px solid var(--border)!important;
    }
    .abcjs-inline-audio .abcjs-btn{color:var(--text)!important}
    .abcjs-inline-audio .abcjs-midi-loop.abcjs-pushed{
      background-color:var(--success)!important;
      border-color:var(--success)!important;
    }

    .controls-bar{
      display:flex;gap:16px;margin-bottom:20px;flex-wrap:wrap;
    }
    .control-group{display:flex;align-items:center;gap:8px}
    .control-group label{
      font-size:0.65rem;font-weight:500;
      text-transform:uppercase;letter-spacing:0.1em;
      color:var(--text-secondary);white-space:nowrap;
    }
    .control-group select{
      padding:6px 28px 6px 10px;
      border:1px solid var(--border);border-radius:var(--radius-sm);
      background:var(--surface);color:var(--text);
      font-size:0.8rem;font-family:inherit;
      cursor:pointer;outline:none;
      transition:border-color 0.15s;
      appearance:none;-webkit-appearance:none;
      background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6' fill='none' stroke='%238b99b0' stroke-width='1.5'/%3E%3C/svg%3E");
      background-repeat:no-repeat;background-position:right 10px center;
    }
    .control-group select:hover{border-color:var(--text-dim)}
    .control-group select:focus{border-color:var(--accent)}

    .sheet-card{
      background:var(--sheet-bg);
      color:#1a1a1a;
      border-radius:var(--radius);
      padding:24px 20px;
      min-height:200px;max-height:70vh;
      overflow-y:auto;scroll-behavior:smooth;
      border:1px solid rgba(0,0,0,0.04);
      box-shadow:
        0 1px 0 0 rgba(255,255,255,0.03),
        0 8px 32px rgba(0,0,0,0.3),
        0 0 80px var(--accent-glow);
      margin-bottom:16px;
      transition:box-shadow 0.3s ease;
    }
    .sheet-card:hover{
      box-shadow:
        0 1px 0 0 rgba(255,255,255,0.03),
        0 8px 32px rgba(0,0,0,0.35),
        0 0 80px rgba(91,156,246,0.12);
    }

    .note-playing path,
    .note-playing circle,
    .note-playing ellipse,
    .note-playing polygon{fill:var(--accent)!important;transition:fill 0.08s ease}
    .note-playing path[stroke]{stroke:var(--accent)!important}

    .notation-editor{border-top:1px solid var(--border-subtle);padding-top:12px}
    .notation-editor summary{
      font-size:0.7rem;font-weight:500;
      color:var(--text-secondary);cursor:pointer;
      padding:4px 0;user-select:none;outline:none;
      letter-spacing:0.04em;
    }
    .notation-editor summary:hover{color:var(--text)}
    .notation-editor[open] summary{margin-bottom:12px}
    .notation-editor textarea{
      width:100%;min-height:180px;
      font-family:ui-monospace,'SF Mono','Cascadia Mono',monospace;
      font-size:0.78rem;line-height:1.6;
      background:var(--surface);color:var(--text);
      border:1px solid var(--border);border-radius:var(--radius-sm);
      padding:14px;resize:vertical;outline:none;
      transition:border-color 0.15s;tab-size:2;
    }
    .notation-editor textarea:focus{border-color:var(--accent)}
    .editor-actions{display:flex;gap:8px;margin-top:10px}
    .btn-render{
      padding:7px 16px;border:none;border-radius:var(--radius-sm);
      background:var(--accent);color:white;
      font-size:0.78rem;font-weight:500;font-family:inherit;
      cursor:pointer;transition:background 0.15s;
    }
    .btn-render:hover{background:#4a8be6}

    @keyframes fadeIn{
      from{opacity:0;transform:translateY(10px)}
      to{opacity:1;transform:translateY(0)}
    }
    .anim{opacity:0;animation:fadeIn 0.4s ease-out forwards}
    .d1{animation-delay:0.05s}
    .d2{animation-delay:0.12s}
    .d3{animation-delay:0.2s}
    .d4{animation-delay:0.28s}
    .d5{animation-delay:0.38s}

    @media(max-width:600px){
      .player{padding:24px 16px 40px}
      .piece-title{font-size:1.4rem}
      .controls-bar{gap:10px}
      .control-group{flex:1;min-width:120px}
      .control-group select{flex:1}
    }
  </style>
</head>
<body>
  <div class="player">
    <div class="player-header anim d1">
      <span class="brand">♪ music studio</span>
    </div>

    <div class="piece-info">
      <h1 class="piece-title anim d2">${escapeHtml(meta.title)}</h1>
      <p class="piece-meta anim d2">
        ${metaParts.map((p) => `<span>${escapeHtml(p)}</span>`).join("")}
      </p>
    </div>

    <div class="audio-section anim d3">
      <div id="audio-controls" class="abcjs-large"></div>
    </div>

    <div class="controls-bar anim d3">
      <div class="control-group">
        <label for="style-select">Style</label>
        <select id="style-select">${styleOptionsHtml}</select>
      </div>
      <div class="control-group">
        <label for="instrument-select">Instrument</label>
        <select id="instrument-select">${instrumentOptionsHtml}</select>
      </div>
    </div>

    <div class="sheet-card anim d4">
      <div id="sheet-music"></div>
    </div>

    <details class="notation-editor anim d5">
      <summary>Edit notation</summary>
      <textarea id="abc-editor">${escapeHtml(abc)}</textarea>
      <div class="editor-actions">
        <button class="btn-render" onclick="renderFromEditor()">Render &amp; Play</button>
      </div>
    </details>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/abcjs@6.6.2/dist/abcjs-basic-min.js"></script>
  <script>
    var INIT = ${initData};
    var STYLE_PRESETS = ${presetsJson};
    var synthControl = null;
    var highlighted = [];
    var currentAbc = INIT.abc;

    var cursorControl = {
      onEvent: function(ev) {
        highlighted.forEach(function(el) { el.classList.remove('note-playing'); });
        highlighted = [];
        if (!ev.elements) return;
        for (var i = 0; i < ev.elements.length; i++) {
          for (var j = 0; j < ev.elements[i].length; j++) {
            ev.elements[i][j].classList.add('note-playing');
            highlighted.push(ev.elements[i][j]);
          }
        }
        if (highlighted.length > 0) {
          highlighted[0].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      },
      onFinished: function() {
        highlighted.forEach(function(el) { el.classList.remove('note-playing'); });
        highlighted = [];
      }
    };

    function applyStyle(abc, style) {
      if (!style || !STYLE_PRESETS[style]) return abc;
      var directives = STYLE_PRESETS[style];
      var m = abc.match(/^(K:[^\\n]*\\n)/m);
      if (m && m.index !== undefined) {
        var pos = m.index + m[0].length;
        return abc.slice(0, pos) + directives + '\\n' + abc.slice(pos);
      }
      return directives + '\\n' + abc;
    }

    async function render() {
      var style = document.getElementById('style-select').value;
      var program = parseInt(document.getElementById('instrument-select').value);
      var sheetEl = document.getElementById('sheet-music');
      var audioEl = document.getElementById('audio-controls');

      if (synthControl) synthControl.pause();
      sheetEl.innerHTML = '';
      audioEl.innerHTML = '';

      var fullAbc = applyStyle(currentAbc, style);
      var visualObj = ABCJS.renderAbc(sheetEl, fullAbc, {
        responsive: 'resize', add_classes: true
      });
      if (!visualObj || !visualObj.length) return;

      synthControl = new ABCJS.synth.SynthController();
      synthControl.load(audioEl, cursorControl, {
        displayLoop: true, displayPlay: true,
        displayProgress: true, displayWarp: true
      });

      var opts = { program: program };
      if (INIT.swing) opts.swing = INIT.swing;
      await synthControl.setTune(visualObj[0], false, opts);
    }

    function renderFromEditor() {
      currentAbc = document.getElementById('abc-editor').value;
      var m = currentAbc.match(/^T:(.+)$/m);
      if (m) {
        document.querySelector('.piece-title').textContent = m[1].trim();
        document.title = m[1].trim() + ' \\u2014 Music Studio';
      }
      render();
    }

    document.getElementById('style-select').addEventListener('change', render);
    document.getElementById('instrument-select').addEventListener('change', render);

    render();
  </script>
</body>
</html>`;
}

export async function openPlayerInBrowser(
  options: BrowserPlayerOptions,
  outputDir?: string,
): Promise<string> {
  const html = generatePlayerHtml(options);

  const outDir = outputDir ?? path.join(os.homedir(), "Desktop", "mcp-music-studio");
  await fs.mkdir(outDir, { recursive: true });

  const filename = `player-${Date.now()}.html`;
  const filepath = path.join(outDir, filename);
  await fs.writeFile(filepath, html, "utf-8");

  // Try to open in default browser (may fail in sandboxed environments)
  const platform = process.platform;
  let cmd: string;
  if (platform === "darwin") cmd = `open "${filepath}"`;
  else if (platform === "win32") cmd = `start "" "${filepath}"`;
  else cmd = `xdg-open "${filepath}"`;

  exec(cmd, (err) => {
    if (err) console.error("Failed to open browser:", err.message);
  });

  return filepath;
}
