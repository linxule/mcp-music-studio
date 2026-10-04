# Changelog

Notable changes per release, newest first. Every release, including those not listed here, also has notes on [GitHub Releases](https://github.com/linxule/mcp-music-studio/releases).

## Unreleased

- **`sing(line, notes)` — talk-singing.** A new pattern function next to `say()`: the server speaks the line once and finds where each word is, and the player puts each word on a note, sped up or slowed down so its spoken pitch lands on that note. `sing('still water runs deep', "c4 e4 g4 c5")` plays one word per step; `.slow()`, `.gain()`, `.room()` and `stack()` work as with any pattern, and double-quoted notes are mini-notation (`"c4 [d4 e4] ~ g4"`). Measured in Chromium and WebKit on that line: every step came out within 25 cents of its note. It sounds like a robot singing, not a singer: the voice's character moves with the pitch, a word glides as it did when spoken, and a word lasts as long as it was spoken, so long notes end early. A sung line costs about 2% more of the voice budget than the same line spoken (the server also transcribes it), and lines written as single-quoted strings are prepared while the player loads, as for `say()`. Guide: topic `interactive`, "Singing"; gallery: `lullaby`.
- **Spoken lines are ready sooner.** When a piece with `say('…')` lines is played or sent to a live session through the hosted service, the server starts rendering those lines as soon as the code arrives, while the player is still loading. By the time the player asks for a line it is usually already cached, so a voiced piece no longer waits on speech before it starts. Only lines written as a single-quoted string are rendered ahead (with an optional single-quoted `voice`), at most 8 per call; others render when the player first asks, as before. Lines rendered ahead are charged against the same voice budget, once each.
- If the player asks for a line while the server is still rendering it, the player now waits up to 3 seconds for that render instead of starting a second one. Before, the line was rendered and charged twice. If the first render takes longer, the player renders the line itself, as before.
- **Point at a note.** Click a note on the score to hear it and select its ABC in the source pane. The review tools ("explain this", "suggest an edit") then work on that selection, so you can point instead of typing bar numbers. Shift-click extends the selection. On a phone, a finger that scrolls the score no longer counts as a click.
- **Practice row** under the sheet-music transport. **Loop selection** plays the selected notes over and over, including a stretch that runs to the end of the tune. A score with two or more voices gets one toggle per voice to mute it, and muting keeps your place. The tempo field slows the tune down as before.
- **Fixed: pausing after a jump on the progress bar resumed at the wrong place.** After clicking the progress bar while a tune played, pause and ▶ restarted the audio from where it would have been without the jump (measured: 1.15 s instead of 3.6 s), while the notes lit up at the right place. abcjs's backup timer also stacked up on every such jump (measured: 61 → 306 ticks a second after 14 loop passes). Both are worked around in the widget.
- Gallery: **Still Water — just the music** (`still-water`), a ninth piece with no controls, film or drawing: a 48-bar downtempo track (arrange, per-layer sound design, `.velocity()` ducking, development from one four-bar idea). The gallery index says when to reach for it.
- `bun run usage` (`scripts/usage.mjs`) prints a read-only report of the hosted service for the last week: voice-model calls and characters, Worker requests and errors, live-session time, the voice budget, sessions opened and tool calls. Maintainers run it at each release. See [docs/development.md](docs/development.md#usage-report).
- **Shared scores open in the full player.** A score's link (`/score?a=…`, or a stored `/p/<id>`) now opens the same sheet-music player as in a chat, not a simpler page: edit the ABC in place, change style, instrument and sound bank, the Room toggle, note highlighting, and WAV and MIDI downloads that save real files. Nothing plays until ▶ is pressed. The simpler page is still one click away ("Simple player", or `?classic=1`), and a local browser render still writes it.
- In a browser with WebMCP, a score's page offers the player's tools to the browser's agent, as a pattern's page does: read the score, stage an edit, stop and undo. Playing is offered only after ▶ has been pressed on the page.
- `scripts/verify-share-score.mjs` checks it in a real browser (notation drawn, silent until ▶, audible after, a MIDI file saved) and runs in CI in Chromium and WebKit. `scripts/check-share-phone.mjs` checks the score page at phone size too.

## 0.11.3 — October 4, 2026

- **Spoken lines have a monthly budget instead of a daily cap.** New lines from `say()` are the one thing this service pays for per request. Each new line is now charged its exact price against one monthly budget ($10 at launch, about ten times the busiest day so far), and no single day may use more than a tenth of it. Lines already heard are cached and stay free. When the budget is used up, a piece plays without its new lines and says so. This replaces a cap of 500 new lines a day and an hourly limit per address, which could both be slipped past by requests arriving together. The per-address limit of 12 new lines a minute stays, so one person can't use up everyone's share. `GET /tts/budget` shows how much of the month is spent.
- The local studio page offers `swap-pattern` to browser agents too. The real-browser checks now run in CI, in Chromium and in WebKit (Safari's engine).
- The privacy policy describes the voice budget.

## 0.11.2 — October 4, 2026

- **Fixed — "Unable to reach music studio" right after a release.** claude.ai keeps a connector's tool list for a while, so after a new version went live it asked for the previous version's player address, which no longer existed, and showed an error where the player should be. The tool still ran (a live session even opened), but no player appeared. Every earlier version's address now serves the current player. This has affected each release since 0.10.1, when player addresses started carrying the version.

## 0.11.1 — October 4, 2026

The simple path is simple again. Asking for a song or a beat works exactly as before. The optional extras (shader visuals, music videos, controls, sensors, drawn controls, live sessions and share links) are still there for an AI to find, but each now costs one line instead of a paragraph.

- **About a quarter less for an AI to read before it plays a note.** Every chat that connects reads the server's instructions, tool descriptions and input definitions. That had grown from 12.6k characters in 0.5.0 to 25.1k in 0.11.0, mostly from the optional modules. It is now 18.6k. The instructions put the core first, then name each optional module once, with the guide topic that teaches it.
- **Reviewed for how it reads to an AI.** A separate model walked seven requests through the text, from "a lofi beat" to "a drum machine I can click on", and some discoverability came back where the trim had cost it: the gallery names its pieces again, taps are named, the text says tilt and mic usually work only in the browser player, and that a play result's link already works for anyone. A request for a drum grid now goes straight to the `interactive` topic and the Trade a Beat piece instead of four guide topics. The sheet-music description now says what the person can do with a score: edit it, change the style and instrument, and download WAV or MIDI.
- Play results and the live-session note are shorter.
- **`create-share-link` lists only what a share carries.** It used to repeat the full inputs of both player tools, including the editor theme and the session flag, which a share link drops. That alone was 5.3k characters.
- The guide's `interactive` topic opens with a list of its sections, each marked optional.
- `tests/first-contact.test.ts` sets a budget for that first read and checks that every optional module is still named in it. `scripts/verify-plain.mjs` checks the plain path in a real browser: it plays, and no control strip, stage, session or permission request appears.

## 0.11.0 — October 3, 2026

Pieces can now draw their own controls. Instead of new fixed buttons on the player, the AI draws whatever a piece needs inside the visuals, and the listener and the AI share it.

- **Controls the AI draws: `remember()`.** Pattern code can keep named state, such as which cells of a drum grid are on, that survives every change to the code. A tap that changes it reaches a live session in the piece's own words ("clap on at step 4"), and `get-session` shows the whole state as data. The AI answers with a `merge`, a small edit that lands on the swap's bar on top of the listener's taps and runs once. `openStage()` shows the visuals full-size so taps reach a drawing. The guide's `interactive` topic has the recipe.
- **New gallery piece: Trade a Beat.** A drum grid drawn into the visuals that the listener and the AI play together.
- A tap that changed remembered state is logged once, as that change, not also as a raw tap.
- `openStage()` also works on the classic share page (`?classic=1`), with a Code button and Escape to go back.
- `update-session`'s description now points to `merge` for editing remembered state.
- Reviewed in four rounds by Codex and Kimi; `scripts/verify-remember.mjs` checks the whole loop in a real browser (16 checks), including that a tapped cell actually plays.

## 0.10.2 — October 3, 2026

From a field test of 0.10.1 in the Claude iPhone app and Safari.

- **Fixed — "playing" over "stopped".** When an update reached a stopped player, `get-session` went on saying "rev 1 is loaded in the player, which is stopped", even after Play was pressed and the line above said "playing". It now says Play has started it since. The session log describes the update in the past tense: it arrived while the player was stopped.
- **`update-session` explains a stopped player.** It says there is no landing bar, because a stopped player starts when Play is pressed. If the player said "playing" just before, the reply adds that it stopped in between: someone pressed Stop, or the phone suspended it (an app in the background or a locked screen).
- **A player that has gone quiet is not guessed at.** A playing player checks in at least every 20 seconds. When it has been silent for more than 30, `get-session` says when it last reported playing, and that it is probably suspended, instead of estimating a current bar.
- **Fullscreen works on iPhone.** iPhone Safari has no fullscreen for a page element, so the button did nothing on shared player pages. The player now fills the browser window instead. In a chat whose app keeps the player inline, the player says so instead of doing nothing. Escape leaves fullscreen from inside the player too.
- **Two screens on one session.** Every screen that joins a session answers updates. When a stopped screen answers while another reported "playing", `update-session` now says either could be the case instead of claiming the player stopped.
- **"Ask about selection" replaces the passage panel in chat apps.** The "Work on a passage" panel could send a question but never show an answer there, because chat apps don't call the player's own tools. Chat apps now get one button, shown only while music is selected, that sends the selection and its line numbers to the chat with a question (or copies it where the app can't send messages). In a live session the message reminds the AI it can answer with `update-session`. The full panel stays in the local development host, which does call those tools.
- The dependency audit skips one advisory (`braces`, GHSA-vfj7-8cjw-p6xm) that has no fixed release yet. It comes from a build tool and only reads this project's own build settings.

## 0.10.1 — October 2, 2026

From a field test in claude.ai, where the listen loop ran three full handovers inside one reply.

- **End session.** A button beside Pass closes a live session. The player keeps playing your last pattern; a listening AI is told at once; a later `get-session` or `update-session` says the session was ended; other screens on `/s/<id>` stop; the log is deleted 10 minutes later.
- **Pass says where it goes.** When the AI isn't listening, the button reads "Pass → chat": it logs your turn and also puts a message in the chat, the only way to start the AI's next turn. "Send to chat" is hidden during a live session, where edits are already logged.
- **Fixed — a cached older player.** "tilt is not defined" in claude.ai came from a host still using an older player. Player addresses now carry the version, so a new release reaches every chat. The player reports its version when it joins a session, and `get-session` warns when it is older than the server.
- **Fixed — the reported bar.** `update-session` said "queued for cycle 40" for a swap that started at 48. The player now reports the bar it picks as soon as it picks it, and that is what the tool says.
- **Fixed — "applied at cycle ?"** for a stopped player now reads that the code is loaded and starts when Play is pressed.
- **The README is short now**, with Chinese, French and Japanese versions. Details moved to `docs/` and this changelog.
- The npm package now includes `scripts/build-stage-runtime.mjs`, which the build needs. The privacy policy covers everything a session stores, ending a session, and Cloudflare's own WebMCP script on the domain.

## 0.10.0 — October 2, 2026

Tools on the player itself.

- **The player offers tools to its host.** Every widget now registers MCP Apps
  tools: read the live code (including the human's unsaved edits), set or
  swap it, play, stop and undo. Writes need the widget's `instanceId` and the
  current `revision`, so an agent never overwrites a human edit it hasn't
  read. No chat host calls widget tools yet; the share page and the local
  studio below do.
- **`swap-pattern` changes a playing piece on the bar**: the same quantized
  swap live sessions use (old pattern until the boundary, new from it,
  measured). Any newer edit, swap, session update, Play, Stop or Undo cancels
  a waiting one, and it never plays code someone edited during the wait. A
  bar more than ~12 s away answers "queued" and the state shows when it took
  over. Undo restores the previous code, stopped.
- **Share pages speak WebMCP**: `/play`, `/p/<id>` and `/s/<id>` pass the
  player's tools to an assistant built into the browser (Chromium's WebMCP;
  Codex desktop's built-in browser) — ask it to change the music on the page.
  A shared page still never runs on its own: the assistant can read, stage,
  stop and undo, but Play and swap appear only after Play is pressed on the page.
  Every result is marked untrusted: a shared page's code is the link author's.
- **The local studio** (`bun run studio`, `dev/`): both widgets side by side
  with shared review — select a passage, ask, and the agent explains or
  proposes an edit you preview and apply — plus save/open session files.

## 0.9.2 — October 2, 2026

- **An idle player lets go of its session.** A live-session player that has been stopped and untouched for 30 minutes stops checking in, and its badge says "session paused — press Play to rejoin". Play, an edit, a tap or Pass rejoins, and an update Claude queued in the meantime plays then. Before, a forgotten open tab kept its session alive and its server object awake indefinitely.
- **Speech renders are capped at 500 new lines a day** across everyone (was 4,000). Lines already rendered come from the cache and don't count.

## 0.9.1 — October 2, 2026

- **A Pass that gets no answer says so.** When Claude is listening, Pass hands it the turn without a chat message. If that read never reaches the model (a dropped turn, a host timeout) and nothing comes back on the player within 90 s, the player says so, and the next Pass goes to the chat.
- Dependency refresh (MCP SDK 1.31, ext-apps 2.0.3, agents 0.24). tonal stays at 6.4.3: 6.5.0's package entry points name files it doesn't ship. Published servers bundle tonal and were never affected.

## 0.9.0 — October 2, 2026

The booth, the stage and the room.

- **Listen**: `get-session` with `wait: "pass"` holds until the listener
  presses **Pass**, then returns what they did — so a whole back-to-back set
  runs inside one reply: answer, listen, answer. The player shows "Claude is
  listening", and Pass skips the chat when the AI already heard it
  (measured: 60 ms from press to the AI's read in production).
- **Share links open the full player**: the real widget — stage, Hydra, code,
  controls, recording with a real download — hosted by a page of our own,
  where the microphone and motion sensors can be allowed. `/s/<id>` opens a
  live session on another screen. The old page stays at `?classic=1`.
  Shared pages never start on their own: an old link with `autoplay=1`
  now waits for Play too.
- **Sensors as controls**: `tilt()` and `mic()` follow the device's motion and
  input loudness where the page allows it (permission on the first tap; the
  mic only when a piece asks, analysed locally, never recorded or sent), and
  turn into an xy pad and a fader you play by hand where it doesn't — so a
  piece works in the chat and on a phone alike.
- **Two Decks**: a gallery piece for back-to-back sets — your deck, Claude's
  deck, a crossfader, filters, bass kills and an echo throw.
- **Fixed — worklet sounds were silent until a click**: supersaw, pulse,
  crush, coarse and the DJ filter only loaded on the first mouse press after
  the player loaded, and a `.djf()` silenced everything on its bus. They now
  load before the first note.
- **A master limiter**: with those effects sounding, a glitch piece peaked at
  2.4× full scale (hard clipping); a limiter now keeps every piece near 1.

## 0.8.0 — October 2, 2026

Play together. A live session keeps one player open that the AI can read and
change while the music keeps going — the back-to-back the claude.ai field test
asked for, and the feedback channel it was missing.

- **Live sessions**: `play-live-pattern` with `session: true`. `get-session`
  returns what the player is doing (errors, silence, what is playing) and what
  the listener did — taps, control moves, code they edited and ran, and
  **Pass**, a button that hands the turn back. `update-session` swaps in new
  code on the next bar or phrase, measured to land on the beat, and says
  whether it ran. Works in hosts that give the AI no way to read widget context.
- **Controls**: `fader('rain')`, `pad('drop', { toggle: true })` and
  `xy('wind')` put a strip of real controls on the player. Each is a pattern
  (`.gain(fader('rain'))`) with a `.value` for visuals, and keeps its value
  when the code changes. New gallery piece: **Weather Machine**.
- The privacy policy covers live sessions (kept until 2 hours idle; the
  session id works like a share link).

## 0.7.0 — October 1, 2026

From sound toy to audiovisual instrument. A day of making things in claude.ai
— a short film, a duet with speech, a Game of Life composer — showed that the
widget already was one, and that its worst bugs were silent. This release
fixes those and gives the pieces a runtime, a voice and a guide.

- **Stage runtime**: `cycle()`, `onFrame`, `onEvent`, `onTap` (+ `next(16)`)
  and `say()` in the widget and on share pages. New guide topics `stage`,
  `film`, `interactive`, `craft`, `debugging`, and a `gallery` of complete pieces.
- **Voice**: `say(text, { voice })` returns a pattern playing the words,
  rendered once by the hosted service (Cloudflare Workers AI, 40 synthetic
  voices, cached) — so it is on the beat and identical on every device.
  Browser speech never played in the Claude mobile app.
- **Fixed — frozen clocks**: `H(signal(t => t))` returned 0 forever (a Strudel
  Fraction it misread), freezing any visual built on it at bar 1.
- **Fixed — 22 silent sounds in Chrome, Edge and Electron hosts**: kalimba,
  steinway, kawai, ocarina, the VCSL snares and more. GitHub serves them with a
  header Chromium rejects; they now load from jsDelivr.
- **Fixed — the local validator rejected working audiovisual code** ("window is
  not defined") and the hosted server checked nothing; the hosted server now
  reports syntax errors with their position, and error line numbers point at
  the code the model sent even when `bpm` or `visuals` added lines.
- **Taps that land**: `tap.next(16)` is past what the scheduler has already
  committed, so a tapped note always sounds.
- The privacy policy covers spoken lines.

## 0.6.0 — September 26, 2026

The canonical endpoint is now `https://music-studio.linxule.com/mcp`. Existing
`mcp-music-studio.linxule.workers.dev` connections and shared links continue to work.

Playback no longer stores compositions automatically. Use the new
`create-share-link` tool when you explicitly want to upload a composition for a
30-day link. The hosted privacy policy explains storage, retention, and external
providers. Standalone Strudel pages start only after an intentional Play action.

This release corrects ABC pitch/drum guidance and harmony error reporting, adds
real browser audio and export checks to CI and publishing, and updates development
dependencies. The combined application is now AGPL-3.0-or-later, with the original
MIT notices preserved and editable source/build inputs included in the npm package.
Earlier releases retain their original notices. See [SOURCE.md](SOURCE.md).

## 0.5.14 — September 25, 2026

The local server's pattern check rejected every Strudel pattern written with
`$:` blocks — Strudel's everyday way to run several patterns — as "failed to
evaluate" while the widget played it fine. It now follows the REPL: blocks play
stacked, `_$:` mutes, `S$:` solos, and the result counts the blocks as layers.
A pattern ending in a Hydra line no longer hangs the check. The release film,
*Rest*, was made with the studio itself — the score drawn by abcjs, the song a
single Strudel file with its arrangement in the code — and the tools that shot
it are in [`scripts/showcase/film/`](scripts/showcase/film/).
[0.5.14](https://github.com/linxule/mcp-music-studio/releases/tag/v0.5.14)

## 0.5.13 — September 25, 2026

The sheet widget's **Room** button showed as a blank blue box while on: its
label was drawn in the same blue as its pressed background (0.5.10–0.5.12).
It now reads like the Edit toggle, white on blue.
[0.5.13](https://github.com/linxule/mcp-music-studio/releases/tag/v0.5.13)

## 0.5.12 — September 25, 2026

Tested on a phone, then opened up. Scrolling a conversation no longer starts
music, and a tune autoplays once per tool call instead of on every rebuild;
Strudel code wraps. Sheet music rings out — a softer note release and a light
Room echo, in the widget, WAV downloads and share links. Strudel visuals gain
layers, hand-drawn `onPaint` art, inline visuals and sliders, and pitch-driven
Hydra shaders, and share links now match the widget. Details:
[0.5.9](https://github.com/linxule/mcp-music-studio/releases/tag/v0.5.9) ·
[0.5.10](https://github.com/linxule/mcp-music-studio/releases/tag/v0.5.10) ·
[0.5.11](https://github.com/linxule/mcp-music-studio/releases/tag/v0.5.11) ·
[0.5.12](https://github.com/linxule/mcp-music-studio/releases/tag/v0.5.12).

## 0.5.6 — September 14, 2026

Dependency and compatibility maintenance: audited dependency locks, ext-apps v2
widgets, the SDK v1-compatible worker adapter, and validated worker startup.
The seven tools, music features and UI controls retain their existing behavior.
Builds now synchronize the MCP Registry metadata with the package version, and
publishing waits for the npm package to propagate before registry registration.
