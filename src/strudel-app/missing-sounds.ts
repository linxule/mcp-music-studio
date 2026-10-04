import type { StatusType } from "./state";

interface MissingSoundsHost {
  setStatus(text: string, type?: StatusType): void;
  reportToModel(text: string): void;
}

/** Install lazily at CDN load, reset per evaluation, restore on teardown. */
let setStatus: MissingSoundsHost["setStatus"];
let reportToModel: MissingSoundsHost["reportToModel"];

export function initMissingSounds(host: MissingSoundsHost): void {
  ({
    setStatus, reportToModel,
  } = host);
}

// -----------------------------------------------------------------------------
// Missing sounds
//
// An unknown sound name does NOT fail evaluation — the pattern is valid, and
// superdough only discovers the sample is missing when it tries to trigger it,
// a cycle later. It reports through Strudel's logger, which writes to
// console.LOG (styled with %c), not console.error, so the only way to see it is
// to watch the console. We pass everything through untouched and just pick the
// sound name out.
// -----------------------------------------------------------------------------

const MISSING_SOUND_RE = /sound\s+(\S+?)\s+not found/i;
const missingSounds = new Set<string>();
let missingSoundTimer: ReturnType<typeof setTimeout> | null = null;
let missingSoundReported = false;
let consoleWatchInstalled = false;

function noteMissingSound(name: string): void {
  // say() clips register when they load and report their own failures.
  if (name.startsWith("say_")) return;
  if (missingSoundReported || missingSounds.has(name)) return;
  missingSounds.add(name);
  if (missingSoundTimer !== null) return;
  // Collect for a beat so several missing sounds become ONE report.
  missingSoundTimer = setTimeout(() => {
    missingSoundTimer = null;
    missingSoundReported = true;
    const list = [...missingSounds].join(", ");
    setStatus(`Playing — sound not found: ${list}`, "error");
    reportToModel(
      `Strudel widget: sound not found: ${list}. The pattern is running, but that ` +
        "part is silent — use a sound name from the guide's 'sounds' topic.",
    );
  }, 900);
}

/** Console methods as they were before installConsoleWatch(), for teardown. */
const originalConsole: Partial<Record<"log" | "error", (...args: any[]) => void>> = {};

export function installConsoleWatch(): void {
  if (consoleWatchInstalled) return;
  consoleWatchInstalled = true;
  for (const level of ["log", "error"] as const) {
    const original = console[level].bind(console);
    originalConsole[level] = console[level];
    console[level] = (...args: unknown[]) => {
      try {
        const match = MISSING_SOUND_RE.exec(args.map(String).join(" "));
        if (match) noteMissingSound(match[1]);
      } catch { /* never let the watch break logging */ }
      original(...args);
    };
  }
}

/** Hand the console back untouched when the host discards this widget. */
export function removeConsoleWatch(): void {
  if (!consoleWatchInstalled) return;
  consoleWatchInstalled = false;
  for (const level of ["log", "error"] as const) {
    const original = originalConsole[level];
    if (original) console[level] = original;
    delete originalConsole[level];
  }
}

export function resetMissingSounds(): void {
  missingSounds.clear();
  missingSoundReported = false;
  if (missingSoundTimer !== null) {
    clearTimeout(missingSoundTimer);
    missingSoundTimer = null;
  }
}

export function cancelMissingSoundReport(): void {
  if (missingSoundTimer !== null) {
    clearTimeout(missingSoundTimer);
    missingSoundTimer = null;
  }
}
