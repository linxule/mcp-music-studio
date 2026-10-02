// The live (Strudel) widget's studio schemas, injected into createStudioSession.
import { z } from "zod";
import { playLiveInputSchema } from "./shared/play-live-schema";
import type { StudioSchemas } from "./studio-session";

export const studioLiveSettingsSchema = z.object({}).strict();
export const studioPatternArgsSchema = playLiveInputSchema.omit({ autoplay: true }).strict();
export const liveStudioSchemas: StudioSchemas = { args: studioPatternArgsSchema, settings: studioLiveSettingsSchema };
