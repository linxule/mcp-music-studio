# Playing together

Three ways to make music with the AI instead of only asking it for a piece: a live session it can read and answer, controls you play by hand or by moving your phone, and tools that let an assistant change a player that is already open.

## Live sessions

Ask for a live session. The assistant opens one player (`play-live-pattern` with `session: true`) and keeps using it instead of opening a new one each time.

- `get-session` reads what happened on the player: whether it is playing, its errors, your taps, your control moves, your code edits, and whether you pressed Pass.
- `update-session` sends new code to the same player. The new code starts at the next bar or phrase. Until then, the old pattern keeps playing.
- `get-session` with `wait: "pass"` waits until you press Pass, then returns what you did. This lets you and the AI take turns many times inside one reply: you play, the AI answers, you play again. While it waits, the player shows "Claude is listening". That wording is the same in every app.
- When the AI is not listening, the button reads "Pass → chat". It logs your turn and also puts a message in the chat, because a message is the only way to start the AI's next turn.
- Press End session to close the session. The player keeps playing your last pattern, a listening AI is told at once, and the session is deleted about 10 minutes later.
- Set `quantize` to the phrase length. If `quantize` is 4 but the phrase is 8 bars long, the new code can start in the middle of the phrase.
- `/s/<id>` opens the session's current pattern on another screen, for example a phone or a projector.
- A player that has been stopped and untouched for 30 minutes stops checking in. Press Play, edit, tap, move a control or press Pass to rejoin. An update the AI sent in the meantime then plays.
- A session is deleted two hours after its last activity. Anyone holding its id can read it and send it code, so treat the id like a share link.

In chat hosts that cannot read a widget's context directly (claude.ai is one), a session is how the AI hears what you did.

## Controls and sensors

- `fader('name')`, `pad('name')` and `xy('name')` put real controls under the code. Each is a Strudel signal you can use anywhere a number goes: `.lpf(fader('cutoff').range(200, 4000))`.
- Values persist by name across re-evaluations, so the AI can rewrite the pattern without resetting your faders.
- `tilt()` follows the device's motion and `mic()` the input loudness. Where the page cannot use them, they turn into an xy pad and a fader you play by hand, so a piece works in a chat and on a phone alike.
- In a live session, every control move is logged for the AI to read.

The guide's `interactive` topic has worked examples, and the gallery has two pieces built on them: Weather Machine and Two Decks.

## Tools on the player itself

Every player offers tools to the page that hosts it:

| Tool | What it does |
|------|--------------|
| `get-studio-state` | Read the live code (including unsaved edits), settings, selection, revision and playback |
| `set-pattern` / `set-score` | Replace the code or score, stopped |
| `swap-pattern` | Swap new code into a playing pattern on the next bar (live players only) |
| `play-current-music` / `stop-music` | Play or stop this player |
| `undo-studio-edit` | Restore the code before the last agent edit, stopped |
| `explain-selection` / `suggest-edit` | Answer a review request from the local studio |

Writes need the player's `instanceId` and current `revision`, so an agent never overwrites an edit it has not read. `swap-pattern` uses the same bar-quantized swap as live sessions. A newer edit, swap, Play, Stop or Undo cancels a swap that is still waiting, and a bar more than about 12 seconds away answers "queued" and reports later in `get-studio-state`.

No chat host calls player tools yet. Two places do:

- **Shared player pages** (`/play`, `/p/<id>`, `/s/<id>`) pass the tools to an assistant built into the browser through [WebMCP](https://webmachinelearning.github.io/webmcp/), in Chromium with WebMCP enabled or Codex desktop's built-in browser. A shared page still never runs on its own: the assistant can read, stage, stop and undo, but play and swap appear only after Play is pressed on that page. Every result is marked as untrusted content, because a shared page's code is the link author's.
- **The local studio** (`bun run studio`) hosts both players side by side with shared review. See [development](development.md).

---

[← Back to the README](https://github.com/linxule/mcp-music-studio/blob/main/README.md)
