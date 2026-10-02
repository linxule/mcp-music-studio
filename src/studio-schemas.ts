// Both modes' studio schemas, for code that serves either (tests, the dev
// studio). Widgets import only their own (studio-live-schemas / studio-score-schemas).
import { liveStudioSchemas } from "./studio-live-schemas";
import { scoreStudioSchemas } from "./studio-score-schemas";
import type { StudioMode, StudioSchemas } from "./studio-session";

export { liveStudioSchemas, scoreStudioSchemas };
export const studioSchemasFor = (mode: StudioMode): StudioSchemas => (mode === "live" ? liveStudioSchemas : scoreStudioSchemas);
