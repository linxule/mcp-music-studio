// Generates src/version.ts from package.json so the version lives in ONE place.
// Run automatically at the start of `bun run build`.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const body =
  "// AUTO-GENERATED from package.json by scripts/sync-version.mjs — do not edit by hand.\n" +
  `export const VERSION = ${JSON.stringify(pkg.version)};\n`;
writeFileSync(join(root, "src", "version.ts"), body);
console.error(`[sync-version] src/version.ts → ${pkg.version}`);

const registryPath = join(root, "server.json");
const registry = JSON.parse(readFileSync(registryPath, "utf8"));
registry.version = pkg.version;
for (const entry of registry.packages ?? []) entry.version = pkg.version;
writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");

const kimiPluginPath = join(root, "kimi.plugin.json");
const kimiPlugin = JSON.parse(readFileSync(kimiPluginPath, "utf8"));
kimiPlugin.version = pkg.version;
writeFileSync(kimiPluginPath, JSON.stringify(kimiPlugin, null, 2) + "\n");
