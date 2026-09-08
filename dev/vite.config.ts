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

/**
 * Hostnames the harness may be reached on. All of them resolve to 127.0.0.1;
 * the loopback names cover the normal case and the two wildcard-DNS aliases
 * exist for browser extensions that refuse to attach to a bare `localhost`.
 *
 * Vite matches subdomains of a leading-dot entry, so `.lvh.me` also permits
 * `anything.lvh.me` — still 127.0.0.1 by that provider's wildcard record.
 */
const ALLOWED_DEV_HOSTS = [
  "localhost",
  "127.0.0.1",
  "[::1]",
  "lvh.me",
  ".lvh.me",
  "127.0.0.1.nip.io",
];

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
    // Vite's Host-header check is DNS-rebinding protection: without it, any page
    // the developer visits can point a hostname it controls at 127.0.0.1 and read
    // this origin's responses — which here means the repo tree `fs.allow` opens
    // below. `allowedHosts: true` switched that check OFF entirely, so an
    // arbitrary attacker-controlled Host was accepted.
    //
    // The aliases are named explicitly instead. lvh.me / 127.0.0.1.nip.io resolve
    // to 127.0.0.1 but read as ordinary domains, which some browser-automation
    // extensions require in order to open the page at all. Add a host here rather
    // than reaching for `true`.
    allowedHosts: ALLOWED_DEV_HOSTS,
    fs: { allow: [path.resolve(here, "..")] },
  },
});
