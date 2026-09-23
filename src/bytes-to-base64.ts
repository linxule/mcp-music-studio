/**
 * Base64-encode raw bytes for host-mediated downloads (`app.downloadFile`).
 *
 * Chunked so a multi-megabyte buffer can't blow the argument limit of
 * `String.fromCharCode(...)`.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Hand the event loop a turn (a macrotask), so input and paint can run. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Work this long between yields — under one 60 Hz frame. */
export const YIELD_BUDGET_MS = 12;

/**
 * A `maybeYield()` for long loops: it yields once `budgetMs` of work has passed
 * since the last yield, and is otherwise a no-op. Budgeting by time rather than
 * by item count keeps a fast desktop from yielding needlessly (each yield costs
 * at least a clamped setTimeout) and a slow phone from freezing between yields.
 */
export function timeSlicer(
  budgetMs = YIELD_BUDGET_MS,
  yieldFn: () => Promise<void> = yieldToEventLoop,
  now: () => number = () => performance.now(),
): () => Promise<void> {
  let sliceStart = now();
  return async () => {
    if (now() - sliceStart < budgetMs) return;
    await yieldFn();
    sliceStart = now();
  };
}

/**
 * A multiple of 3, so each slice's base64 has no padding and the slices simply
 * concatenate; and small enough for `String.fromCharCode(...)`'s argument limit
 * (the same order as bytesToBase64's 8192).
 */
const ASYNC_SLICE_BYTES = 3 * 2730;

/**
 * bytesToBase64() for big payloads, without freezing the frame: the work is cut
 * into slices with a `maybeYield()` between them, and each slice goes through
 * btoa() on its own, so no binary string the size of the whole input is ever
 * built. Same output as bytesToBase64().
 */
export async function bytesToBase64Async(
  bytes: Uint8Array,
  maybeYield: () => Promise<void> = timeSlicer(),
): Promise<string> {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += ASYNC_SLICE_BYTES) {
    if (i > 0) await maybeYield();
    parts.push(btoa(String.fromCharCode(...bytes.subarray(i, i + ASYNC_SLICE_BYTES))));
  }
  return parts.join("");
}

/**
 * Turn a tune title into a safe download filename stem.
 * Keeps ASCII word characters and dashes; everything else collapses to "_".
 */
export function sanitizeFileStem(title: string, fallback = "music"): string {
  const cleaned = title
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : fallback;
}
