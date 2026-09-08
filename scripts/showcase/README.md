# Release showcase recorder

Produces a short montage video of the shipped widgets — every frame is the real
`dist/` widget running in the `dev/` ext-apps harness, with sound.

```bash
bun run build
bunx vite --config dev/vite.config.ts --port 5210 &   # harness on :5210
node scripts/showcase/record.mjs        # → /tmp/ms-showcase/{video,audio}/*.webm + manifest.json
node scripts/showcase/cards.mjs         # title cards from the manifest → cards/*.png
node scripts/showcase/assemble.mjs      # trims, muxes audio, concatenates → out/*.mp4
```

Pass scene ids to `record.mjs` to re-record a subset (`node record.mjs 07-pianoroll`);
merge its `manifest-<ids>.json` back into `manifest.json` before assembling.

Dependencies (deliberately not in package.json): `playwright` (imported from
`~/node_modules`, edit the path) and a static ffmpeg with libx264 + drawtext
(`bun add ffmpeg-static` in a scratch dir; Homebrew's ffmpeg was ABI-broken
against x265 at the time).

## How the audio works — and what it caught

Playwright's `recordVideo` is silent, so `record.mjs` injects an init script
that redefines `BaseAudioContext.prototype.destination` to return a GainNode
fanned out to the real destination *and* a `MediaStreamDestination`, then
records that stream with a `MediaRecorder` inside the widget frame. Two
non-obvious details:

- superdough sizes its channel merger from `destination.maxChannelCount`; a
  GainNode has none, which reads as 0 → "channel count outside [1, 32]" and
  silence. The tap defines `maxChannelCount` on the gain node.
- A scene that records at −91 dB is a **product bug, not a capture bug**. That is
  how the v0.5.0 preset-order bug (`all(...)` appended after the pattern →
  silence with "Playing…") was found: the three scenes using 2D presets and
  `hydra-feed` were the only silent ones. Check `mean_volume` per scene before
  assembling.

The video timestamps run from context creation; the manifest stores the
recorder start (`audioOffset`) and when the widget first reported playing
(`start`), which `assemble.mjs` uses for `adelay` and the trim.
