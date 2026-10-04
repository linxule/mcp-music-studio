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
      "A ready-made visual for code that has none of its own: pianoroll, punchcard, scope or spectrum " +
        "(drawn behind the code), or hydra-kaleid, hydra-pulse, hydra-wash or hydra-feed (shader backgrounds). " +
        "It only fills a layer the code leaves empty, and shaders are skipped for viewers who prefer reduced motion. " +
        "Your own visual is the better result (topics 'visuals' and 'hydra').",
    ),
  session: z
    .boolean()
    .optional()
    .describe(
      "Optional: keep this player open as a live session. update-session then swaps new code in on the bar, and " +
        "get-session reports what played and what the user did. For a jam, or a piece you change while it plays. " +
        "Give the user something to play — taps, a fader, a grid (topic 'interactive') — or they answer by editing " +
        "the code and pressing Pass. The log is kept until 2 hours idle.",
    ),
  theme: z
    .enum(EDITOR_THEMES)
    .optional()
    .describe(
      "Editor colour scheme. It also sets the ground the visuals sit on, so pick a dark one when the visual " +
        "is the point (e.g. 'nord', 'sonicPink', 'tokyoNight').",
    ),
});
