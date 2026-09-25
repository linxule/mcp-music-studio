/**
 * Browser fallback for non-UI MCP clients.
 * Generates a self-contained HTML player and opens it in the default browser.
 */
// Runtime-agnostic: no node: imports here, so the Cloudflare Worker can render
// the same page for its /score route. The disk-writing + browser-launching half
// lives in src/open-in-browser.ts.
import {
  INSTRUMENTS,
  NOTE_FADE_MS,
  STYLE_PRESETS,
  STYLE_NAMES,
  type StyleName,
  findInstrument,
  injectTempoHeader,
  normalizeDrumIntro,
  normalizeSwing,
} from "./music-logic.js";
import { transposeAbc } from "./abc-transpose.js";
import { ABCJS_CDN_BASE } from "./abcjs-version.js";
import { ROOM, ROOM_PREF_KEY } from "./room-settings.js";
// One implementation, shared with the Strudel page: this file used to carry a
// byte-identical private copy, which is exactly how the two drift apart.
import { safeJsonForScript } from "./shared/safe-json.js";
import {
  ABCJS_SCREEN_PADDING_RIGHT,
  OVERHANG_MARGIN,
  OVERHANG_TEXT_SELECTOR,
} from "./score-fit.js";

export interface BrowserPlayerOptions {
  abcNotation: string;
  /** Overrides the T: header for the page heading and <title>. */
  title?: string;
  style?: string;
  instrument?: string;
  tempo?: number;
  swing?: number;
  drumIntro?: number;
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

export function generatePlayerHtml(options: BrowserPlayerOptions): string {
  // Transposition first, so `strTranspose` sees the author's ABC before any
  // Q:/style directives are woven in, then the tempo header.
  //
  // (A `stripVoiceNameQuotes()` pass used to run here on the theory that abcjs
  // choked on `V:1 name="Melody"`. It doesn't — and the regex was lossy, since
  // dropping the quotes turned `name="Melody Line"` into a voice called
  // `Melody`. Removed; tests/browser-fallback.test.ts pins the quoted form.)
  let abc = transposeAbc(options.abcNotation, options.transpose);
  abc = injectTempoHeader(abc, { tempo: options.tempo });

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
  // An explicit `title` argument wins over the T: header, as the schema promises.
  const displayTitle = options.title?.trim() || meta.title;
  const keyDisplay = formatKey(meta.key);

  // Build metadata fragments
  const metaParts: string[] = [];
  if (keyDisplay) metaParts.push(keyDisplay);
  if (meta.tempo) metaParts.push(`${meta.tempo} BPM`);
  if (style) metaParts.push(STYLE_DISPLAY[style] ?? style);

  // Build select options
  const styleOptionsHtml = [
    // Not "melody only": with `chordsOff` unset (deliberately — the chord
    // symbols are the composer's, this selector only chooses the widget's
    // preset), abcjs still synthesises bass and chords from any "C"/"Am7" in
    // the ABC. Matches the ext-apps widget's wording.
    '<option value="">No preset accompaniment</option>',
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
  // `swing`/`drumIntro` go through the same normalizers the widget uses, so the
  // fallback and the ext-app agree on what abcjs will actually honour (swing at
  // or below 50 is a no-op; abcjs clamps above 75).
  const initData = safeJsonForScript({
    abc,
    style,
    instrumentProgram,
    swing: normalizeSwing(options.swing) ?? 0,
    drumIntro: normalizeDrumIntro(options.drumIntro) ?? 0,
  });
  const presetsJson = safeJsonForScript(STYLE_PRESETS);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark">
  <title>${escapeHtml(displayTitle)} — Music Studio</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>♪</text></svg>">
  <link rel="stylesheet" href="${ABCJS_CDN_BASE}/abcjs-audio.css">
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
    .control-group input[type="checkbox"]{accent-color:var(--accent);width:16px;height:16px;cursor:pointer;margin:0}

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
      <h1 class="piece-title anim d2">${escapeHtml(displayTitle)}</h1>
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
      <div class="control-group" title="Room echo: notes ring out as in a room instead of stopping dead">
        <label for="room-toggle">Room</label>
        <input type="checkbox" id="room-toggle" checked>
      </div>
    </div>

    <div class="sheet-card anim d4">
      <div id="sheet-music"></div>
    </div>

    <details class="notation-editor anim d5">
      <summary>Edit notation</summary>
      <textarea id="abc-editor">${escapeHtml(abc)}</textarea>
      <div class="editor-actions">
        <button class="btn-render" onclick="renderFromEditor()" title="Render the edited notation and start playing">Render &amp; Play</button>
      </div>
    </details>
  </div>

  <script src="${ABCJS_CDN_BASE}/dist/abcjs-basic-min.js"></script>
  <script>
    var INIT = ${initData};
    var HAS_EXPLICIT_TITLE = ${options.title?.trim() ? "true" : "false"};
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
      },
      // abcjs calls this after every go() with the controller.
      onReady: function(controller) {
        if (controller) routeRoom(controller.midiBuffer);
      }
    };

    // room:begin
    // The widget's light room (src/room-reverb.ts), inline because this page
    // can't import it. tests/browser-fallback-room.test.ts holds this impulse
    // response to the widget's sample for sample, and checks the routing.
    var ROOM = ${JSON.stringify(ROOM)};
    var ROOM_PREF_KEY = ${JSON.stringify(ROOM_PREF_KEY)};
    var roomOn = (function () {
      try { return localStorage.getItem(ROOM_PREF_KEY) !== 'off'; } catch (e) { return true; }
    })();
    var roomGraphs = [];

    function roomImpulse(sampleRate, room) {
      var length = Math.max(1, Math.floor(sampleRate * room.seconds));
      var decayPerSecond = Math.log(1000) / room.seconds;
      var attack = Math.max(1, Math.floor(sampleRate * 0.004));
      var a = room.seed >>> 0;
      function random() {
        a = (a + 0x6d2b79f5) >>> 0;
        var t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      }
      var left = new Float32Array(length);
      var right = new Float32Array(length);
      for (var i = 0; i < length; i++) {
        var envelope = Math.exp((-decayPerSecond * i) / sampleRate) * Math.min(1, i / attack);
        left[i] = (random() * 2 - 1) * envelope;
        right[i] = (random() * 2 - 1) * envelope;
      }
      return [left, right];
    }

    function roomInput(ctx) {
      for (var i = 0; i < roomGraphs.length; i++) {
        if (roomGraphs[i].ctx === ctx) return roomGraphs[i].input;
      }
      var input = ctx.createGain();
      input.connect(ctx.destination);
      var preDelay = ctx.createDelay(1);
      preDelay.delayTime.value = ROOM.preDelayMs / 1000;
      var channels = roomImpulse(ctx.sampleRate, ROOM);
      var ir = ctx.createBuffer(2, channels[0].length, ctx.sampleRate);
      ir.getChannelData(0).set(channels[0]);
      ir.getChannelData(1).set(channels[1]);
      var convolver = ctx.createConvolver();
      convolver.buffer = ir;
      var lowpass = ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = ROOM.lowpassHz;
      var wet = ctx.createGain();
      wet.gain.value = roomOn ? ROOM.wet : 0;
      input.connect(preDelay);
      preDelay.connect(convolver);
      convolver.connect(lowpass);
      lowpass.connect(wet);
      wet.connect(ctx.destination);
      roomGraphs.push({ ctx: ctx, input: input, wet: wet });
      return input;
    }

    // abcjs's _kickOffSound() creates, connects and starts its sources in one
    // synchronous call; for exactly that call, sources connected to the
    // destination connect to the room instead — before start().
    function routeRoom(midiBuffer) {
      if (!midiBuffer || typeof midiBuffer._kickOffSound !== 'function' || midiBuffer.__roomRouted) return;
      midiBuffer.__roomRouted = true;
      var original = midiBuffer._kickOffSound;
      midiBuffer._kickOffSound = function (seconds) {
        var ctx = ABCJS.synth.activeAudioContext();
        var input;
        try { input = ctx && roomInput(ctx); } catch (e) { input = null; }
        if (!input) return original.call(this, seconds);
        var own = Object.prototype.hasOwnProperty.call(ctx, 'createBufferSource');
        var previous = ctx.createBufferSource;
        ctx.createBufferSource = function () {
          var source = previous.call(this);
          var connect = source.connect.bind(source);
          source.connect = function (node) {
            var rest = Array.prototype.slice.call(arguments, 1);
            return connect.apply(null, [node === ctx.destination ? input : node].concat(rest));
          };
          return source;
        };
        try {
          return original.call(this, seconds);
        } finally {
          if (own) ctx.createBufferSource = previous;
          else delete ctx.createBufferSource;
        }
      };
    }

    function setRoom(on) {
      roomOn = on;
      roomGraphs.forEach(function (g) {
        g.wet.gain.setTargetAtTime(on ? ROOM.wet : 0, g.ctx.currentTime, 0.03);
      });
      try { localStorage.setItem(ROOM_PREF_KEY, on ? 'on' : 'off'); } catch (e) { /* not remembered */ }
    }
    // room:end

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

    // The startPlaying argument exists because this used to be a lie: the "Render & Play"
    // button awaited setTune(..., false, ...) and never called play(), so it
    // rendered and primed but nothing ever sounded. setTune's false argument only
    // means "not a user action"; play() then primes via runWhenReady() anyway,
    // because render() builds a FRESH SynthController every time and abcjs's
    // isLoaded starts false on a new one. Called from the button's own click
    // handler, so sticky user activation carries through the awaits and the
    // AudioContext is allowed to resume.
    // abcjs reserves no room for text it hangs off a note, so a long
    // annotation in a line's last bar ran past the SVG and was clipped (#28).
    // Same rule as the widget (src/score-fit.ts): if any such text overhangs,
    // engrave once more with the right padding widened to fit it.
    function engrave(el, abc) {
      var opts = { responsive: 'resize', add_classes: true };
      var tunes = ABCJS.renderAbc(el, abc, opts);
      var pad = overhangPadding(el, tunes);
      if (pad === null) return tunes;
      opts.paddingright = pad;
      return ABCJS.renderAbc(el, abc, opts);
    }

    function overhangPadding(el, tunes) {
      // A tune's own %%rightmargin outranks the option: nothing to gain.
      if (!tunes || !tunes.length) return null;
      if (tunes[0].formatting && tunes[0].formatting.rightmargin !== undefined) return null;
      var svg = el.querySelector('svg');
      var width = svg && svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal.width : 0;
      if (!(width > 0)) return null;
      var right = -Infinity;
      svg.querySelectorAll(${JSON.stringify(OVERHANG_TEXT_SELECTOR)}).forEach(function (t) {
        try {
          var box = t.getBBox();
          if (box.x + box.width > right) right = box.x + box.width;
        } catch (e) { /* not rendered */ }
      });
      var overhang = right - width;
      if (!(overhang > 0.5)) return null;
      return Math.ceil(${ABCJS_SCREEN_PADDING_RIGHT} + overhang + ${OVERHANG_MARGIN});
    }

    async function render(startPlaying) {
      var style = document.getElementById('style-select').value;
      var program = parseInt(document.getElementById('instrument-select').value);
      var sheetEl = document.getElementById('sheet-music');
      var audioEl = document.getElementById('audio-controls');

      if (synthControl) synthControl.pause();
      sheetEl.innerHTML = '';
      audioEl.innerHTML = '';

      var fullAbc = applyStyle(currentAbc, style);
      var visualObj = engrave(sheetEl, fullAbc);
      if (!visualObj || !visualObj.length) return;

      synthControl = new ABCJS.synth.SynthController();
      synthControl.load(audioEl, cursorControl, {
        displayLoop: true, displayPlay: true,
        displayProgress: true, displayWarp: true
      });

      var opts = { program: program, fadeLength: ${NOTE_FADE_MS} };
      if (INIT.swing) opts.swing = INIT.swing;
      if (INIT.drumIntro) opts.drumIntro = INIT.drumIntro;
      await synthControl.setTune(visualObj[0], false, opts);

      if (startPlaying) {
        try {
          await synthControl.play();
        } catch (e) {
          // Autoplay policy or a failed sample load — the transport's own ▶
          // still works, so say nothing louder than the console.
          console.debug('Playback did not start:', e);
        }
      }
    }

    function renderFromEditor() {
      currentAbc = document.getElementById('abc-editor').value;
      // An explicit title= argument outranks T:, so editing the notation
      // doesn't silently rename a piece the caller already named.
      var m = HAS_EXPLICIT_TITLE ? null : currentAbc.match(/^T:(.+)$/m);
      if (m) {
        document.querySelector('.piece-title').textContent = m[1].trim();
        document.title = m[1].trim() + ' \\u2014 Music Studio';
      }
      render(true);
    }

    // Re-priming on a settings change should not also start playback — that is
    // the widget's behaviour too, and a select's change event is a poor moment
    // to begin making noise.
    document.getElementById('style-select').addEventListener('change', function () { render(false); });
    document.getElementById('instrument-select').addEventListener('change', function () { render(false); });
    var roomToggle = document.getElementById('room-toggle');
    roomToggle.checked = roomOn;
    roomToggle.addEventListener('change', function () { setRoom(roomToggle.checked); });

    render(false);
  </script>
</body>
</html>`;
}
