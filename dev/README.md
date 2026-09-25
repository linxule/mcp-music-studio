# dev/ — local ext-apps host harness

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
