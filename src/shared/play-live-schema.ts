// play-live-pattern's input schema. Kept apart from tool-defs.ts (which
// re-exports it) so the Strudel widget's studio tools can use it without
// bundling every guide, the gallery and the ABC defaults (measured: +500 KB).

import { z } from "zod";
import { MAX_SOURCE_CHARS } from "./input-bounds.js";
import { EDITOR_THEMES, VISUAL_PRESETS } from "./visual-presets.js";

export const playLiveInputSchema = z.object({
  code: z
    .string()
    .max(MAX_SOURCE_CHARS)
    .describe(
      "Strudel pattern code. Uses TidalCycles mini-notation in JavaScript. " +
        "Use stack() to layer drums, bass, and melody. " +
        "Set tempo with setcps(bpm/60/4) or use the bpm parameter. " +
        "The REPL plays the LAST expression: setup lines (await initHydra(), all(), setcps()) go BEFORE the pattern. " +
        "Double quotes are mini-notation — use single quotes for plain strings and URLs. " +
        "One draw method per pattern; pass a.fft values as functions (() => a.fft[0]).",
    ),
  title: z
    .string()
    .optional()
    .describe("Pattern title displayed in the widget header (e.g. 'Midnight Rain')."),
  bpm: z
    .number()
    .min(40)
    .max(300)
    .optional()
    .describe("Tempo in BPM (40-300). Converts to setcps() automatically."),
  autoplay: z
    .boolean()
    .optional()
    .describe(
      "Start playing immediately (default: true). May require user click due to browser autoplay policy.",
    ),
  visuals: z
    .enum(VISUAL_PRESETS)
    .optional()
    .describe(
      "Ready-made visual, for when the code has none of its own. " +
        "pianoroll/punchcard/scope/spectrum draw onto the 2D canvas behind the code; " +
        "hydra-kaleid (rotating kaleidoscope), hydra-pulse (shape driven by a rhythm), " +
        "hydra-wash (slow ambient noise) and hydra-feed (the piano roll mirrored and trailed) " +
        "are WebGL shader backgrounds. A preset fills the MISSING layer: a hydra preset is skipped only if the code already calls initHydra(), " +
        "a 2D preset only if the code already has a draw method — so hydra-wash layers happily under your own .pianoroll(). " +
        "Hydra presets are dropped for viewers who prefer reduced motion. " +
        "Writing your own visual is still the better result (draw methods: topic 'visuals'; shaders: topic 'hydra').",
    ),
  session: z
    .boolean()
    .optional()
    .describe(
      "Open a LIVE SESSION: this player stays open as one performance. update-session swaps in new code on the next bar " +
        "without a new player and says whether it ran; get-session reads the player's runtime reports and what the user did " +
        "(taps, code edits, handing you the turn). Use it to iterate on a long piece, to check that a piece really played, or " +
        "to jam back-to-back. Its log (reports, taps, edits, your updates) is kept on the server until 2 hours idle.",
    ),
  theme: z
    .enum(EDITOR_THEMES)
    .optional()
    .describe(
      "Editor colour theme; the visuals stage and its readability scrim are derived from it, so it also decides whether a shader sits on a dark or light ground — " +
        "prefer a dark one when the visual is the point (e.g. 'nord', 'sonicPink', 'tokyoNight'). Not carried into share links or the browser fallback.",
    ),
});
