import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { encoding: "utf8" }));
const files = new Set(pack.files.map(({ path }) => path));
for (const path of ["LICENSE", "LICENSES/MIT.txt", "SOURCE.md", "THIRD_PARTY_NOTICES.md",
  "dist/THIRD_PARTY_LICENSES.txt", "src/mcp-app.ts", "src/strudel-app.ts", "src/source-info.ts",
  "src/shared/strudel-validate-child.ts", "server.ts", "main.ts", "mcp-app.html", "strudel-app.html",
  "privacy.html", "scripts/sync-version.mjs", "scripts/collect-licenses.mjs", "tsconfig.json",
  "tsconfig.server.json", "vite.config.ts", "bun.lock", "worker/src/index.ts",
  "worker/bun.lock", "worker/wrangler.jsonc", "server.json", "kimi.plugin.json"])
  assert(files.has(path), `Published package is missing ${path}`);
assert.equal(JSON.parse(readFileSync("package.json", "utf8")).license, "AGPL-3.0-or-later");
assert.equal(JSON.parse(readFileSync("kimi.plugin.json", "utf8")).license, "AGPL-3.0-or-later");
assert.match(readFileSync("LICENSE", "utf8"), /GNU AFFERO GENERAL PUBLIC LICENSE/);
assert.match(readFileSync("LICENSES/MIT.txt", "utf8"), /Copyright \(c\) 2025 Anthropic, PBC/);
for (const path of files) assert(!/(^|\/)(\.env(?:\.|$)|\.dev\.vars|node_modules\/|CLAUDE\.md)/.test(path), `Unexpected private input: ${path}`);
console.log(`Package source and license gate passed (${files.size} files, ${pack.size} packed bytes)`);
