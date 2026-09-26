import { SOURCE_URL } from "./source-info.js";
// =============================================================================
// Strudel browser fallback — standalone HTML with @strudel/repl
// In browser mode (not iframe sandbox), the full REPL renders correctly.
// =============================================================================

// Runtime-agnostic: no node: imports here, so the Cloudflare Worker can render
// the same page for its /play route. The disk-writing + browser-launching half
// lives in src/open-in-browser.ts.
import { safeJsonForScript } from "./shared/safe-json.js";
import { injectTempo } from "./shared/tempo.js";
import {
  HYDRA_INIT_RE,
  VIZ_ALL_RE,
  VIZ_LAYER_RE,
  VIZ_METHOD_RE,
  detectViz,
} from "./shared/viz-detect.js";
import { HYDRA_SYNTH_CDN } from "./shared/visual-presets.js";
import { AUDIO_ANALYSER, AUDIO_DEFAULTS } from "./shared/audio-bands.js";

export interface StrudelPlayerOptions {
  code: string;
  bpm?: number;
  /** Compatibility only: standalone pages always require intentional Play. */
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
  const { code, bpm } = options;

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
  // Which visual layers this pattern asks for, decided HERE (the full
  // comment/string-aware scan from src/shared/viz-detect.ts) so the page opens
  // in the right state instead of flashing an empty stage. The page re-checks
  // after an edit with the same regexes, injected below.
  const viz = detectViz(finalCode);

  const initData = safeJsonForScript({
    code: finalCode,
    cps: tempo ? tempo.cps : null,
    tempoPolicy: tempo ? tempo.policy : null,
    hydraCdn: HYDRA_SYNTH_CDN,
    // Regex SOURCES, not literals: the method list lives in viz-detect.ts and
    // must not be re-typed into a template string that can drift from it.
    vizPatterns: [VIZ_METHOD_RE.source, VIZ_ALL_RE.source, VIZ_LAYER_RE.source],
    // The audio-reactive `a`: same analyser and defaults as the widget.
    audio: { analyser: AUDIO_ANALYSER, defaults: AUDIO_DEFAULTS },
    hydraPattern: HYDRA_INIT_RE.source,
  });

  // Classes drive the whole visuals layer; both are re-applied client-side.
  const bodyClass = [viz.any ? "viz-on" : "", viz.hydra ? "hydra-on" : ""]
    .filter(Boolean)
    .join(" ");

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
  main { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  strudel-editor { display: block; width: 100%; }
  /* StrudelMirror puts its CodeMirror in a div that is a SIBLING of
     <strudel-editor>, so it is this wrapper — not the custom element — that has
     to fill the frame. Without the flex it stopped at its content height and
     left a seam of bare body below it. */
  main > div { flex: 1; min-height: 400px; width: 100%; }
  .cm-editor { min-height: 400px; }

  /* =========================================================================
     Visuals — the same layering the ext-apps widget uses (src/strudel-app.css),
     ported to a full page.

     @strudel/draw's getDrawContext() CREATES its canvas when none exists by id:
     it prepends a position:fixed, full-viewport canvas with NO z-index to
     <body> — over the header and controls — while CodeMirror's opaque wrapper
     hides it behind the code. Pre-creating #test-canvas here means
     getDrawContext() reuses it (verified against the 1.2.6 source: with the
     element present it only calls getContext, and registers no resize handler
     of its own, so the sizing below is uncontested).

     Three layers: the Hydra shader, then the 2D draw canvas over it, then the
     page chrome above both.
     ========================================================================= */

  #test-canvas,
  #hydra-canvas {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: 0;
    pointer-events: none;
  }
  /* Prepended by getDrawContext(), so it is already behind #test-canvas in DOM
     order; pixelated because @strudel/hydra renders it at pixelRatio 1. */
  #hydra-canvas { image-rendering: pixelated; }

  /* Hidden until a pattern actually draws — an empty dark stage over the page
     is worse than no stage. NOT !important: initHydra({feedStrudel:true}) hides
     this canvas with an inline style, and that has to keep winning. */
  #test-canvas { display: none; background: #0d0b14; }
  body.viz-on #test-canvas { display: block; }
  /* With a shader running, the 2D stage must not paint its opaque ground over
     it. Strudel's draw functions clearRect() each frame, so this is safe. */
  body.hydra-on #test-canvas { background: transparent; }
  /* Extra getDrawContext('name') layers, moved above #test-canvas. */
  body:not(.viz-on) .viz-layer, .viz-layer.viz-layer-idle { display: none; }

  header, main { position: relative; z-index: 1; }

  /* THE occlusion fix (v0.4.2, ported). <strudel-editor> (StrudelMirror) wraps
     its CodeMirror in an intermediate <div> whose background is set INLINE to
     var(--background) — an opaque dark fill. That wrapper sits over the canvas
     and fully hides it, so the visuals only ever peeked out BELOW the editor
     box. Make the wrapper and the editor transparent and fill the height, and
     keep the readability scrim on ONE layer (.cm-scroller) so it never
     double-darkens. !important beats the inline style. */
  body.viz-on main > div,
  body.viz-on strudel-editor > div {
    height: 100% !important;
    background-color: transparent !important;
  }
  body.viz-on .cm-editor {
    height: 100% !important;
    background-color: transparent !important;
  }
  body.viz-on .cm-scroller {
    height: 100% !important;
    background-color: rgba(20, 17, 29, 0.5) !important;
  }
  body.viz-on .cm-gutters {
    background-color: rgba(20, 17, 29, 0.6) !important;
  }
  /* Lift the code off the animation, the way strudel.cc does. */
  body.viz-on .cm-content { text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9); }
</style>
</head>
<body class="${bodyClass}">
<canvas id="test-canvas" aria-hidden="true"></canvas>
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

  // ===========================================================================
  // Eval-scope hooks — pin hydra-synth, and stop H() dying on a rest
  // ===========================================================================
  //
  // A plain 'globalThis.x = wrapper' does NOT hold here. The REPL publishes its
  // eval scope with Object.assign(globalThis, module) across several async
  // chunks, so a wrapper installed mid-publish is silently overwritten by a
  // later one. An accessor turns every republish into a call to our setter,
  // which re-wraps the incoming original instead of losing to it. Same
  // technique as the ext-apps widget (installEvalScopeHooks in
  // src/strudel-app.ts) — install it eagerly, before the globals exist.
  var WRAPPED = '__musicStudioWrapped';

  function defineWrappedGlobal(key, wrap) {
    var apply = function (value) {
      if (typeof value !== 'function' || value[WRAPPED] === true) return value;
      var wrapped = wrap(value);
      try {
        Object.defineProperty(wrapped, WRAPPED, { value: true, configurable: true });
      } catch (e) { /* exotic function — worst case it is wrapped again */ }
      return wrapped;
    };
    var exposed = apply(globalThis[key]);
    Object.defineProperty(globalThis, key, {
      configurable: true,
      enumerable: true,
      get: function () { return exposed; },
      set: function (value) { exposed = apply(value); },
    });
  }

  // @strudel/hydra loads hydra-synth from an UNVERSIONED specifier
  // ('https://unpkg.com/hydra-synth' — i.e. whatever "latest" is today), so a
  // page that works now can break on any upstream release. Pin it, unless the
  // pattern names its own src.
  defineWrappedGlobal('initHydra', function (original) {
    return function (options) {
      var merged = Object.assign({ src: INIT.hydraCdn }, options || {});
      return original(merged);
    };
  });

  // a:begin
  // The widget's audio-reactive \`a\` (hydra's audio object, over Strudel's own
  // master bus — never the microphone). The band math is src/shared/audio-bands.ts,
  // copied because this page cannot import; tests/share-page-audio.test.ts holds
  // this copy to that module's numbers.
  var AUDIO = INIT.audio;

  function bandLevels(bytes, sampleRate, fftSize, count, lowHz, highHz) {
    var hzPerBin = sampleRate / fftSize;
    var ratio = Math.pow(highHz / lowHz, 1 / count);
    var levels = [];
    for (var i = 0; i < count; i++) {
      var lo = lowHz * Math.pow(ratio, i);
      var hi = lo * ratio;
      var start = Math.min(bytes.length - 1, Math.floor(lo / hzPerBin));
      var end = Math.min(bytes.length, Math.max(start + 1, Math.ceil(hi / hzPerBin)));
      var sum = 0;
      for (var j = start; j < end; j++) sum += bytes[j];
      levels.push(sum / Math.max(1, end - start) / 255);
    }
    return levels;
  }

  function stepBands(levels, prevBins, settings, max, bins, fft) {
    var total = 0;
    for (var i = 0; i < levels.length; i++) {
      var smooth = settings[i].smooth;
      bins[i] = levels[i] * max * (1 - smooth) + (prevBins[i] === undefined ? 0 : prevBins[i]) * smooth;
      total += bins[i];
    }
    for (var k = 0; k < levels.length; k++) {
      fft[k] = Math.max(0, (bins[k] - settings[k].cutoff) / settings[k].scale);
    }
    return total / Math.max(1, levels.length);
  }

  var audioApi = (function () {
    var d = AUDIO.defaults;
    var api = { vol: 0, cutoff: d.cutoff, scale: d.scale, smooth: d.smooth, max: d.max, bins: [], prevBins: [], fft: [], settings: [] };
    var bandNames = [];
    api.setBins = function (count) {
      var n = Math.max(1, Math.floor(count) || 1);
      api.bins = []; api.prevBins = []; api.fft = []; api.settings = [];
      for (var i = 0; i < n; i++) {
        api.bins.push(0); api.prevBins.push(0); api.fft.push(0);
        api.settings.push({ cutoff: api.cutoff, scale: api.scale, smooth: api.smooth });
      }
      bandNames.forEach(function (k) { delete globalThis[k]; });
      bandNames = [];
      for (var b = 0; b < n; b++) {
        (function (i) {
          var k = 'a' + i;
          globalThis[k] = function (scale, offset) {
            var s = scale === undefined ? 1 : scale;
            var o = offset === undefined ? 0 : offset;
            return function () { return api.fft[i] * s + o; };
          };
          bandNames.push(k);
        })(b);
      }
    };
    api.setCutoff = function (v) { api.cutoff = v; api.settings.forEach(function (s) { s.cutoff = v; }); };
    api.setSmooth = function (v) { api.smooth = v; api.settings.forEach(function (s) { s.smooth = v; }); };
    api.setScale = function (v) { api.scale = v; api.settings.forEach(function (s) { s.scale = v; }); };
    // The widget's debug meter has no place on this page.
    api.show = function () {};
    api.hide = function () {};
    api.setBins(d.bins);
    return api;
  })();
  globalThis.a = audioApi;

  var analyser = null;
  var analyserBytes = null;

  /** Tap the master bus, once audio exists (the AudioContext is lazy). */
  function ensureAnalyser() {
    if (analyser) return true;
    try {
      var ctx = typeof getAudioContext === 'function' ? getAudioContext() : null;
      var controller = typeof getSuperdoughAudioController === 'function' ? getSuperdoughAudioController() : null;
      var master = controller && controller.output && controller.output.destinationGain;
      if (!ctx || !master || !master.connect) return false;
      var node = ctx.createAnalyser();
      node.fftSize = AUDIO.analyser.fftSize;
      node.smoothingTimeConstant = AUDIO.analyser.smoothing;
      node.minDecibels = AUDIO.analyser.minDecibels;
      node.maxDecibels = AUDIO.analyser.maxDecibels;
      master.connect(node); // a tap: never connected onward
      analyser = node;
      analyserBytes = new Uint8Array(node.frequencyBinCount);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** One frame of band analysis, while something on the page can react. */
  var audioLoopRunning = false;

  /** Start the band loop; it stops itself while no visuals are showing. */
  function startAudioLoop() {
    if (audioLoopRunning || typeof requestAnimationFrame !== 'function') return;
    audioLoopRunning = true;
    requestAnimationFrame(audioFrame);
  }

  function audioFrame() {
    if (!document.body.classList.contains('viz-on')) {
      audioLoopRunning = false;
      return;
    }
    if (ensureAnalyser()) {
      analyser.getByteFrequencyData(analyserBytes);
      var levels = bandLevels(analyserBytes, analyser.context.sampleRate, analyser.fftSize,
        audioApi.bins.length, AUDIO.analyser.lowHz, AUDIO.analyser.highHz);
      audioApi.prevBins = audioApi.bins.slice(0);
      audioApi.vol = stepBands(levels, audioApi.prevBins, audioApi.settings, audioApi.max, audioApi.bins, audioApi.fft);
    }
    requestAnimationFrame(audioFrame);
  }
  // a:end

  // hap:begin
  // H() values as numbers: a note becomes its MIDI number by Strudel's own rule
  // (c3 = 48), a frequency its MIDI pitch. Copied from src/shared/hap-number.ts;
  // tests/share-page-audio.test.ts holds this copy to it.
  var CHROMAS = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  var ACCIDENTALS = { '#': 1, b: -1, s: 1, f: -1 };

  function noteNameToMidi(text) {
    var match = /^([a-gA-G])([#bsf]*)(-?[0-9]*)$/.exec(text);
    if (!match) return null;
    var offset = match[2].split('').reduce(function (sum, x) { return sum + ACCIDENTALS[x]; }, 0);
    var oct = match[3] === '' ? 3 : Number(match[3]);
    return (oct + 1) * 12 + CHROMAS[match[1].toLowerCase()] + offset;
  }

  function hapNumber(value) {
    var n = rawHapNumber(value);
    return isFinite(n) ? n : 0;
  }

  function rawHapNumber(value) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      var trimmed = value.trim();
      if (trimmed !== '' && isFinite(Number(trimmed))) return Number(trimmed);
      var midi = noteNameToMidi(trimmed);
      return midi === null ? 0 : midi;
    }
    if (value && typeof value === 'object') {
      // freq outranks note, as in Strudel's valueToMidi.
      if (typeof value.freq === 'number' && value.freq > 0) return 12 * Math.log2(value.freq / 440) + 69;
      if (value.note !== undefined) return rawHapNumber(value.note);
      if (value.n !== undefined) return rawHapNumber(value.n);
      if (value.value !== undefined) return rawHapNumber(value.value);
    }
    return 0;
  }
  // hap:end

  // Upstream H is  p => () => reify(p).queryArc(t, t)[0].value  — a zero-width
  // query. Under a REST there is no hap, so [0] is undefined and reading
  // .value throws. Hydra calls this every frame, so one rest killed the shader
  // while the audio kept going. Return 0 instead.
  defineWrappedGlobal('H', function (original) {
    return function (pattern) {
      var sample = original(pattern);
      return function () {
        try {
          // A note becomes its MIDI number, so pitch can drive a shader.
          return hapNumber(sample());
        } catch (e) {
          return 0;
        }
      };
    };
  });

  // ===========================================================================
  // Visuals stage
  // ===========================================================================
  //
  // The body class is set server-side from the code we shipped; re-derive it
  // after an edit. The patterns come from src/shared/viz-detect.ts so the two
  // cannot disagree about what counts as a draw method.
  var VIZ_RES = INIT.vizPatterns.map(function (s) { return new RegExp(s); });
  var HYDRA_RE = new RegExp(INIT.hydraPattern);
  var vizCanvas = document.getElementById('test-canvas');

  /** Cheap comment strip — the guide's examples comment out draw calls. */
  function stripComments(code) {
    return String(code)
      .replace(/\\/\\*[\\s\\S]*?\\*\\//g, ' ')
      .replace(/\\/\\/[^\\n]*/g, ' ');
  }

  function applyVizState(code) {
    var scan = stripComments(code);
    var hydra = HYDRA_RE.test(scan);
    var any = hydra || VIZ_RES.some(function (re) { return re.test(scan); });
    document.body.classList.toggle('viz-on', any);
    document.body.classList.toggle('hydra-on', hydra);
    if (any) {
      sizeVizCanvas();
      startAudioLoop();
    }
  }

  // getDrawContext() only sizes a canvas it CREATES; ours pre-exists, so its
  // backing store is ours to maintain. Match the device pixel ratio or the
  // piano roll draws blurry and off-scale.
  function sizeVizCanvas() {
    if (!vizCanvas) return;
    var dpr = window.devicePixelRatio || 1;
    var w = Math.round(window.innerWidth * dpr);
    var h = Math.round(window.innerHeight * dpr);
    if (vizCanvas.width !== w) vizCanvas.width = w;
    if (vizCanvas.height !== h) vizCanvas.height = h;
  }

  window.addEventListener('resize', sizeVizCanvas);
  sizeVizCanvas();

  // layers:begin
  // Extra getDrawContext('name') canvases. Strudel prepends each as a fixed,
  // full-page canvas BEFORE #test-canvas, so the stage's opaque ground covered
  // it. Move each one just above #test-canvas; drop the ones the next
  // evaluation no longer names, and clear them all on Stop. The id rule is
  // src/shared/viz-detect.ts drawLayerIds(); tests/share-page-audio.test.ts
  // holds this copy to it.
  function drawLayerIds(code) {
    // The RAW code, not stripComments(): that strips from any '//', including
    // one inside a URL string, and so could hide a call still in use (Codex).
    // A commented-out call errs the safe way — its layer stays.
    var scan = String(code);
    var ids = [];
    var call = /\\bgetDrawContext\\s*\\(/g;
    var m;
    while ((m = call.exec(scan)) !== null) {
      var rest = scan.slice(m.index + m[0].length);
      if (/^\\s*\\)/.test(rest)) continue;
      var literal = /^\\s*(['"\`])([^'"\`\\\\$]+)\\1\\s*[,)]/.exec(rest);
      if (!literal) return null;
      if (ids.indexOf(literal[2]) < 0) ids.push(literal[2]);
    }
    return ids;
  }

  var drawLayers = [];

  function adoptLayer(c) {
    if (drawLayers.indexOf(c) >= 0) return;
    c.classList.add('viz-layer');
    c.style.zIndex = '0';
    // Above #test-canvas and every earlier layer: creation order, as in the widget.
    var anchor = drawLayers.length ? drawLayers[drawLayers.length - 1] : vizCanvas;
    anchor.parentNode.insertBefore(c, anchor.nextSibling);
    drawLayers.push(c);
  }

  // Hide (and clear) unnamed layers rather than removing them: getDrawContext()
  // reuses a canvas it finds by id, but re-creates a removed one with a second
  // window-resize listener that keeps the old canvas alive (Codex).
  function pruneLayers(code) {
    var keep = drawLayerIds(code);
    drawLayers = drawLayers.filter(function (c) { return c.isConnected; });
    drawLayers.forEach(function (c) {
      var used = keep === null || keep.indexOf(c.id) >= 0;
      if (!used) clearLayer(c);
      c.classList.toggle('viz-layer-idle', !used);
    });
  }

  function clearLayer(c) {
    try { var g = c.getContext('2d'); if (g) g.clearRect(0, 0, c.width, c.height); } catch (e) { /* WebGL: hiding is enough */ }
  }

  function clearLayers() {
    drawLayers.forEach(clearLayer);
  }

  if (typeof MutationObserver === 'function') new MutationObserver(function (records) {
    records.forEach(function (r) {
      r.addedNodes.forEach(function (n) {
        if (n instanceof HTMLCanvasElement && n.id !== 'test-canvas' && n.id !== 'hydra-canvas' && n.parentNode === document.body) adoptLayer(n);
      });
    });
  }).observe(document.body, { childList: true });
  // layers:end

  var editorEl = document.getElementById('editor');
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

  /** What is in the editor right now — the user may have edited it. */
  function getLiveCode(ed) {
    try {
      var live = ed && (ed.code || (ed.repl && ed.repl.state && ed.repl.state.code));
      return typeof live === 'string' && live.length > 0 ? live : INIT.code;
    } catch (e) {
      return INIT.code;
    }
  }

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

  // A shared pattern is JavaScript. Inspecting or selecting its code must never
  // evaluate it, even if an older share link asks for autoplay. Play and the
  // editor's own evaluation shortcut are the intentional execution paths.
  function togglePlay() {
    if (playing) stopPattern();
    else startPattern();
  }

  async function startPattern() {
    const ed = getEditor();
    if (!ed || !ready) { setStatus('Initializing...'); return; }
    playBtn.disabled = true;
    // The user may have added (or removed) a draw method since the page loaded.
    // The code this Play evaluates — the buffer may change during the await.
    const evaluated = getLiveCode(ed);
    applyVizState(evaluated);
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
      pruneLayers(evaluated);
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
      clearLayers();
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
    applyVizState(INIT.code);
    ready = true;
    retryBtn.hidden = true;
    setStatus('Click Play to start');
  }).catch(showLoadError);

</script>
<footer style="font-size:12px;padding:12px;text-align:center"><a href="${SOURCE_URL}" target="_blank" rel="noopener noreferrer">Source &amp; licenses</a></footer>
</body>
</html>`;
}
