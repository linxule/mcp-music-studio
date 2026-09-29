# dev/ — local ext-apps host harness

## Local WebMCP studio

```bash
bun run studio
# Open http://127.0.0.1:5177/studio.html
```

`studio.html` hosts the **same built MCP app widgets**, with their existing
editors, instruments, visuals, playback and downloads. It uses the real AppBridge
handshake and sandboxed iframes (`allow-scripts allow-downloads`, without
same-origin or autoplay delegation). The server binds to loopback only.

The top-level page registers nine WebMCP tools when `document.modelContext`
(or the older `navigator.modelContext`) is available: `get-studio-state`,
`open-studio-mode`, `set-pattern`, `set-score`, `play-current-music`, `stop-music`,
`undo-studio-edit`, `explain-selection`, and `suggest-edit`. Unsupported browsers still have the normal manual UI.
This is a page tool surface, not another HTTP MCP endpoint; open the page in a
WebMCP-capable browser/agent to discover it.

Read state before editing: writes require `expectedRevision`, and snapshots
read the **live editor buffer**, including unevaluated human edits. Replacements
and undo are stopped; Play evaluates the current source. Staging Strudel source
does not validate it. Playback reports actual runtime errors or suspended audio;
the first playback may need a click inside the widget. Switching modes stops the
previous mode and preserves both editors. Undo keeps up to ten applied suggestions or direct agent edits.

State and undo history are in memory. Save session exports both drafts and sound settings; Open session restores them stopped. Reload clears the tab; browsers that honor exit warnings prompt about unexported changes. Audio libraries and
samples still load from the existing CDNs, so this is local hosting, not offline
audio. No model API key is needed: the browser's agent is the consumer. No shares
are uploaded. Copy for chat copies the selected passage and question, without sending them. Send-to-chat is hidden because this host has no chat transport.

The opt-in `?studio=1` widget adapter accepts requests only from its immediate
loopback parent. Messages cross the sandbox via `postMessage`; the host checks
the responding frame identity. The existing harness's no-CSP caveat still
applies. Rebuild and reload after widget source changes; Vite reloads studio
shell changes automatically. Typecheck it with
`bunx tsc --noEmit -p dev/tsconfig.studio.json`.

The original diagnostic harness remains at `/`.

The two widgets (`strudel-app.html`, `mcp-app.html`) are MCP Apps: they get all
their input from a host over `postMessage`, so opening `dist/strudel-app.html`
directly in a browser shows an empty shell. This harness is a minimal host — it
uses the SDK's own `AppBridge` + `PostMessageTransport` from
`@modelcontextprotocol/ext-apps/app-bridge`, so the handshake, notifications and
request schemas are the real ones, not a hand-rolled imitation.

## Run

```bash
bun run build                          # widgets must be built first
bunx vite --config dev/vite.config.ts  # → http://localhost:5177
```

The harness serves the **built** files from `dist/` verbatim under `/widgets/`,
so what you test is what the MCP server ships. Re-run `bun run build` and hit
"Reload frame" after editing `src/strudel-app.ts` or its CSS.

## What it does

- **widget** picks `strudel-app` or `mcp-app` (ABC).
- **preset** fills the arguments box from `dev/presets.ts`: the Hydra recipes
  from the guide's `visuals` topic, a plain pattern, regression cases for
  viz-detection and tempo injection (string look-alikes, quoted slashes, a
  locally-bound `setcps`), three deliberately broken patterns for testing error
  surfacing (shader error, syntax error, unknown sound), and two ABC scores for
  the sheet-music widget.
- **Send tool input** sends `ui/notifications/tool-input` with those arguments,
  then a `ui/notifications/tool-result`. **Send partial** streams half the code
  first; **Send cancelled** and **Send teardown** exercise the other lifecycle
  notifications. Each result carries a fresh `_meta.viewUUID`, as the servers'
  do; **Replay (remount)** rebuilds the frame and replays the last call with
  the SAME one — what a host does when it rebuilds a widget scrolled out of
  view (the widget should render it stopped, not autoplay again).
- **frame width** resizes the iframe *without* remounting, which is how you
  exercise the widget's `ResizeObserver` and Hydra's `setResolution`.
- **host sizing** decides the frame's height the way a real host does (the
  spec's "Container Dimensions"): *auto height* follows the widget's
  `ui/notifications/size-changed` reports, optionally capped by a
  `containerDimensions.maxHeight`; *fixed* fills the pane and sends a fixed
  `height`. The ⛶ button's `ui/request-display-mode` is honoured: fullscreen
  gives the frame the whole pane at a fixed height. The harness used to pin the
  frame at 520px+ whatever the widget reported, which hid every sizing bug.
- The log panel prints everything the widget sends the host: `ui/message`,
  `ui/update-model-context`, `ui/download-file` (mime type and byte size only,
  never the base64), `ui/open-link`, `ui/request-display-mode` and size changes.

Host capabilities advertised: `downloadFile`, `message`, `updateModelContext`,
`openLinks`, `logging` — so the widget's download, send-to-chat and model-context
paths are all live.

## Caveats

- **No CSP.** The real host enforces the `csp` block from `_meta.ui`
  (`STRUDEL_CSP` / `SHEET_CSP` in `src/shared/tool-defs.ts`). Anything that
  loads here still needs its origin declared there, or Claude Desktop blocks it.
- The iframe is **same-origin and unsandboxed by default** so you can inspect
  the widget from DevTools (`__harness.win`, `__harness.doc`). Tick "sandbox
  iframe" to approximate the host's `sandbox="allow-scripts"` frame; the
  protocol still works, cross-frame inspection stops.
- Audio needs a user gesture: click inside the page once before expecting sound.

## Automation handle

`window.__harness` exposes `{ bridge, frame, win, doc, entries, send(),
mount(), setArgs(obj), usePreset(id) }` for driving the harness from DevTools or
a browser-automation tool.

## Film page (`film.html`)

A wordless phone conversation of real widgets, used to shoot the 0.5.13
release film: five tool calls from `film-score.ts`, each in its own sandboxed
frame with its own `AppBridge`, laid out at 390 CSS px and scaled up with CSS
`zoom` (`?scale=2.769`) so the widgets see a phone (`platform: "mobile"`,
devicePixelRatio 2.77) while the capture is 1080×1920 and sharp. `?v=old`
loads `/widgets/old/*.html` (the recorder routes those to a published version),
`?label=` prints a version in the corner, `?allow=1` delegates autoplay.

- The page draws the finger; the recorder moves it in step with CDP
  `Input.dispatchTouchEvent`, so the only gestures a widget sees are touches.
  Drive it with CDP `Runtime.evaluate` (`userGesture: false`), never
  Playwright's `evaluate`, which is a gesture.
- Frames have no `allow="autoplay"` by default. With it, a scrolling pan wakes
  a parked autoplay in Chromium in every version we tried (0.5.8 and current):
  the pan's activation reaches the page and the browser settles the parked
  `resume()` itself. ext-apps' permission vocabulary has no autoplay, so a
  spec-following host shouldn't delegate it — the dev harness (`index.html`)
  does, which is worth remembering when a harness repro and a host disagree.

## Stages for the film (`stage-score.html`, `stage-strudel.html`)

The final release film drops the phone for two bare stages, both 1080×1920:

- `stage-score.html?mode=old|new` — "Rest" drawn by abcjs itself on black,
  with the widget's synth options and Room; the camera cuts to each glyph as it
  plays and its ink follows an AnalyserNode on the real output. `old` is 0.5.8's
  sound (200 ms release, no Room), `new` the current one.
- `stage-strudel.html` — the shipped Strudel widget, fullscreen from the start;
  `__screen.clean()` hides its toolbar, `__screen.solo(id)` shows one visual
  layer. The widget itself is untouched.

The song they play is `film-song.ts`; the recorder and the edit are in
`scripts/showcase/film/`.

### Local studio design

The webpage adapts the personal site's current `design.md` and `design-system.md`
from `personal-website/xule-site`: paper/ink tokens, Cormorant Garamond for titles
and prose, IBM Plex Mono for controls, 2px corners, violet hover/focus, a single
still cyan mark, and marginalia that becomes endnotes on narrow screens.
Controls stay larger than the site's editorial metadata for daily editing.

This is an explicitly adapted application surface: no scroll snapping, ornamental
stagger, or ambient animation. Live syntax and performance visuals retain their
own colors. The local page uses a consistent light paper palette; the live
editor can still use any supported Strudel theme. Fonts load from Google Fonts,
with Georgia and system monospace fallbacks.

`studio.css` owns the webpage; `studio-widget.css` adapts the existing widgets
only after the localhost bridge opts in. The compact shipped MCP interfaces do
not load that stylesheet. Scores open with source visible, side by side above
760px of *workspace* width. Below that they stack inside the scrollable editor.
The ABC writing pad and its 176px feedback area occupy separate grid rows,
with a nearly equal source/score split. Source lines retain their original
line breaks and scroll horizontally when needed. Validation and transport
feedback scroll independently without changing the pad geometry. The score
workspace reserves at least 960px (900px in focus mode); narrow stacked
workspaces use 1100px and scroll internally for longer content. Stop remains in the sticky navigation; undo, source download,
and status sit above the editor. Source downloads preserve the actual current
draft as `.abc` or `.strudel.js`; they do not serialize sound/visual settings.
The session margin moves beneath the workspace at 1100px. Focus workspace hides
the margin and expands the editor while keeping mode navigation and the return
button reachable. It is an expanded layout, not a modal.

### Strudel companion

The local live view uses the whole spread: code and a 330px companion column,
with session notes below. Below 760px inside the frame, the companion becomes
endnotes beneath a 440px code surface and a fixed 164px feedback area.
This follows the personal site's collaborator-marginalia principle; the native
Strudel editor and visualization retain their own colors.

- **While you write** runs the shared `@strudel/transpiler` syntax parser after
  400ms of quiet, without evaluating JavaScript or starting music. This uses the
  repository's pinned parser (1.2.6); runtime evaluation remains authoritative
  for the CDN REPL (1.3.0). Drafts over 40,000 characters skip automatic parsing.
  Parsing does not establish sound availability or runtime correctness.
- **Sounds** reads the current REPL `soundMap`, with a small starter collection,
  search, categories, sample variants, and paginated results. Custom registered
  sounds appear too. Registration is distinct from successful sample fetching.
- **Preview sound** auditions one voice, at reduced gain, outside the pattern
  scheduler. Samples are warmed through Strudel's cache before scheduling;
  loading has an 8s bound and a triggered audition an additional 1.8s bound.
  Stop all sound, mode changes, and pattern evaluation cancel preview intents,
  including sample loads that finish late. Preview asks users to stop a playing
  pattern or recording first. Some custom instruments may not support preview.
- **Insert at cursor** uses CodeMirror's selection transaction and native undo.
  It replaces only selected text and does not evaluate. **Small lessons** are
  complete, editable examples plus guidance for asking an agent for a specific
  musical change. Agent edits still use the revision checks and separate undo.


### Passage review

Select text in either editor and choose **Share selection**. The page pins the
exact text, UTF-16 offsets, mode, and source/settings revision. The connected
agent reads these through `get-studio-state` (`selection` and `sharedReview`).
Sharing does not send a chat message or invoke a model. Continue asking questions
in the existing host chat. `explain-selection` adds a plain-language explanation;
`suggest-edit` stages a replacement and explanation without changing the draft.

**Preview in context** prepares the whole piece with only that range replaced,
inside a separate sandboxed widget. It preserves ABC headers and playback
settings. Use the preview's own Play control to enable browser audio. The main
editor and its undo history stay untouched. Stop, mode switches, source
interaction, or clearing/replacing the review dispose of the preview, including
pending loads. The preview closes after 2 minutes. It is not a second editable
score; change the proposal through **Try your own edit**.

**Apply edit** checks the latest source/settings revision and exact selected text
again, then uses the existing session write and undo path. A changed draft needs
a fresh review. Rendering errors remain visible and the previous draft remains
available through **Undo edit**. **Try your own edit** also works without WebMCP.
One passage and one proposed edit are held at a time; reviews reset on reload or
mode change. This is the first collaboration layer, not an embedded chat client.


### Session files and fallback

Save session downloads `music-studio.session.json` (format `music-studio`, version
1). It contains both sources, the active mode, and current instrument, theme,
and score sound/transport settings. It excludes reviews, undo history, recordings,
and the measured live tempo (the source remains authoritative). Open session
validates the complete file before replacing anything, confirms replacement of
unexported drafts, blocks concurrent edits during restoration, and leaves both
players stopped. A failed import attempts to restore the prior drafts and reports
any recovery failure. Unfinished and blank drafts are allowed. Files are limited
to 2 MB and each source to 65,536 characters.

The dirty indicator compares source/settings with the opened session or latest
requested export. Browser download completion is not observable in every host;
check that the downloaded file exists. Exit warnings depend on browser support
and user interaction. There is no automatic disk or browser-storage backup.

Copy for chat is available after sharing a selection, including when WebMCP is
unavailable. It copies only the passage, question, and optional replacement; full
composition context is not included. Denied clipboard access reveals selectable
text. Direct-edit agent tools still apply immediately; suggested edits wait for
Apply edit. This distinction appears in What gets saved.
