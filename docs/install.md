# Install and client setup

The remote URL above works without any local setup. If you prefer running locally (offline use, lower latency), install via npm:

## CLI One-Liners

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

## JSON Config (Claude Desktop, Cursor, Windsurf, etc.)

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

Clients that support ext-apps render the interactive UI inline automatically (`auto` mode). For clients that don't (Cherry Studio, CLI environments), use `--render-mode`:

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

Clients without a widget also get a **click-to-play link** in the tool result, served by the hosted worker — no local render mode needed.
</details>

<details>
<summary>HTTP mode (<code>--host</code>, <code>--allow-origin</code>)</summary>

Without `--stdio` the server listens over Streamable HTTP. That endpoint is **unauthenticated**, so it binds `127.0.0.1:3001` by default and only accepts browser requests from loopback origins.

| Flag | Default | Purpose |
|------|---------|---------|
| `--host ADDR` | `127.0.0.1` | Bind address. A non-loopback value prints a warning and turns off the SDK's DNS-rebinding protection — put a proxy that authenticates in front of it |
| `--allow-origin ORIGIN` | loopback pages only | Extra CORS origins (comma-separated, repeatable; `*` opts back into a wildcard) |
| `PORT` (env) | `3001` | Listen port |

</details>

---

[← Back to the README](https://github.com/linxule/mcp-music-studio/blob/main/README.md)
