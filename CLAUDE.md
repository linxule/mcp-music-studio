# MCP Music Studio

Two-mode creative music studio: scored composition (ABC notation) and live performance (Strudel live coding).

## Quick Reference

- **Language**: TypeScript (ESM)
- **Runtime**: Bun (never npm/yarn/npx)
- **Build**: `bun run build` (tsc + vite×2 + bun bundle)
- **Test**: `bun run test` (vitest)
- **Dev**: `bun run dev` (watch + serve with hot reload)
- **Render modes**: `--render-mode auto|html|browser` (default: auto)
- **Output dir**: `--output-dir /path` (default: `~/Desktop/mcp-music-studio`)

## Tools

| Tool | Mode | Description | Guide |
|------|------|-------------|-------|
| `play-sheet-music` | Composition | ABC notation → visual sheet music + multi-instrument audio | `get-music-guide` (7 topics) |
| `play-live-pattern` | Performance | Strudel code → live-coded patterns with synthesis + effects | `get-strudel-guide` (7 topics) |

Both tools share GM instruments (ABC's `%%MIDI program 73` = Strudel's `gm_flute`).

## Architecture

```
server.ts (MCP server — 4 tools, 14 guide resources, 2 ext-apps UIs)
├── ABC / Sheet Music
│   ├── ext-apps UI: mcp-app.html (Vite-bundled, ABCJS)
│   │   └── src/mcp-app.ts (rendering, audio, streaming, note highlighting)
│   ├── browser fallback: src/browser-fallback.ts
│   └── logic: src/music-logic.ts, src/server-logic.ts
│
├── Strudel / Live Patterns
│   ├── ext-apps UI: strudel-app.html (Vite-bundled, loads @strudel/repl from CDN)
│   │   └── src/strudel-app.ts (REPL embedding, layout fixes, playback control)
│   ├── browser fallback: src/strudel-browser-fallback.ts
│   └── guide: src/strudel-guide.ts (7 topics, ~600 lines)
│
├── Shared Guide Data
│   ├── src/abc-guide.ts — ABC guide content (7 topics, shared with worker/)
│   └── src/strudel-guide.ts — Strudel guide content (7 topics, shared with worker/)
│
├── main.ts — entry point, --render-mode/--output-dir parsing, stdio + HTTP transports
│
└── worker/ — Cloudflare Worker for remote MCP (no local setup required)
    ├── src/index.ts — McpAgent + Durable Objects, analytics
    ├── wrangler.jsonc — Cloudflare config
    └── Live at: https://mcp-music-studio.linxule.workers.dev/mcp
```

### Strudel Integration

- **Design philosophy**: AI-generates-code. One `code` parameter, comprehensive guide. The AI reads the guide and writes Strudel code directly.
- **CDN loading**: `@strudel/repl@1.3.0` loaded from unpkg.com at runtime (not bundled — 1.7MB)
- **Layout fix**: The `<strudel-editor>` component places its CodeMirror editor as a DOM sibling and prepends a `position:fixed` canvas to `document.body`. CSS hides the canvas (`body > canvas[style*="position"] { display: none }`), ensuring the code editor is immediately visible.
- **Soundfonts**: `prebake()` registers all 128 GM instruments. Audio data loads lazily from `felixroos.github.io`.
- **CSP**: `resourceDomains` for CDN script loading, `connectDomains` for sample/soundfont fetching.

### ABC Integration

- **ABCJS version**: ^6.4.4 (bundled via Vite, CDN 6.6.2 for browser fallback)
- **Style presets** inject MIDI directives after K: line, before V: lines
- **Forgiving parser**: messages with "Expected"/"Unknown"/"Error" → fatal, others → pass
- **State reset** on every invocation via `prepareToolInput()`
- **Autoplay**: calls `synthControl.play()` after rendering

## File Guide

| File | Purpose |
|------|---------|
| `server.ts` | MCP server, 4 tools, guide imports, resource registration |
| `main.ts` | Entry point: stdio + HTTP transports |
| `src/abc-guide.ts` | ABC guide content (7 topics, shared with worker/) |
| `src/music-logic.ts` | ABC pure functions: instruments, presets, processing |
| `src/server-logic.ts` | ABC parse validation |
| `src/strudel-guide.ts` | Strudel guide content (7 topics) |
| `src/mcp-app.ts` | Ext-apps: ABCJS rendering, streaming, cursor control |
| `src/mcp-app.css` | ABC UI: dark/light mode, note highlighting |
| `src/strudel-app.ts` | Ext-apps: Strudel REPL embedding, layout fixes |
| `src/strudel-app.css` | Strudel UI: layout fixes for ext-apps iframe |
| `src/browser-fallback.ts` | ABC browser mode HTML generation |
| `src/strudel-browser-fallback.ts` | Strudel browser mode HTML generation |
| `mcp-app.html` | ABC ext-apps template (Vite input) |
| `strudel-app.html` | Strudel ext-apps template (Vite input) |

## Testing

```bash
bun run test         # run once
bun run test:watch   # watch mode
```

## Publishing

### npm (local/stdio mode)
CI auto-publishes on version tags via `.github/workflows/publish-mcp.yml`:
```bash
git tag v0.2.0 && git push --tags
```

Package publishes only `dist/` (via `files` field). Entry points:
- `dist/index.js` — CLI binary (shebang, stdio mode)
- `dist/server.js` — library export
- `dist/mcp-app.html` — ABC ext-apps UI (~644KB)
- `dist/strudel-app.html` — Strudel ext-apps UI (~126KB, loads REPL from CDN)

### Cloudflare Worker (remote MCP)
Build root first, then deploy worker:
```bash
bun run build          # builds dist/ HTML files the worker imports
cd worker && bunx wrangler deploy
```
Live at: `https://mcp-music-studio.linxule.workers.dev/mcp`

Worker serves Streamable HTTP at `/mcp` and legacy SSE at `/sse`.
No auth — public creative tool. Analytics track tool usage via Analytics Engine.

## Client Quirks

- **Cherry Studio**: `extractToolResult()` only reads `type: "text"`. Joins CLI args with trailing spaces. Use `--render-mode browser`.
- **Claude Desktop ext-apps**: `<strudel-editor>` requires layout fix CSS (canvas hidden, editor sibling sized). CSP needs both `resourceDomains` (script loading) and `connectDomains` (sample/soundfont fetching).
- **Browser autoplay**: AudioContext starts suspended until user click. Both tools attempt autoplay but fall back gracefully.
