# Live coding (Strudel)
Write code → hear it play → edit in a live REPL.

- **TidalCycles mini-notation** in JavaScript
- **71 drum machine banks** + **128 GM instruments** + 128 VCSL orchestral/world/percussion samples + built-in synths
- **Full effects chain** — filters, reverb, delay, FM synthesis
- **Editable REPL** — users can tweak the code and hear changes instantly
- **Live visuals** — add `.pianoroll()` / `.punchcard()` / `.scope()` / `.spectrum()` / `.spiral()` / `.pitchwheel()` to animate behind the code (native strudel.cc overlay)
- **Layered and hand-drawn visuals** — give each visual its own canvas with `ctx: getDrawContext('name')` so several play at once, or draw anything yourself with `.onPaint((ctx, time, haps) => …)`, reacting to the notes and the sound
- **Inline visuals and sliders** — `._pianoroll()`, `._scope()` and friends draw under their own line of code; `slider(value, min, max)` puts a knob in the code to drag while it plays
- **Hydra shader backgrounds** — `await initHydra()` + Hydra code for fully custom, music-synced WebGL visuals. `H(pattern)` locks a shader parameter to the sequence — notes arrive as MIDI numbers, so a melody can steer a shader — and `feedStrudel` post-processes the piano roll
- **Audio-reactive shaders** — `a.fft[0]`, `a0()`, `a.setBins(6)` and the rest of Hydra's audio API work verbatim, driven by **Strudel's own output** rather than the microphone (no permission prompt, no room noise)
- **`visuals` preset** — one enum value (`pianoroll`, `punchcard`, `scope`, `spectrum`, `hydra-kaleid`, `hydra-pulse`, `hydra-wash`, `hydra-feed`) gives a bare pattern something to paint. Never overrides code that already visualises itself
- **`theme`** — 39 CodeMirror colour schemes; the visuals stage and its readability scrim are derived from the active theme, so light themes stay readable
- **Stage mode** — hide the code and let the visuals fill the frame (composes with the host's fullscreen)
- **Honest runtime feedback** — evaluation errors, unknown sound names, and stops the user triggered are reported back to the model as they happen, so it never answers about a silent widget as if the music were still playing
- **Beyond music: a stage for audiovisual pieces** — pattern code is real browser JavaScript, and the widget gives it five primitives: `cycle()` (the cycle you're hearing), `onFrame(fn)` (a managed animation loop), `onEvent(pattern, fn)` (fires as each note becomes audible, with its MIDI pitch), `onTap(fn)` (taps on the stage, with `next(16)` — the first 16th the scheduler can still play) and `say(text, { voice })` (a spoken line rendered by the server, returned as a **pattern**, so it lands on the beat, mixes, and records). Draw your own canvases into Hydra, re-render them as ASCII, cut between scenes on bar lines. Each belongs to the evaluation that made it: re-running replaces the old loop instead of stacking another
- **Spoken lines and their budget** — `say()` lines come from the hosted service (Cloudflare Workers AI, 40 synthetic voices, no voice cloning) and are cached for 30 days, so a line already heard is free to play again. New lines draw on a monthly budget, and no single day may use more than a tenth of it. When it is used up, a piece plays without its new lines and says so, until the next day or month. https://music-studio.linxule.com/tts/budget shows how much is spent.
- **A gallery of finished pieces** — a short film, a spoken duet you play along with, a Game of Life that composes, a glitch piece about memory: `get-strudel-guide({ topic: "gallery", piece: "first-light" })`. Made in claude.ai by a Claude model with a person
- **Server-side validation** — the local server evaluates every Strudel pattern headlessly before answering: the tool result reports layers, events per cycle, tempo, and which sound names are registered (or a syntax error with line:column), and runs each `onFrame`/`onEvent` callback once to catch a draw loop that throws. The hosted worker can't run Strudel (Cloudflare forbids dynamic code generation), but it parses the JavaScript and every mini-notation string, so a typo still comes back with its line and column
- **Record & download** — capture live audio and export as WAV (recordings longer than about two minutes download in the recorder's own compressed format, so the file stays a sensible size)
- **`get-strudel-guide`** — 15 reference topics: mini-notation, sounds, effects, patterns, genres, tips, visuals, hydra, advanced — and for audiovisual work stage, film, interactive, craft, debugging, gallery

---

[← Back to the README](https://github.com/linxule/mcp-music-studio/blob/main/README.md)
