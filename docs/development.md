# Development

Use Bun 1.4.2 and Node 24 for development and CI. Dependency updates use the Bun
ecosystem so both package manifests and lockfiles stay consistent. The server
retains SDK v1 and the worker uses Agents' legacy MCP handler; widgets use
ext-apps v2. CI checks both locks for vulnerabilities and exercises the real
worker HTTP transport as well as the local/worker parity suite. The worker entry
module exports only its fetch handler and the `JamSession` Durable Object class; test helpers stay in the implementation
module because workerd rejects constants as runtime entry points.

```bash
bun install
bun run dev      # watch + serve (hot reload)
bun run build    # production build (widgets must be built before the tests)
bun run test     # run tests
bunx playwright install chromium  # one-time browser install
bun run test:audio   # real browser audio, visuals, WAV and MIDI exports
bun run test:package # check source and license contents of the npm package
```

`dev/` is a local ext-apps host harness for driving the widgets outside a real client, and `bun run studio` opens the local studio: both widgets side by side with shared review and WebMCP tools — see [`dev/README.md`](../dev/README.md).

The browser audio gate starts that harness automatically and tests the built widgets
using Chromium and the real MCP Apps bridge. It measures rendered audio samples,
checks silence after stopping, and inspects exported WAV/MIDI bytes. It needs
network access to the pinned Strudel runtime and ABC soundfont provider. CI and
tag publishing both run it; failed runs retain traces and screenshots. The harness
does not enforce a client's CSP or reproduce every client's sandbox and audio policy.

---

[← Back to the README](https://github.com/linxule/mcp-music-studio/blob/main/README.md)

## What the players load from other servers

The widgets are single HTML files, but the music engines and sounds come from public servers when a player opens. If one of them is down, here is what breaks and where to change it. None of these is mirrored on our own Worker.

| What | Where from | If it is down | Where it is set |
|------|------------|---------------|-----------------|
| Strudel REPL (`@strudel/repl@1.3.0`) | unpkg.com | Live-coding players don't load at all: chat widget, share pages and the browser fallback | `src/strudel-app.ts`, `src/strudel-browser-fallback.ts` |
| Hydra (`hydra-synth@1.4.0`) | unpkg.com | Shader backgrounds fail; music still plays | `src/shared/visual-presets.ts`, `src/strudel-app.ts` |
| Strudel's sample banks and soundfonts | raw.githubusercontent.com, felixroos.github.io, tidalcycles.github.io | Drum machines and GM instruments are silent; synths still play. The widget reports missing sounds | Strudel's own defaults; CSP in `STRUDEL_CSP` (`src/shared/tool-defs.ts`) |
| VCSL samples | cdn.jsdelivr.net (rewritten from GitHub raw, see `src/shared/sample-url-fix.ts`) | Orchestral and percussion samples are silent | `src/shared/sample-url-fix.ts` |
| Strudel transpiler for the studio editor | cdn.jsdelivr.net | Only the local studio's editor companion; players are unaffected | `src/studio-strudel-companion.ts` |
| abcjs for the sheet-music browser fallback page | cdn.jsdelivr.net | Only `--render-mode browser` / HTML pages; the chat widget bundles abcjs | `src/abcjs-version.ts` |
| abcjs soundfonts | paulrosen.github.io | Sheet music draws but plays silent | `src/music-logic.ts`, `SHEET_CSP` |
| `samples('shabda:…')` | shabda.ndre.gr → cdn.freesound.org | That one layer is silent | `STRUDEL_CSP` |
| Spoken lines (`say()`) | our Worker's `/tts` (Workers AI) | Voiced pieces play without their lines and report it | `worker/src/index.ts` |

To move the REPL or Hydra to jsDelivr in an outage, change the URL in the files above. jsDelivr is already in both CSP lists, so nothing else changes. Then rebuild and deploy the Worker and publish a patch release; versioned `ui://` addresses mean chats pick up the new player on their next tool call.
