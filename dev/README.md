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
- **preset** fills the arguments box from `dev/presets.ts` — the Hydra recipes
  from the guide's `visuals` topic, a plain pattern, and three deliberately
  broken patterns for testing error surfacing.
- **Send tool input** sends `ui/notifications/tool-input` with those arguments,
  then a `ui/notifications/tool-result`. **Send partial** streams half the code
  first; **Send cancelled** and **Send teardown** exercise the other lifecycle
  notifications.
- **frame width** resizes the iframe *without* remounting, which is how you
  exercise the widget's `ResizeObserver` and Hydra's `setResolution`.
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
