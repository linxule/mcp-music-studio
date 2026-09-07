// Dev-only Vite config for the local ext-apps host harness (see dev/README.md).
// Not part of the shipped build: the root vite.config.ts builds the widgets.
//
// Run:  bunx vite --config dev/vite.config.ts
//
// The built widgets in dist/ are served RAW under /widgets/ by the middleware
// below (rather than via publicDir) so Vite's index.html transform never touches
// them — the iframe must load exactly the bytes the MCP server ships.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, "../dist");

function serveBuiltWidgets(): Plugin {
  return {
    name: "ms-serve-built-widgets",
    configureServer(server) {
      server.middlewares.use("/widgets", (req, res, next) => {
        const name = (req.url ?? "/").split("?")[0].replace(/^\//, "");
        if (!/^[A-Za-z0-9._-]+\.html$/.test(name)) return next();
        const file = path.join(distDir, name);
        if (!file.startsWith(distDir) || !fs.existsSync(file)) {
          res.statusCode = 404;
          res.end(`Not built: ${name} — run 'bun run build' first.`);
          return;
        }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(fs.readFileSync(file));
      });
    },
  };
}

export default defineConfig({
  root: here,
  publicDir: false,
  plugins: [serveBuiltWidgets()],
  server: {
    port: 5177,
    strictPort: true,
    // Loopback aliases such as lvh.me / 127.0.0.1.nip.io resolve to 127.0.0.1
    // but read as ordinary domains, which some browser-automation extensions
    // require in order to open the page at all.
    allowedHosts: true,
    fs: { allow: [path.resolve(here, "..")] },
  },
});
