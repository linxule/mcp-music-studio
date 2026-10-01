// =============================================================================
// Spoken words as samples — the pure half of say()
//
// The DUET field test (2026-10-01) settled it: browser speechSynthesis is
// accepted but never plays in the Claude mobile app's webview, even after a
// tap, and even where it works it lives outside the audio graph — it can't be
// put on the beat, mixed, ducked or recorded. So say() asks the hosted Worker
// to render the words (GET /tts → Workers AI, cached by content) and registers
// the clip as a sample: speech is then a sound like any other, identical on
// every host, and it shows up in a recording.
//
// Pure: imported by the Worker (route + validation), the widget and share page
// (via stage-runtime), and the validator's stub.
// =============================================================================

/** Workers AI text-to-speech model. English; 40 synthetic voices; MP3 out. */
export const TTS_MODEL = "@cf/deepgram/aura-2-en";

/**
 * The model's voices — synthetic, named after myths, none a real person's.
 * There is no voice cloning and no way to pass anything else.
 */
export const TTS_VOICES = [
  "amalthea", "andromeda", "apollo", "arcas", "aries", "asteria", "athena", "atlas",
  "aurora", "callista", "cora", "cordelia", "delia", "draco", "electra", "harmonia",
  "helena", "hera", "hermes", "hyperion", "iris", "janus", "juno", "jupiter", "luna",
  "mars", "minerva", "neptune", "odysseus", "ophelia", "orion", "orpheus", "pandora",
  "phoebe", "pluto", "saturn", "thalia", "theia", "vesta", "zeus",
] as const;
export type TtsVoice = (typeof TTS_VOICES)[number];
export const DEFAULT_TTS_VOICE: TtsVoice = "luna";

/** Longest line one say() renders. A lyric line, not an audiobook. */
export const TTS_MAX_CHARS = 240;

/** Prefix of every say() sample name — the validator treats these as registered. */
export const TTS_SAMPLE_PREFIX = "say_";

export type TtsRequest = { text: string; voice: TtsVoice };

/** Collapse whitespace and check bounds; a reason when the request can't be rendered. */
export function normalizeTts(text: unknown, voice?: unknown): TtsRequest | { error: string } {
  if (typeof text !== "string") return { error: "say() needs the words as a string" };
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return { error: "say() needs some words to say" };
  if (clean.length > TTS_MAX_CHARS) {
    return {
      error: `say() renders at most ${TTS_MAX_CHARS} characters per line (got ${clean.length}) — split it into lines`,
    };
  }
  const v = voice === undefined || voice === null || voice === "" ? DEFAULT_TTS_VOICE : String(voice).toLowerCase();
  if (!(TTS_VOICES as readonly string[]).includes(v)) {
    return { error: `say() voice "${String(voice)}" is not one of: ${TTS_VOICES.join(", ")}` };
  }
  return { text: clean, voice: v as TtsVoice };
}

/** FNV-1a, 32 bit, as 8 hex digits. Stable across runtimes, no crypto needed. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** The sample name a line registers under: the same words in the same voice share one. */
export function ttsSampleName({ text, voice }: TtsRequest): string {
  return `${TTS_SAMPLE_PREFIX}${fnv1a(`${voice}\u0000${text}`)}`;
}

/** Where the rendered clip lives. */
export function ttsUrl(origin: string, { text, voice }: TtsRequest): string {
  const params = new URLSearchParams({ voice, text });
  return `${origin.replace(/\/+$/, "")}/tts?${params.toString()}`;
}
