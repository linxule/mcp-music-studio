# MCP Music Studio

Two-mode creative music studio for AI: **scored composition** (ABC notation with sheet music) and **live performance** (Strudel live coding with TidalCycles). Interactive UI renders inline in Claude Desktop, claude.ai, and other MCP clients.

## Quick Start — No Install Required

Paste this URL into any MCP client that supports remote servers:

```
https://mcp-music-studio.linxule.workers.dev/mcp
```

**Claude Desktop / claude.ai:**
Settings → Connectors → Add Connector → paste the URL above → done.

**Claude Code:**
```bash
claude mcp add --transport http music-studio https://mcp-music-studio.linxule.workers.dev/mcp
```

That's it — ask Claude to play a song or create a beat.

---

## What You Get

### Scored Composition (ABC Notation)
Write sheet music → see it rendered → hear it played with multi-instrument audio.

- **8 style presets** — rock, jazz, bossa, waltz, march, reggae, folk, classical — one parameter adds drums + bass + chord accompaniment
- **30 instruments** — piano, strings, brass, woodwinds, synths — selectable by name
- **Visual sheet music** — notes highlight as they play
- **Streaming render** — sheet music appears as the AI types
- **`get-music-guide`** — 7 reference topics (instruments, drums, ABC syntax, arrangements, genres, styles, MIDI directives)

### Live Performance (Strudel)
Write code → hear it play → edit in a live REPL.

- **TidalCycles mini-notation** in JavaScript
- **72 drum machine banks** + **128 GM instruments** + built-in synths
- **Full effects chain** — filters, reverb, delay, FM synthesis
- **Editable REPL** — users can tweak the code and hear changes instantly
- **`get-strudel-guide`** — 7 reference topics (mini-notation, sounds, effects, patterns, genres, tips, advanced)

### Shared
- **`search-music-docs`** — semantic search over strudel.cc and ABCJS documentation

---

## Local Install (Optional)

The remote URL above works without any local setup. If you prefer running locally (offline use, lower latency), install via npm:

### CLI One-Liners

```bash
# Claude Code
claude mcp add music-studio -- npx -y mcp-music-studio --stdio

# Codex CLI
codex mcp add -- npx -y mcp-music-studio --stdio

# Gemini CLI
gemini mcp add -- npx -y mcp-music-studio --stdio

# OpenCode
opencode mcp add music-studio -- npx -y mcp-music-studio --stdio
```

### JSON Config (Claude Desktop, Cursor, Windsurf, etc.)

<details>
<summary>Claude Desktop — edit config file</summary>

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
</details>

<details>
<summary>VS Code / Trae / PearAI</summary>

Add to `.vscode/mcp.json` — note: uses `"servers"` not `"mcpServers"`:

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
</details>

<details>
<summary>Cursor</summary>

Add to `~/.cursor/mcp.json`:

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
</details>

<details>
<summary>Windsurf</summary>

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
</details>

<details>
<summary>Windows</summary>

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
</details>

<details>
<summary>Render modes (for non-ext-apps clients)</summary>

The server auto-detects ext-apps support. For clients that don't support it (Cherry Studio, CLI environments), use `--render-mode`:

| Mode | Behavior |
|------|----------|
| `auto` (default) | Inline UI for Claude Desktop, VS Code |
| `browser` | Saves HTML and opens in system browser |
| `html` | Returns HTML as embedded resource |

```json
{
  "mcpServers": {
    "music-studio": {
      "command": "npx",
      "args": ["-y", "mcp-music-studio", "--stdio", "--render-mode", "browser"]
    }
  }
}
```
</details>

---

## Tools

| Tool | Description |
|------|-------------|
| `play-sheet-music` | ABC notation → visual sheet music + multi-instrument audio |
| `play-live-pattern` | Strudel code → live-coded patterns with synthesis + effects |
| `get-music-guide` | ABC reference (7 topics: instruments, drums, syntax, genres...) |
| `get-strudel-guide` | Strudel reference (7 topics: sounds, effects, patterns, genres...) |
| `search-music-docs` | Semantic search over strudel.cc and ABCJS docs |

## Development

```bash
bun install
bun run dev      # watch + serve (hot reload)
bun run build    # production build
bun run test     # run tests
```

## Attribution

Forked from the [Sheet Music Server](https://github.com/modelcontextprotocol/ext-apps/tree/main/examples/sheet-music-server) example from [MCP ext-apps](https://github.com/modelcontextprotocol/ext-apps) by Anthropic, licensed under MIT.

## License

MIT
