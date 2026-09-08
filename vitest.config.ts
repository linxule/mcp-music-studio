import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

// The Worker imports the built widgets as text (`wrangler.jsonc` -> rules: Text).
// Vite has its own opinions about .html, so teach the test runner the same rule.
// Falls back to a stub when dist/ hasn't been built, so `bunx vitest run` works
// on a clean checkout; the fingerprint assertions only need SOME stable text.
const HTML_PREFIX = "\0html-as-text:";
const htmlAsText = {
  name: "html-as-text",
  enforce: "pre" as const,
  resolveId(source: string, importer?: string) {
    // Already ours — the virtual id still ends in .html, so bail before
    // prefixing it a second time.
    if (source.startsWith(HTML_PREFIX)) return source;
    if (!source.endsWith(".html")) return null;
    const file =
      importer && source.startsWith(".")
        ? path.resolve(path.dirname(importer), source)
        : source;
    return HTML_PREFIX + file;
  },
  load(id: string) {
    if (!id.startsWith(HTML_PREFIX)) return null;
    const file = id.slice(HTML_PREFIX.length);
    const text = existsSync(file)
      ? readFileSync(file, "utf-8")
      : "<!doctype html><!-- dist not built: vitest html stub -->";
    return `export default ${JSON.stringify(text)};`;
  },
};

export default defineConfig({
  plugins: [htmlAsText],
  resolve: {
    alias: [
      // `agents` lives in worker/package.json only — see tests/stubs/agents-mcp.ts.
      {
        find: /^agents\/mcp$/,
        replacement: path.resolve(root, "tests/stubs/agents-mcp.ts"),
      },
      // @strudel/core (a devDependency, used by tests/guide-executable.test.ts to
      // actually RUN the guide's examples) statically imports @kabelsalat/web,
      // whose package.json is `"type": "module"` with `main` pointing at an IIFE
      // bundle and only `module` pointing at real ESM. Node/vitest follow `main`
      // and blow up with "does not provide an export named 'SalatRepl'".
      // Pin the ESM build. Upstream packaging bug; harmless everywhere else.
      {
        find: /^@kabelsalat\/web$/,
        replacement: path.resolve(
          root,
          "node_modules/@kabelsalat/web/dist/index.mjs",
        ),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    server: {
      // Externalized deps are loaded by Node directly, which bypasses the
      // @kabelsalat/web alias above. Process the Strudel packages through Vite
      // so the alias (and its ESM entry) actually applies.
      deps: { inline: [/@strudel\//, /@kabelsalat\//] },
    },
  },
});
