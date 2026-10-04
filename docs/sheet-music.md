# Sheet music (ABC notation)
Write sheet music → see it rendered → hear it played with multi-instrument audio.

- **8 style presets** — rock, jazz, bossa, waltz, march, reggae, folk, classical — one parameter adds drums + bass + chord accompaniment
- **All 128 General MIDI instruments** — named and fuzzy-matched (`"sax"` → Soprano Sax); the result text says what it actually resolved to when that isn't what you asked for. When the score picks its own instrument (`%%MIDI program`), the Instrument menu shows it, and choosing another really swaps the melody's instrument
- **Visual sheet music** — notes highlight as they play (on the swung beat when `swing` is set), and the score scrolls to keep the playing line in view. Scroll by hand at any time and the follow steps aside
- **Streaming render** — sheet music appears as the AI types
- **Edit in place** — open the ABC source pane in the widget, fix a bar, re-render without another tool call
- **Click a note** — it sounds (with the tune's instrument, sound bank and Room) and its ABC is selected in the source pane, so "explain this" or "change this" can point at it. Shift-click a second note to select everything between. A finger that scrolls the score doesn't count as a click
- **Practice row** — under the transport: **Loop selection** plays the selected notes round and round (select them on the score or in the source pane), and a score with two or more voices gets a toggle per voice to mute it. Muting keeps your place. Slow it down with the transport's % field. The WAV download sounds like what you hear (mutes included); the MIDI download always writes every voice
- **Real transposition** — `transpose` rewrites the notation *and* the key signature, so the printed score matches what plays
- **Swing and count-in** — `swing` is the share of the beat given to its first half (50 = straight, 66 = triplet, 75 = max; ≤50 is no swing), `drumIntro` adds up to 8 bars of count-in from the style's drum kit
- **Selectable sound banks** — FluidR3 (default), MusyngKite (fuller), or a lightweight dry bank, switched live from the toolbar. Changing instrument, sound, style or tempo keeps your Loop and tempo settings and never starts a paused tune
- **Notes that ring out** — each note fades naturally instead of stopping dead, and a light **Room** echo (on by default, one toolbar toggle) gives the synth a space to play in. WAV downloads and share links sound the same
- **WAV download** — export audio as WAV files directly from the UI
- **MIDI download** — export a standard MIDI file straight from the score, no playback needed first. It is the *score*: abcjs applies swing during playback only, so the exported file has none
- **`get-music-guide`** — 7 reference topics (instruments, drums, ABC syntax, arrangements, genres, styles, MIDI directives)

---

[← Back to the README](https://github.com/linxule/mcp-music-studio/blob/main/README.md)
