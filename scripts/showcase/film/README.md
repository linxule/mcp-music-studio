# Release film recorder ("Rest", 0.5.13)

Shoots `dev/film.html` — a wordless phone conversation of real widgets — as two
takes with identical gestures, then cuts them into one 1080×1920 film.

```sh
bun run build                                            # dist/ widgets
bunx vite --config dev/vite.config.ts --port 5210 &      # the set
export FILM_WORK=/tmp/ms-film FFMPEG=/path/to/ffmpeg     # outputs stay out of iCloud
bun scripts/showcase/film/take.mjs old                   # the published 0.5.8 widgets (fetched from npm)
bun scripts/showcase/film/take.mjs new                   # dist/
bun scripts/showcase/film/cut.mjs                        # → $FILM_WORK/cut/mcp-music-studio-0.5.13-rest.mp4
```

Helpers: `encode.mjs <take>` (frames + audio → mp4), `sheet.mjs <take> mark+secs…`
(contact sheet at recorded marks), `sync.py <take>` (A/V offset: first score
highlight vs first audio onset; run with `uv run --with numpy`).

What was measured to get here:

- **Screencast frames are CSS px**, not device px — so the phone is 390 CSS px
  scaled with CSS `zoom`, which the widgets see as devicePixelRatio 2.77.
- **Playwright's `evaluate` is a user gesture.** Everything goes through CDP
  `Runtime.evaluate` with `userGesture: false` (per-frame execution contexts;
  they can be replaced, hence the rescan). Touches are CDP
  `Input.dispatchTouchEvent`; the page draws the finger.
- **Headless Chromium with `--use-angle=metal`** records Hydra at ~45–60 fps;
  SwiftShader manages ~18 at this size.
- **Audio**: a ScriptProcessor on every widget's master (the `destination`
  getter is tapped), each chunk stamped with wall time via
  `getOutputTimestamp()`, mixed on one timeline. It trails the picture by
  105–133 ms (`sync.py`), so `cut.mjs` shifts it 120 ms. AudioContexts are
  forced to 48 kHz — they default to the output device's rate, and a Bluetooth
  headset in call mode made one take 24 kHz.
- **No `allow="autoplay"`** on the frames: with it, a scrolling pan releases a
  parked autoplay in Chromium in every version (see dev/README), so a
  "0.5.8 wakes on scroll" shot can't be filmed truthfully here — the iOS bug
  0.5.9 fixed is WebKit's, and Playwright can't pan WebKit.
