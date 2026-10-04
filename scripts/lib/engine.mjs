// The browser the acceptance checks run in: Chromium by default, WebKit
// (Safari's engine) with BROWSER=webkit. Chromium-only flags are dropped for
// WebKit, which plays audio without a gesture flag in headless mode.
import { chromium, webkit } from "playwright";

export const BROWSER = process.env.BROWSER === "webkit" ? "webkit" : "chromium";

export const engine = {
  launch(options = {}) {
    if (BROWSER === "chromium") return chromium.launch(options);
    const { args: _chromiumFlags, ...rest } = options;
    return webkit.launch(rest);
  },
};
