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
