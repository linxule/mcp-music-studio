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
- **Spoken lines and their budget** — `say()` lines come from the hosted service (Cloudflare Workers AI, 40 synthetic voices, no voice cloning) and are cached for 30 days, so a line already heard is free to play again. New lines draw on a monthly budget, and no single day may use more than a tenth of it. When it is used up, a piece plays without its new lines and says so, until the next day or month. https://music-studio.linxule.com/tts/budget shows how much is spent. On the hosted service, a line written as a single-quoted string (`say('…')`, with an optional single-quoted `voice`) starts rendering as soon as the code arrives, so it is usually cached before the player asks; up to 8 lines per call.
- **A gallery of finished pieces** — a short film, a spoken duet you play along with, a Game of Life that composes, a glitch piece about memory: `get-strudel-guide({ topic: "gallery", piece: "first-light" })`. Made in claude.ai by a Claude model with a person
- **Server-side validation** — the local server evaluates every Strudel pattern headlessly before answering: the tool result reports layers, events per cycle, tempo, and which sound names are registered (or a syntax error with line:column), and runs each `onFrame`/`onEvent` callback once to catch a draw loop that throws. The hosted worker can't run Strudel (Cloudflare forbids dynamic code generation), but it parses the JavaScript and every mini-notation string, so a typo still comes back with its line and column
- **Record & download** — capture live audio and export as WAV (recordings longer than about two minutes download in the recorder's own compressed format, so the file stays a sensible size)
- **Record a set as a video** — "Rec video" records the stage and the sound together; see [below](#recording-a-set-as-a-video)
- **Watch page** — add `?watch` to a share link for the stage alone; see [below](#watch-page)
- **`get-strudel-guide`** — 15 reference topics: mini-notation, sounds, effects, patterns, genres, tips, visuals, hydra, advanced — and for audiovisual work stage, film, interactive, craft, debugging, gallery

## Recording a set as a video

**Rec video**, next to **Record**, records what the stage shows with what you hear: the Hydra layer, then the piano roll and any other drawn layers over the stage colour, and the sound after the master limiter. It keeps recording when Claude swaps in new code in a live session, and stops on **Stop Rec**, Stop, when a new pattern arrives from a tool call, or when the widget closes. **↓** saves the take.

- **Size and length.** The frame is the stage's size on your screen (times the pixel density), at most 1280×720, with its shape kept. A take stops at 5 minutes or 80 MB, whichever comes first (audio takes stay at 5 minutes or 50 MB). Measured in Chromium at 2 Mbit/s: a 60-second take of a 520-pixel-wide stage was 8.5 MB.
- **Format.** Whatever the browser records: WebM (VP9 and Opus) in Chromium and in current WebKit, MP4 where WebM is not offered. Chromium's WebM has no length in its header, so players can't show a timeline; the widget writes the length in before saving.
- **Setlist.** In a live session, a second small file, `<title>-setlist.txt`, lists each change heard during the take: the time into the video, the bar, who made it (Claude with the update's revision, you, or the page's `swap-pattern` tool) and the pattern's first comment line.
- **Where it can't save.** Claude's phone apps don't let a widget save files, so there the button explains that and points at a share link: the share page records and saves in the phone's browser.

## Watch page

Add `?watch` to a share link (`/p/<id>?watch`, a live session's `/s/<id>?watch`, or `/play?…&watch`) to show the stage alone: no code, no editing buttons, and a controls strip only if the piece has controls. Nothing plays until the viewer taps **▶ Play**, as on every shared page. Play, **Record**, **Rec video** and fullscreen (⛶) stay in the toolbar.

---

[← Back to the README](https://github.com/linxule/mcp-music-studio/blob/main/README.md)
