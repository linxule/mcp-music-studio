// =============================================================================
// Browser launchers — the Node-only half of the browser fallback
// =============================================================================
//
// `generatePlayerHtml` / `generateStrudelPlayerHtml` are pure string builders,
// but writing the page to disk and shelling out to `open` needs node:fs,
// node:os, node:path and node:child_process. Those four imports used to live in
// the same modules as the generators, which meant the Cloudflare Worker could
// not reach a generator without dragging the whole Node polyfill set into its
// bundle (+1.1 MB raw / +213 KiB gzip of code that can never run there).
//
// Keeping the launchers here leaves src/browser-fallback.ts and
// src/strudel-browser-fallback.ts genuinely runtime-agnostic, so the Worker's
// /play, /score and /p/<id> routes can render the very same pages the local
// `--render-mode browser` path opens.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { generatePlayerHtml, type BrowserPlayerOptions } from "./browser-fallback.js";
import {
  generateStrudelPlayerHtml,
  type StrudelPlayerOptions,
} from "./strudel-browser-fallback.js";

function defaultOutputDir(): string {
  return path.join(os.homedir(), "Desktop", "mcp-music-studio");
}

/** Open the file in the platform's default browser (best effort, non-fatal). */
function launch(filepath: string): void {
  // Use execFile with an argv array so no shell parses the path.
  const openErr = (err: Error | null) => {
    if (err) console.error("Failed to open browser:", err.message);
  };
  if (process.platform === "darwin") execFile("open", [filepath], openErr);
  else if (process.platform === "win32")
    execFile("cmd", ["/c", "start", "", filepath], openErr);
  else execFile("xdg-open", [filepath], openErr);
}

async function writeAndOpen(
  html: string,
  stem: string,
  outputDir?: string,
): Promise<string> {
  const dir = outputDir ?? defaultOutputDir();
  await fs.mkdir(dir, { recursive: true });

  const filepath = path.join(dir, `${stem}-${randomUUID()}.html`);
  await fs.writeFile(filepath, html, "utf-8");
  launch(filepath);
  return filepath;
}

export async function openPlayerInBrowser(
  options: BrowserPlayerOptions,
  outputDir?: string,
): Promise<string> {
  return writeAndOpen(generatePlayerHtml(options), "player", outputDir);
}

export async function openStrudelInBrowser(
  options: StrudelPlayerOptions,
  outputDir?: string,
): Promise<string> {
  return writeAndOpen(generateStrudelPlayerHtml(options), "strudel", outputDir);
}
