import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// NOTE: no @cloudflare/vite-plugin here. This config only builds the two
// self-contained ext-apps widget HTML files; the Worker has its own package
// and wrangler config (worker/) and imports the built HTML as text. The plugin
// only ever emitted stray dist/.assetsignore + dist/wrangler.json into the npm
// tarball, and it dragged wrangler (~130MB) into runtime dependencies.

const INPUT = process.env.INPUT;
if (!INPUT) {
  throw new Error("INPUT environment variable is not set");
}

const isDevelopment = process.env.NODE_ENV === "development";

export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    sourcemap: isDevelopment ? "inline" : undefined,
    cssMinify: !isDevelopment,
    minify: !isDevelopment,

    rollupOptions: {
      input: INPUT,
    },
    outDir: "dist",
    emptyOutDir: false,
  },
});