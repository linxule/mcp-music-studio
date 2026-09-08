// =============================================================================
// Visual presets — a floor under the `visuals` tool parameter.
//
// Free-form visuals stay the primary path: the model is expected to write its
// own `.pianoroll()` / Hydra shader (guide topic "visuals"). This module is the
// fallback for when it doesn't — one enum value turns a bare pattern into a
// pattern that actually paints something.
//
// DOM-free by design (pure string → string) so vitest can exercise it in Node,
// and so the same transform can run server-side if we ever want it to.
// =============================================================================

import { detectViz } from "./viz-detect.js";

/**
 * CodeMirror colour schemes the Strudel REPL ships.
 *
 * Verified against the LIVE @strudel/repl@1.3.0 bundle (`Object.keys(themes)`
 * inside the widget iframe), not against upstream docs — the published list and
 * the bundle disagree (`duotoneLight` is documented but absent). Applying an
 * unknown name is non-fatal upstream (activateTheme() warns and falls back to
 * strudelTheme), but the enum keeps the model from guessing.
 *
 * Light themes are called out because the widget derives its visuals scrim from
 * the theme's `--background`, which activateTheme() writes onto :root.
 */
export const EDITOR_THEMES = [
  "strudelTheme",
  "algoboy",
  "archBtw",
  "androidstudio",
  "atomone",
  "aura",
  "bbedit",
  "blackscreen",
  "bluescreen",
  "bluescreenlight",
  "CutiePi",
  "darcula",
  "dracula",
  "duotoneDark",
  "eclipse",
  "fruitDaw",
  "githubDark",
  "githubLight",
  "greenText",
  "gruvboxDark",
  "gruvboxLight",
  "sonicPink",
  "materialDark",
  "materialLight",
  "monokai",
  "noctisLilac",
  "nord",
  "redText",
  "solarizedDark",
  "solarizedLight",
  "sublime",
  "teletext",
  "tokyoNight",
  "tokyoNightDay",
  "tokyoNightStorm",
  "vscodeDark",
  "vscodeLight",
  "whitescreen",
  "xcodeLight",
] as const;

export type EditorTheme = (typeof EDITOR_THEMES)[number];

/**
 * hydra-synth is loaded by @strudel/hydra from an UNVERSIONED specifier
 * (`https://unpkg.com/hydra-synth`) — i.e. whatever "latest" happens to be the
 * day a user runs a pattern. Pin it here so a preset that works today still
 * works next month. (The widget also wraps initHydra() to pin the same version
 * for free-form shader code the model writes itself.)
 *
 * NOTE THE SINGLE QUOTES at every use site below. Strudel's transpiler rewrites
 * DOUBLE-quoted string literals into mini-notation, so `src: "https://…"` is
 * parsed as a pattern and the whole evaluation dies with
 *
 *     [mini] parse error at line 1: Expected "<", "[", "{", … but "/" found
 *
 * Single-quoted strings pass through untouched — which is also why the guide
 * writes samples('https://…'). Verified in the dev harness: the double-quoted
 * form took down every hydra preset.
 */
export const HYDRA_SYNTH_CDN = "https://unpkg.com/hydra-synth@1.4.0";

export const VISUAL_PRESETS = [
  "none",
  "pianoroll",
  "punchcard",
  "scope",
  "spectrum",
  "hydra-kaleid",
  "hydra-pulse",
  "hydra-wash",
  "hydra-feed",
] as const;

export type VisualPreset = (typeof VISUAL_PRESETS)[number];

/** One-line blurbs, reused in the tool-parameter description. */
export const VISUAL_PRESET_BLURBS: Record<VisualPreset, string> = {
  none: "no visual",
  pianoroll: "scrolling piano roll over every pattern",
  punchcard: "grid of note blocks (good for drums)",
  scope: "oscilloscope waveform",
  spectrum: "frequency-spectrum analyser",
  "hydra-kaleid": "Hydra: rotating kaleidoscope background",
  "hydra-pulse": "Hydra: pulsing shape driven by a rhythm pattern",
  "hydra-wash": "Hydra: slow ambient noise wash",
  "hydra-feed": "Hydra: the piano roll itself, mirrored and trailed",
};

/** Strudel 2D draw methods, keyed by preset. */
const DRAW_CALLS: Partial<Record<VisualPreset, string>> = {
  pianoroll: "all(p => p.pianoroll({ fold: 1 }))",
  punchcard: "all(p => p.punchcard())",
  scope: "all(p => p.scope())",
  spectrum: "all(p => p.spectrum())",
};

/**
 * Hydra halves, copied from the guide's "visuals" topic (src/strudel-guide.ts)
 * so what the preset injects is what the model is told to write — with the
 * hydra-synth version pinned.
 *
 * `hydra-pulse` names its pattern `_vizPulse` rather than the guide's `pulse`:
 * the preset is PREPENDED to code the model wrote without knowing about it, and
 * a bare `pulse` is a plausible name for a user variable to collide with.
 */
const HYDRA_RECIPES: Partial<Record<VisualPreset, string>> = {
  "hydra-kaleid": `await initHydra({ src: '${HYDRA_SYNTH_CDN}' })
osc(8, 0.05, 0.9).rotate(0.3).kaleid(5).color(0.5, 0.35, 1).out(o0)`,

  "hydra-pulse": `await initHydra({ src: '${HYDRA_SYNTH_CDN}' })
const _vizPulse = "1 0 0.6 0 1 0 0.3 0.3"
shape(6, () => 0.15 + 0.35 * H(_vizPulse)(), 0.3)
  .repeat(3, 3)
  .modulateRotate(osc(4, 0.1), 0.4)
  .color(0.2, 0.8, 1)
  .out(o0)`,

  "hydra-wash": `await initHydra({ src: '${HYDRA_SYNTH_CDN}' })
noise(2, 0.08)
  .color(0.15, 0.25, 0.6)
  .modulate(voronoi(3, 0.2), 0.3)
  .blend(o0, 0.9)
  .out(o0)`,

  "hydra-feed": `await initHydra({ feedStrudel: true, src: '${HYDRA_SYNTH_CDN}' })
src(s0)
  .kaleid(4)
  .modulate(noise(3, 0.2), 0.06)
  .colorama(0.01)
  .blend(o0, 0.65)
  .out(o0)`,
};

export function isVisualPreset(value: unknown): value is VisualPreset {
  return typeof value === "string" && (VISUAL_PRESETS as readonly string[]).includes(value);
}

export function isHydraPreset(preset: VisualPreset): boolean {
  return preset.startsWith("hydra-");
}

/**
 * Terminate a statement chunk so whatever is concatenated after it cannot be
 * read as a continuation of it.
 *
 * The trap (audit finding 11): every Hydra recipe ends `.out(o0)` with no `;`,
 * so `${recipe}\n\n(() => note(60))()` transpiles to `.out(o0)(() => …)()` — a
 * call on `.out()`'s return value, with the music never evaluated. ASI does not
 * save it, because `(`, `[`, `` ` `` and the binary operators all continue the
 * expression across a blank line.
 *
 * A trailing `//` on the final line would swallow a `;` appended to it, so in
 * that case the terminator goes on a line of its own.
 */
function terminateStatement(code: string): string {
  const trimmed = code.trimEnd();
  if (trimmed === "" || /[;}]$/.test(trimmed)) return trimmed;
  const lastLine = trimmed.slice(trimmed.lastIndexOf("\n") + 1);
  return lastLine.includes("//") ? `${trimmed}\n;` : `${trimmed};`;
}

export interface ApplyVisualPresetOptions {
  /**
   * false when the viewer asked for reduced motion — Hydra presets are skipped
   * entirely (the code is returned untouched) rather than degraded, because a
   * WebGL shader is exactly the continuous animation that setting is about.
   */
  allowHydra?: boolean;
}

/**
 * Fold a `visuals` preset into pattern code.
 *
 * Never fights code that already visualises: a pattern with its own draw method
 * keeps it, and a pattern that already calls initHydra() keeps its own shader.
 * "none" and an unknown value are both no-ops, so a stale enum value from an
 * older client degrades to plain playback instead of an error.
 */
export function applyVisualPreset(
  code: string,
  preset: unknown,
  opts: ApplyVisualPresetOptions = {},
): string {
  if (!isVisualPreset(preset) || preset === "none") return code;
  const { allowHydra = true } = opts;
  const intent = detectViz(code);

  if (isHydraPreset(preset)) {
    if (!allowHydra) return code;
    // The pattern already drives its own shader — don't stack a second one.
    if (intent.hydra) return code;
    const recipe = HYDRA_RECIPES[preset];
    if (!recipe) return code;
    // feedStrudel textures the STRUDEL DRAW CANVAS. With no draw method there is
    // nothing in s0 to mirror, so give it a piano roll to chew on.
    const needsRoll = preset === "hydra-feed" && !intent.strudelViz;
    // Both joins are terminated: the recipe so the pattern below it is not read
    // as a call on `.out(o0)`, and the pattern so the appended draw call is a
    // statement of its own. See terminateStatement().
    const body = code.trimStart();
    const tail = needsRoll ? `\n\n${DRAW_CALLS.pianoroll}` : "";
    return `${terminateStatement(recipe)}\n\n${
      needsRoll ? terminateStatement(body) : body
    }${tail}`;
  }

  // Strudel draw methods all share the single 2D canvas, so a pattern that
  // already has one keeps it — adding a second makes them fight over clearRect.
  if (intent.strudelViz) return code;
  const call = DRAW_CALLS[preset];
  if (!call) return code;
  return `${terminateStatement(code)}\n\n${call}`;
}
