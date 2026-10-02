// play-sheet-music's input schema. Kept apart from tool-defs.ts (which
// re-exports it) so the sheet widget's studio tools can use it without
// bundling the Strudel guides and gallery.

import { z } from "zod";
import { DEFAULT_ABC_NOTATION } from "../abc-guide.js";
import { STYLE_NAMES } from "../music-logic.js";
import { MAX_SOURCE_CHARS } from "./input-bounds.js";

export const playSheetInputSchema = z.object({
  abcNotation: z
    .string()
    .max(MAX_SOURCE_CHARS)
    .default(DEFAULT_ABC_NOTATION)
    .describe(
      'ABC notation string. Include chord symbols ("C", "Am7") above notes for auto-accompaniment with style presets.',
    ),
  title: z
    .string()
    .optional()
    .describe(
      "Piece title (overrides T: in ABC). Shown in the widget header and used as " +
        "the filename stem for the WAV/MIDI downloads.",
    ),
  instrument: z
    .string()
    .optional()
    .describe(
      "Default instrument for the main voice — any of the 128 General MIDI names " +
        "(e.g. 'Flute', 'Cello', 'Banjo', 'Alto Sax'). Matching is fuzzy and picks the " +
        "lowest GM program among the hits, so 'sax' gives Soprano Sax; the result text " +
        "names what you actually got whenever it isn't what you asked for. " +
        "Use get-music-guide with topic 'instruments' for the full list, or %%MIDI program N " +
        "in the ABC to set a program per voice.",
    ),
  style: z
    .enum(STYLE_NAMES)
    .optional()
    .describe(
      "Accompaniment style. Adds drums, bass, and chord patterns automatically. " +
        'Your ABC needs chord symbols ("C", "Am") for accompaniment to work. ' +
        "Options: rock, jazz, bossa, waltz, march, reggae, folk, classical.",
    ),
  tempo: z
    .number()
    .min(40)
    .max(240)
    .optional()
    .describe("Tempo in BPM (40-240). Overrides Q: in ABC notation."),
  swing: z
    .number()
    .min(0)
    .max(75)
    .optional()
    .describe(
      "Swing as the share of the beat given to its first half. " +
        "50 = straight, 60 \u2248 3:2, 66 = triplet swing, 75 = maximum " +
        "(dotted eighth + sixteenth). Anything at or below 50 is treated as no swing. " +
        "Only takes effect in an x/4 or x/8 meter.",
    ),
  drumIntro: z
    .number()
    .int()
    .min(0)
    .max(8)
    .optional()
    .describe(
      "Bars of count-in before the melody starts (0-8). " +
        "Needs a style preset \u2014 the count-in is played by that style's drum kit, " +
        "so without a style you get silent bars instead.",
    ),
  transpose: z
    .number()
    .int()
    .min(-12)
    .max(12)
    .optional()
    .describe(
      "Transpose by semitones (-12 to 12). Positive=higher, negative=lower. " +
        "Rewrites the notation and the key signature, so the printed score matches what plays.",
    ),
});
