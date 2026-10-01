// Entry for the share page's copy of the stage runtime: scripts/build-stage-runtime.mjs
// bundles this into src/generated/stage-runtime-js.ts, which the standalone
// page inlines. One source for the widget and the page; no hand-kept copy.
import { createBrowserStageEnv, createStage } from "./stage-runtime.js";
import { installSampleUrlFix } from "./sample-url-fix.js";

(globalThis as any).MusicStudioStage = { createStage, createBrowserStageEnv };
// The share page gets the VCSL comma-path fix from the same bundle.
installSampleUrlFix(globalThis as any);
