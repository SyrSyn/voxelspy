import { defineConfig, devices } from "@playwright/test";

import base from "./playwright.config";

/**
 * Cross-engine verification. The default configuration runs Chromium
 * projects, which is what a development machine usually has installed; this
 * configuration adds the other engines and is intended for continuous
 * integration, where every engine and its system dependencies are installed
 * deliberately.
 *
 * Run with:
 *   pnpm exec playwright install --with-deps chromium firefox webkit
 *   pnpm exec playwright test --config=playwright.cross-browser.config.ts
 */
export default defineConfig({
  ...base,
  projects: [
    ...(base.projects ?? []),
    { name: "desktop-firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "desktop-webkit", use: { ...devices["Desktop Safari"] } },
    { name: "mobile-webkit", use: { ...devices["iPhone 14"] } },
  ],
});
