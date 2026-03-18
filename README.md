# MCP Music Studio

A creative music tool for AI systems — compose, arrange, and play music with multi-instrument audio, style presets, and visual sheet music.

Forked from [`@modelcontextprotocol/server-sheet-music`](https://github.com/modelcontextprotocol/ext-apps/tree/main/examples/sheet-music-server) and substantially extended.

## Features

- **8 style presets** — rock, jazz, bossa, waltz, march, reggae, folk, classical. One parameter adds drums + bass + chord accompaniment.
- **30 instruments** — selectable from UI or via tool parameter, with fuzzy matching
- **Browser fallback** — `openInBrowser: true` launches a standalone player for CLI environments (Claude Code, Codex, Gemini CLI) that don't support ext-apps UI
- **`get-music-guide` tool** — on-demand reference for AI systems (instruments, drums, ABC syntax, arrangements, genre templates, MIDI directives)
- **7 `music://guide/*` resources** — same content for resource-capable clients
- **Note highlighting** — currently playing notes light up during playback
- **Forgiving parser** — warnings don't block playback, only fatal errors do
- **Streaming render** — sheet music appears as the AI types (`ontoolinputpartial`)
- **Tempo slider** — warp control in the UI
- **Fullscreen mode** — via ext-apps `requestDisplayMode`

## Install

Requires Node.js 18+. Supports stdio and HTTP transports.

### CLI Install (one-liner)

```bash
# Claude Code
claude mcp add music-studio -- npx -y mcp-music-studio --stdio

# Codex CLI
codex mcp add -- npx -y mcp-music-studio --stdio

# Gemini CLI
gemini mcp add -- npx -y mcp-music-studio --stdio
```

### Claude Desktop

Config file location:

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "music-studio": {
      "command": "npx",
      "args": ["-y", "mcp-music-studio", "--stdio"]
    }
  }
}
```

### VS Code

Add to `.vscode/mcp.json` (project) or user settings:

> **Note**: VS Code uses `"servers"` not `"mcpServers"`. Also works in Trae, Void, and PearAI.

```json
{
  "servers": {
    "music-studio": {
      "command": "npx",
      "args": ["-y", "mcp-music-studio", "--stdio"]
    }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "music-studio": {
      "command": "npx",
      "args": ["-y", "mcp-music-studio", "--stdio"]
    }
  }
}
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "music-studio": {
      "command": "npx",
      "args": ["-y", "mcp-music-studio", "--stdio"]
    }
  }
}
```

### Windows

On Windows, `npx` is a `.cmd` file and requires a shell wrapper:

```json
{
  "mcpServers": {
    "music-studio": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "mcp-music-studio", "--stdio"]
    }
  }
}
```

### ChatGPT

ChatGPT only supports remote HTTPS MCP servers. Run the HTTP transport and expose via tunnel:

```bash
npx mcp-music-studio
# Server starts on http://localhost:3001/mcp
# Use ngrok, Cloudflare Tunnel, etc. to expose publicly
```

### HTTP Transport

```bash
npx mcp-music-studio
# Server starts on http://localhost:3001/mcp
```

## Tools

### `play-sheet-music`

Creates and plays music with visual sheet music and multi-instrument audio.

| Parameter | Type | Description |
|-----------|------|-------------|
| `abcNotation` | string | ABC notation with optional chord symbols |
| `instrument` | string? | Default instrument (e.g., "Violin", "Flute") |
| `style` | enum? | Accompaniment style: rock, jazz, bossa, waltz, march, reggae, folk, classical |
| `tempo` | number? | BPM (40-240) |
| `swing` | number? | Swing feel (0-100) |
| `transpose` | number? | Semitones (-12 to 12) |
| `openInBrowser` | boolean? | Open standalone browser player (for CLI environments without UI) |

**Example — jazz arrangement:**
```json
{
  "abcNotation": "X:1\nT:Blue Note\nM:4/4\nL:1/8\nK:Bb\n\"Bbmaj7\"d2 f2 d2 Bc | \"Eb7\"_e2 g2 e2 cB | \"Dm7\"d2 f2 a2 fd | \"G7\"g2 f2 e2 dc |",
  "style": "jazz",
  "instrument": "Alto Sax",
  "tempo": 140
}
```

### `get-music-guide`

Returns reference material for composition. Topics:

| Topic | Contents |
|-------|----------|
| `instruments` | All 128 GM instruments by family, program numbers, combo suggestions |
| `drums` | Percussion notes, pattern syntax, 8 ready-to-use patterns |
| `abc-syntax` | Notes, rests, chords, repeats, dynamics, multi-voice, lyrics |
| `arrangements` | Multi-voice patterns, volume balancing, accompaniment setup |
| `genres` | Complete ABC examples: jazz, blues, folk, minuet, rock, bossa, lullaby |
| `styles` | What each style preset does and when to use it |
| `midi-directives` | Full `%%MIDI` reference for ABCJS |

## Development

```bash
bun install
bun run dev      # watch + serve (hot reload)
bun run build    # production build
bun run serve    # HTTP server on port 3001
```

## Architecture

```
mcp-music-studio/
├── server.ts              # MCP server: tools, resources, guides, forgiving parser
├── main.ts                # Entry point: HTTP + stdio transports
├── mcp-app.html           # HTML shell (Vite inlines everything for ext-apps UI)
├── src/
│   ├── mcp-app.ts         # Ext-apps client: rendering, audio, streaming
│   ├── mcp-app.css        # Styles: dark mode, note highlighting, toolbar
│   ├── music-logic.ts     # Shared: instruments, presets, ABC processing
│   ├── server-logic.ts    # Server: parse validation, result construction
│   ├── browser-fallback.ts # Browser player: HTML generation, auto-open
│   └── global.css         # Base reset
├── tests/                 # Vitest tests
├── vite.config.ts         # Single-file HTML bundling
├── tsconfig.json          # Client TypeScript config
└── tsconfig.server.json   # Server TypeScript config
```

## Attribution

This project is a fork of the [Sheet Music Server](https://github.com/modelcontextprotocol/ext-apps/tree/main/examples/sheet-music-server) example from the [MCP ext-apps](https://github.com/modelcontextprotocol/ext-apps) repository by Anthropic, licensed under MIT.

## License

MIT
