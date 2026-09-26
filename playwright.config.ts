import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
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
