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

Read state before editing: writes require `instanceId` and `expectedRevision`, and snapshots
read the **live editor buffer**, including unevaluated human edits. Replacements
and undo are stopped; Play evaluates the current source. Staging Strudel source
does not validate it. Playback reports actual runtime errors or suspended audio;
the first playback may need a click inside the widget. Switching modes stops the
previous mode and preserves both editors. Undo keeps up to ten applied suggestions or direct agent edits.

State and undo history are in memory. Save session exports both drafts and sound settings; Open session restores them stopped. Reload clears the tab; browsers that honor exit warnings prompt about unexported changes. Audio libraries and
samples still load from the existing CDNs, so this is local hosting, not offline
audio. No model API key is needed: the browser's agent is the consumer. No shares
are uploaded. Copy for chat copies the selected passage and question, without sending them. Send-to-chat is hidden because this host has no chat transport.

The page now discovers and calls the widget's MCP Apps tools through the SDK's
`AppBridge`. Each iframe has one session controller and one undo history;
WebMCP is an adapter to those operations. A client pins the instance ID it first
reads and will not silently adopt a replacement iframe. `?studio=1` still opts
into the local writing layout and draft/interaction notifications. The legacy
local request listener uses the same controller and accepts only its immediate
loopback parent. The existing harness's no-CSP caveat still
applies. Rebuild and reload after widget source changes; Vite reloads studio
shell changes automatically. Typecheck it with
`bunx tsc --noEmit -p dev/tsconfig.studio.json`.

The original diagnostic harness remains at `/`.

### Widget-provided tools

Both ordinary widgets register these MCP Apps tools before connecting, including
when they are loaded without `?studio=1`:

| Tool | Scope |
| --- | --- |
| `get-studio-state` | Live buffer, selection, settings, instance ID, revision, playback and errors |
| `set-pattern` / `set-score` | Only the tool matching the widget's mode; edit stopped |
| `swap-pattern` | Live widgets only: change a PLAYING pattern on the next `quantize`-cycle boundary (default 4; = phrase length), the same splice as `update-session`. Answers with the cycle it took over (`swap.cycle`) or the error (the old pattern keeps playing); a bar more than ~12 s away answers `swap.queued {boundary, etaSeconds}` and keeps going — `get-studio-state` shows `pendingSwap`, then `lastSwap`. Stopped player → changes nothing and says to use `set-pattern` + `play-current-music`. Any set, undo, play, stop, review-apply, newer swap or session update replaces a waiting swap, which answers "replaced"; a human edit of the code during the wait means it is not swapped in. Undo restores the draft each swap replaced (recorded once, when the swap loaded its code), stopped; a measured runtime tempo is never replayed as an explicit bpm. With a live session joined, the swap is logged like an edit, so `get-session` and `/s/<id>` see it. Acceptance: `scripts/verify-swap.mjs` |
| `play-current-music` | Explicit evaluation/playback in this widget |
| `stop-music` | Stop this widget, including during a pending operation |
| `undo-studio-edit` | This widget's existing ten-entry edit history |

On the share page (`/play`, `/p/<id>`, `/s/<id>`) the page relays these tools to the browser's agent over WebMCP (`src/webmcp-relay.ts`, policy in `src/share-relay-policy.ts`): every tool carries `untrustedContentHint` (its state includes the link author's code), the review pair is never offered, and `play-current-music` / `swap-pattern` appear only after Play has been pressed in the player (the Play button or the editor's evaluate keys; the widget's state says `playPressed`; the page re-checks on each widget report). It keeps a shared page from running code on its own; it is not proof of a person — anything that can click in the page could press Play directly. Acceptance: `scripts/verify-share-webmcp.mjs`.

App tool discovery is separate from the ten MCP **server** tools. These tools
operate on a mounted widget's unsaved document; they do not add remote access to
closed pages or save a project. The existing initial tool-input/render path
continues to work in hosts that do not discover app-provided tools.

Every mutation requires the widget's current `instanceId`; edit, play and undo
also require `expectedRevision`. The ID changes on remount. Teardown makes the
old controller terminal. Reads may omit the ID for discovery. Ordinary edits
retain omitted settings and metadata. Snapshot restoration uses `replace: true`
to replace supplied arguments, clearing omitted metadata. Explicit score settings
replace the whole settings object: missing fields reset to soundFont `default`,
room `true`, instrumentOverride `false`, warp `100`, and loop `false`. Omitting
the settings object preserves the current settings.
Render errors can accompany an updated snapshot and an available Undo action.

Open `/app-tools.html` for a two-widget verification host. It loads the real
built widgets in opaque sandboxed iframes without the local studio opt-in and
uses real `AppBridge.listTools` / `callTool` requests. It includes controls for
reading an unevaluated human edit, editing, undo, stale writes, wrong instance
IDs, remount and teardown. It never starts playback automatically.
In Score mode, **Check score settings replacement** verifies the real ABC
adapter first accepts non-default settings and then resets all five fields when
given `replace: true` and only `{warp: 100}`.

This harness verifies our SDK integration, not a third-party host's support.
Actual ChatGPT/Codex app-tool discovery and nested preview permissions need a
separate host check. The standalone preview remains an isolated sibling iframe;
this milestone does not add embedded passage-review UI or widen CSP allowlists.

### Stage 1 verification — 1 October 2026

Implemented locally on `codex/studio-app-tools`, based on `963a840`. GPT-6.1 Sol
implemented the session/tool layer and verification host; Astra reviewed the
architecture and diff. Its score-settings replacement finding was fixed and
re-reviewed. This work has not been committed, deployed, or published.

- `bun run build`: passed, including application and server TypeScript checks.
- `bun node_modules/typescript/bin/tsc --noEmit -p dev/tsconfig.studio.json`: passed.
- `bun run test`: **1,858 tests across 85 files passed** against the built widgets.
- Real browser/AppBridge checks, both modes: five tools discovered without
  `?studio=1`; reads include human edits; writes update the same iframe; undo
  restores the previous human draft; stale writes and wrong-instance writes are
  rejected; the other widget remains unchanged. Live mode also checked remount
  identity and terminal teardown. Score mode checked complete settings replacement.
- Original WebMCP studio: nine tools discovered; direct edit, staged suggestion,
  isolated preview construction, Apply, and Undo retain the same draft instance
  and revision history. Preview construction left source/revision unchanged.
  No audible playback or phone behavior was certified in this run.

Native Codex follow-up on 1 October:

- A repo-scoped `.codex/config.toml` registers `music-studio-local` against the
  built `dist/index.js --stdio`. After restarting Codex, all eight local server
  tools were available in this same chat. The older hosted connector remains
  separate; its registration/version discrepancy is not fixed by this setup.
- A local `play-live-pattern` call with `autoplay: false` rendered an interactive
  widget. The user expanded it; the MCP Apps browser surface exposed its source,
  title, and controls. Browser UI editing and restoration succeeded in that same
  panel, with the player remaining stopped. DOM inspection confirmed the restored
  source; screenshot capture timed out. No audible playback was tested.
- The model-visible catalog still contained only the eight local server tools,
  with none of the five app-provided session tools. The browser backend exposed
  DOM interaction, without an app-tool RPC capability. Therefore native
  `get-studio-state` -> `set-pattern` -> `undo-studio-edit` remains unverified;
  UI editing is not evidence of that tool round trip.
- A separate real stdio probe confirmed both tool/resource metadata and built
  HTML containing the new session tools. Installed ext-apps SDK inspection
  confirmed registration before connect advertises the app tool capability.
  The host must discover and route those tools; the SDK does not merge them into
  the server's tool catalog. No app-side registration defect was found.

The remaining native integration gate is discovery and routing of app-provided
tools in the target host. Native rendering is now verified locally; native
session-tool access is not. Keep the working WebMCP adapter and UI/manual
fallback while investigating that boundary. Do not make publication or durable
storage prerequisites for this local host test.

### Stage 2 — shared passage review

Each widget session now owns its review request as well as its source. A request
contains the question, a fresh `requestId`, and a frozen passage with `instanceId`,
mode, revision, UTF-16 offsets, and exact selected text. Changing the question
supersedes the previous request even when the music revision is unchanged.
Moving the cursor does not silently change an already captured passage.

`get-studio-state.sharedReview` exposes that context. Two additional app-provided
tools, `explain-selection` and `suggest-edit`, accept the current request ID and
exact passage. They stage a response without changing the draft, adding Undo
history, or starting sound. There are now seven tools per widget; the standalone
WebMCP page still has nine. Apply rechecks the request and current draft, validates
the assembled source, and uses the same source/settings Undo history as direct
edits. Source or sound-setting changes make the review stale.

Ordinary embedded widgets have a **Work on a passage** panel with a question,
selected source, explanation/proposal, explicit Apply, and Undo. Copy for chat
always has a text fallback; Send question to chat appears only when the host
supports messages. Manual proposal entry also works when the host cannot route
the app tools. Embedded audio preview is not offered: it needs a supported
isolated player, and Apply never substitutes playback for preview.

The standalone page uses the same session-owned review through the existing
loopback-only bridge for human Begin/Clear/Apply actions and AppBridge tools for
agent responses. Its isolated sibling-iframe preview remains available and is
discarded when the question, draft, mode, or proposal changes. Human-only Apply
describes which controls/tools are exposed; it is not a security boundary against
JavaScript already executing inside the Strudel widget.

Native Codex routing remains the integration gate described above. Adding the
review tools does not itself make them available to a host's model. Durable
project storage/authentication and optional native panels come later, once save
semantics and ownership are decided. Current session files remain the save
mechanism; ABC and Strudel remain independent drafts.

Stage 2 verification — 1 October 2026:

- `bun run build` and the standalone TypeScript check passed.
- Final `bun run test`: **1,881 tests across 86 files passed**. The existing
  review UI cases were migrated to the real session authority and retained;
  regressions cover superseded/cleared requests, question typing, late preview
  loads, manual edits surviving state reads, wrong instances, assembled source
  bounds, and cancellation that must not add Undo history.
- GPT-6.1 Sol implemented the shared session and standalone integration; Astra
  reviewed them and the embedded panel. Findings about stale-question recapture,
  manual text being reset, false Apply success, and recovery history without a
  source commit were fixed and re-reviewed.
- Real built-widget AppBridge harness, both live and score: seven tools discover;
  changing the question rejects the captured old answer while preserving source
  and revision; a current native proposal appears in the embedded panel; explicit
  Apply changes source stopped, and the panel's Undo restores the original draft.
  Live UI also verified stale-source recapture preserves the new question and
  blank-to-sequential typing preserves spaces.
- Original WebMCP page: the agent sees question/request/passage identity; late
  answers reject; source/revision remain unchanged through isolated live preview;
  a new question removes that preview. A normal agent read preserves an unstaged
  manual replacement. Both modes verified isolated preview construction,
  explicit Apply, and Undo restoring the source. No Play button was pressed;
  audible playback and phone behavior are not certified by these checks.
- Browser evidence is the loopback verification host and standalone studio.
  Native Codex model-to-widget review-tool routing remains unverified. No
  publication, deployment, commit, or push was performed.

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
