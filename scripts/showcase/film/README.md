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

v3 shape: 2 s flash-forward of the climax → *Rest* bars 1–2 on 0.5.8, paused
(dead air) → the same on 0.5.13 (it rings), under a waveform line drawn from the
real audio → flick → four typed layers on downbeats → fullscreen stage → five
Hydra scenes (`SCENES` in `dev/film-score.ts`) swapped just before downbeats by
reading Strudel's scheduler clock → Stop rings out → end card.
`lab.mjs [scene…]` previews scenes in fullscreen stage with a contact sheet.

**v4 (pure image and sound, ~44 s)** drops the phone and chat. Two stages:
`dev/stage-score.html` renders *Rest* with abcjs itself (the widget's synth
options and Room) on black, a camera cutting glyph to glyph, the ink driven by
an AnalyserNode on the real output (`?mode=old` = 0.5.8's 200 ms release and no
Room; `?mode=new` = 0.5.13's). `dev/stage-strudel.html` hosts the real Strudel
widget fullscreen with its chrome hidden (`clean()`) or one layer alone
(`solo(id)`).

```sh
bun scripts/showcase/film/stage.mjs            # score-old, score-new
bun scripts/showcase/film/screens.mjs build    # layers every 2 cycles, the five scenes, Stop
bun scripts/showcase/film/screens.mjs solo     # each layer alone for a 4-cycle loop
bun scripts/showcase/film/captions.mjs "$FILM_WORK/captions"
# encode each take with the −120 ms audio shift, then:
bun scripts/showcase/film/cut4.mjs             # → $FILM_WORK/cut4/rest-v4.mp4
```

Panels are phase-matched: every downbeat is logged (`c<N>` marks) and a panel
shows its layer at the same cycle mod 4 as the audio under it. Gotcha: after
`send()` the widget may already be playing (the host page's gesture reaches a
same-origin frame) — pressing Play then STOPS it and clears the draw layers,
which looks exactly like a layering bug.

**v5 — a composed piece, six cameras (~66 s, 60 fps).** `dev/film-song.ts` is
the song (D minor, 144 bpm = 2 × Rest's 72; one bar = 100 frames at 60 fps).
The arrangement lives in the code as masks — `.mask("<0!4 1!11 [1 1 1 0] …>")`,
one step per bar — so the whole song is ONE evaluation and every entry lands on
its downbeat to the sample; `[1 1 1 0]` is the rest before the drop.
(Arranging by re-evaluating each section did not work: Strudel schedules
ahead, so a section's first beat went missing and a mute landed ~0.3 s late.)
Only the Hydra shader changes during a take, on `SCENE_CUES`.

```sh
for cam in full code roll beat hydra rings; do bun scripts/showcase/film/song.mjs $cam; done
# encode each take at 60 fps with the −120 ms shift, then:
bun scripts/showcase/film/cut5.mjs    # EDL in bars → $FILM_WORK/cut5/rest-v5.mp4
```

Each take stops the warm-up and restarts the scheduler at cycle 0, so bar n is
cycle n in every camera; `cut5.mjs` cuts between them over song-full's audio.
Gotchas: two `.pianoroll()`s in one pattern share an animation and the second
wins (the melody draws a `.spiral()` instead); TR909 at gain 0.6 clips.

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
