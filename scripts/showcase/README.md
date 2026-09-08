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

## The live-set route (OBS, 1080p60, one continuous piece)

`dev/perform.html` + `dev/perform.ts` is a self-driving performance page: it
mounts both widgets through the real `AppBridge`, then runs a cue list that
re-sends `tool-input` into the SAME Strudel widget — each section is a
hot-swapped re-evaluation on the running clock (`scheduler.now` keeps
climbing), Hydra evolves with it, captions are DOM over the visuals, and the
piece opens and closes on the ABC score. Capture it with an OBS Browser Source
(the route documented in `~/Documents/Apps/llm-world/recording/README.md`):

```bash
bunx vite --config dev/vite.config.ts --port 5210 &
# OBS: scene "music-studio-perform", browser_source "perform-page"
#   url http://localhost:5210/perform.html?autoplay=0, 1920×1080, fps 60, reroute_audio
# start_record → wait outputActive → set url …?autoplay=1 → ~216 s → stop_record
```

Portrait (3:4 for Xiaohongshu): `?w=1080&h=1440` — the page reflows long
lines at method-chain boundaries (`reflow()`), and the widgets lay out at
size/1.35. Use a SEPARATE scene + browser source sized 1080×1440 and set the
canvas with `set_video_settings`; then **reset the scene item transform to
scale 1 / position 0** — OBS auto-fits a new source into the canvas
(`scaleX 1.333`) and the take comes out cropped with a blank strip. Restore
the 1920×1080 canvas afterwards.

Gotchas measured on OBS 32 / CEF: CSS `zoom` on the iframes is ignored (use
`transform: scale()`); WebGL and WebAudio autoplay both work; the take's audio
peaks ~+0.9 dBFS on two hits, so encode with a limiter. `?speed=6` rehearses
the cue list faster, but the widgets don't load faster, so only real time is
representative. Never poke abcjs's transport mid-piece — its button toggles and
would restart the tune.
