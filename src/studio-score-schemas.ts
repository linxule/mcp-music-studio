// The sheet (ABC) widget's studio schemas, injected into createStudioSession.
import { z } from "zod";
import { playSheetInputSchema } from "./shared/play-sheet-schema";
import type { StudioSchemas } from "./studio-session";

export const studioScoreSettingsSchema = z.object({
  soundFont: z.enum(["default", "musyngkite", "dry"]).optional(),
  room: z.boolean().optional(), instrumentOverride: z.boolean().optional(),
  warp: z.number().min(1).max(1000).optional(), loop: z.boolean().optional(),
}).strict();
export const studioScoreArgsSchema = playSheetInputSchema.extend({
  abcNotation: playSheetInputSchema.shape.abcNotation.removeDefault(),
}).strict();
export const scoreStudioSchemas: StudioSchemas = { args: studioScoreArgsSchema, settings: studioScoreSettingsSchema };
