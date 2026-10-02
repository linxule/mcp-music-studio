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
