# MCP Music Studio

**English** · [简体中文](https://github.com/linxule/mcp-music-studio/blob/main/README.zh-CN.md) · [Français](https://github.com/linxule/mcp-music-studio/blob/main/README.fr.md) · [日本語](https://github.com/linxule/mcp-music-studio/blob/main/README.ja.md)

[![npm](https://img.shields.io/npm/v/mcp-music-studio)](https://www.npmjs.com/package/mcp-music-studio) [![CI](https://github.com/linxule/mcp-music-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/linxule/mcp-music-studio/actions/workflows/ci.yml) [![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](https://github.com/linxule/mcp-music-studio/blob/main/LICENSE)

Make music with an AI assistant, inside the chat. Ask for a song and get sheet music you can play and edit. Ask for a beat and get a live-coding player with visuals. Then edit the piece together, move its controls while it plays, or take turns with the AI.

Music Studio is an MCP server. MCP is a standard way to give an AI assistant extra tools; you need a chat app that supports it, such as Claude. In Claude, claude.ai and other apps that support MCP Apps, the player appears in the chat. In Claude Code and other terminal apps, you get a link that opens the player in your browser.

<a href="https://github.com/linxule/mcp-music-studio/releases/download/v0.5.3/mcp-music-studio-v0.5-live-set-1080p60.mp4"><img src="https://raw.githubusercontent.com/linxule/mcp-music-studio/main/assets/live-set-stage.gif" alt="A Strudel pattern with its piano roll fed into a Hydra shader, then Stage mode taking the whole frame" width="720"></a>

*One live set in the player. Every section is a change made while the music plays. [Watch the full video](https://github.com/linxule/mcp-music-studio/releases/download/v0.5.3/mcp-music-studio-v0.5-live-set-1080p60.mp4).*

## Quick start

Add this URL as a remote MCP server. There is nothing to install.

```
https://music-studio.linxule.com/mcp
```

- **Claude and claude.ai:** open Settings, then Connectors, add a custom connector, and paste the URL.
- **Claude Code:** run `claude mcp add --transport http music-studio https://music-studio.linxule.com/mcp`

Then ask for a song, a beat or a music video. No account is needed. Your browser may hold back sound until you tap Play in the player once.

## What you can make

- **Sheet music.** Scores in ABC notation, drawn as sheet music and played with any of the 128 General MIDI instruments. Add a style (rock, jazz, bossa and others) for drums, bass and chords. Edit the score in place, transpose it, and download WAV or MIDI. [More about sheet music](https://github.com/linxule/mcp-music-studio/blob/main/docs/sheet-music.md)
- **Live coding.** Patterns in [Strudel](https://strudel.cc), the JavaScript version of TidalCycles, in an editor you can change while it plays: drum machines, synths, effects, piano rolls and Hydra shader visuals that follow the music. [More about live coding](https://github.com/linxule/mcp-music-studio/blob/main/docs/live-coding.md)
- **Music videos and stage pieces.** Pattern code can draw, react to every note, respond to taps and speak lines in time with the music. The guide's gallery has a short film, a spoken duet and a Game of Life that composes.
- **Play together.** A live session keeps one player open. The AI reads what you did and puts its reply on the same player, starting at the next bar. Faders, pads and your phone's motion become controls. [More about playing together](https://github.com/linxule/mcp-music-studio/blob/main/docs/playing-together.md)
- **Share.** When a score or pattern is small enough to fit in a link, the reply includes a link that opens the full player. For a larger piece, ask for a stored link, which lasts 30 days.

## Tools

| Tool | What it does |
|------|--------------|
| `play-sheet-music` | Draw and play a score written in ABC notation |
| `play-live-pattern` | Open a live-coding player for Strudel code, optionally as a live session |
| `get-session` | Read what happened in a live session, or wait until the person listening presses Pass |
| `update-session` | Swap new code into a live session's player on the next bar or phrase |
| `get-music-guide` | Reference for ABC notation: syntax, instruments, styles, genres |
| `get-strudel-guide` | Reference for Strudel: sounds, effects, visuals, stage, gallery pieces |
| `search-music-docs` | Search the Strudel and abcjs documentation |
| `analyze-harmony` | Name chords, find the key, build progressions |
| `convert-abc-to-strudel` | Turn a scored melody into a Strudel pattern |
| `create-share-link` | Store a piece for 30 days and return a link anyone can open |

Parameters, prompts and the players' own tools: [tools and prompts](https://github.com/linxule/mcp-music-studio/blob/main/docs/tools.md).

## Run it on your computer

The hosted URL needs no setup. To run the server locally instead, use npm:

```bash
claude mcp add music-studio -- npx -y mcp-music-studio --stdio
```

Setup for Claude Desktop, Codex, Gemini CLI, VS Code, Cursor, Windsurf and others, plus render modes and HTTP mode: [install and client setup](https://github.com/linxule/mcp-music-studio/blob/main/docs/install.md).

## More

- [Changelog](https://github.com/linxule/mcp-music-studio/blob/main/CHANGELOG.md)
- [Development](https://github.com/linxule/mcp-music-studio/blob/main/docs/development.md)
- [Privacy policy](https://music-studio.linxule.com/privacy). Playback does not save your piece in the share database. A live session keeps a log until two hours after its last activity, and spoken lines are cached for 30 days. Links that fit the music in the URL carry it in the link itself. Do not put private information in scores, code, titles or spoken lines. `create-share-link` stores a piece only when you ask.
- [Report an issue](https://github.com/linxule/mcp-music-studio/issues)

## Credits and license

Forked from the [Sheet Music Server](https://github.com/modelcontextprotocol/ext-apps/tree/main/examples/sheet-music-server) example in [MCP ext-apps](https://github.com/modelcontextprotocol/ext-apps) by Anthropic (MIT). Live coding uses [Strudel](https://codeberg.org/uzu/strudel), notation uses [abcjs](https://github.com/paulrosen/abcjs), and shader visuals use [hydra-synth](https://hydra.ojack.xyz).

Licensed under AGPL-3.0-or-later. The original MIT notices are in [LICENSES/MIT.txt](https://github.com/linxule/mcp-music-studio/blob/main/LICENSES/MIT.txt). See [SOURCE.md](https://github.com/linxule/mcp-music-studio/blob/main/SOURCE.md) for the corresponding source and [THIRD_PARTY_NOTICES.md](https://github.com/linxule/mcp-music-studio/blob/main/THIRD_PARTY_NOTICES.md) for dependency and audio licensing. Music you make is not automatically licensed under the software license.
