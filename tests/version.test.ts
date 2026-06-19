import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { VERSION } from "../src/version";

// Guards the version single-source-of-truth: src/version.ts is generated from
// package.json by scripts/sync-version.mjs at build. A mismatch here means the
// generated file is stale (e.g. a deploy/publish without a prior `bun run build`).
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

describe("version single source of truth", () => {
  it("src/version.ts VERSION matches package.json version", () => {
    expect(VERSION).toBe(pkg.version);
  });
});
