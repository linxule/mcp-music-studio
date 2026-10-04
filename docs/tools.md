# Tools and prompts

## Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `play-sheet-music` | ABC notation → visual sheet music + multi-instrument audio | `abcNotation`, `title?`, `instrument?`, `style?`, `tempo?` (40–240), `swing?` (0–75), `drumIntro?` (0–8), `transpose?` (−12–12) |
| `play-live-pattern` | Strudel code → live-coded patterns with synthesis + effects | `code`, `title?`, `bpm?` (40–300), `autoplay?`, `visuals?`, `theme?`, `session?` |
| `get-session` | Read a live session: what the player is doing, its errors, and what the listener did (taps, controls, edits, Pass) — or wait until the person listening presses Pass | `session`, `wait?` (`pass` \| `activity`) |
| `update-session` | Swap a new pattern into a live session's player on the next bar or phrase — no new player | `session`, `code`, `quantize?` (0–32) |
| `get-music-guide` | ABC reference (7 topics: instruments, drums, syntax, genres...) | `topic` |
| `get-strudel-guide` | Strudel reference (15 topics: sounds, effects, visuals, hydra, genres, stage, film, interactive, craft, gallery...) | `topic`, `piece?` (with `gallery`) |
| `search-music-docs` | Semantic search over strudel.cc and ABCJS docs | `query`, `library` (`strudel` \| `abcjs`) |
| `analyze-harmony` | Name a chord, guess the key, get a progression or chord scale — in ABC and Strudel spellings | `task`, `notes?`, `chords?`, `key?`, `romanNumerals?` |
| `convert-abc-to-strudel` | Turn a scored ABC melody into a Strudel mini-notation pattern | `abcNotation`, `voice?`, `sound?` |
| `create-share-link` | Explicitly store a piece and return a 30-day link accessible to anyone holding it | `kind` (`score` or `play`), matching `score` (play-sheet-music's arguments) or `pattern` (`code`, `title?`, `bpm?`, `autoplay?`, `visuals?` — theme and session are not carried) |

**`visuals`** — `none`, `pianoroll`, `punchcard`, `scope`, `spectrum`, `hydra-kaleid`, `hydra-pulse`, `hydra-wash`, `hydra-feed`.
**`theme`** — any of the 39 schemes the Strudel REPL ships (`strudelTheme`, `nord`, `sonicPink`, `teletext`, `gruvboxDark`, `githubLight`, …).
**`style`** — `rock`, `jazz`, `bossa`, `waltz`, `march`, `reggae`, `folk`, `classical`.

## Prompts

Slash-command / menu entry points, in clients that surface MCP prompts:

| Prompt | What it does |
|--------|--------------|
| `compose-beat` | Generate + play a Strudel pattern in a genre (args: `genre`, `mood?`) |
| `harmonize-melody` | Add chords/accompaniment to an ABC melody and play it (args: `melody`, `style?`) |
| `arrange-tune` | Turn a melody/idea into a multi-voice arrangement (args: `tune`, `instrumentation?`) |

## Theory, reference and sharing
- **`analyze-harmony`** — chord detection, key detection, progressions, chord scales; answers in both ABC chord symbols and Strudel `chord()`/`note()` form
- **`convert-abc-to-strudel`** — take a scored melody into the live REPL: bars become mini-notation groups, durations become `@` weights, chord symbols become a `chord().voicing()` line
- **`search-music-docs`** — semantic search over strudel.cc and ABCJS documentation
- **Click-to-play links** — short pieces include a browser link that opens the full player: for a pattern, stage, visuals, controls and recording; for a score, the sheet-music player with its editor, style, instrument and sound menus, and WAV and MIDI downloads. Nothing plays until Play is pressed, and a "Simple player" link (`?classic=1`) opens the lighter standalone page. The music is encoded in the URL, not encrypted. Playback never stores a composition in the share database. For longer pieces, use the inline widget, a local browser render, or explicitly ask for a stored share
- **Explicit sharing** — `create-share-link` uploads a score or pattern for 30 days. Anyone with the link can view and play it; creating the same share again refreshes its expiry. Standalone Strudel pages wait for Play or an intentional editor evaluation shortcut, including older autoplay links
- **Widgets that fit the host** — both widgets size themselves from the host's container (inline, fixed or fullscreen), respect safe-area insets and the host's fonts, and never pan sideways on a phone. If the browser holds audio back until a tap, the widget says "Tap Play to start audio" instead of pretending to play. Scrolling past a widget never starts it, and a tune autoplays once — not again every time the host rebuilds the widget

---

[← Back to the README](https://github.com/linxule/mcp-music-studio/blob/main/README.md)
