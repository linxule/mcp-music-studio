import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  workers: 1,
  // One retry in CI: the audio tests fetch soundfonts over the network, and a
  // slow fetch once failed a publish run (2026-10-04). A retried pass is still
  // reported as "flaky" in the log.
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    browserName: "chromium",
    baseURL: "http://127.0.0.1:5211",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
  },
  webServer: {
    command: "bunx vite --config dev/vite.config.ts --host 127.0.0.1 --port 5211",
    url: "http://127.0.0.1:5211",
    reuseExistingServer: false,
  },
});
