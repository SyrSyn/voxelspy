import { defineConfig } from "@playwright/test";
import cross from "./playwright.cross-browser.config";
export default defineConfig({
  testDir: "hosted-tests",
  outputDir: "test-results-embed",
  reporter: "line",
  workers: 2,
  use: {
    baseURL: "http://127.0.0.1:4186",
    trace: "retain-on-failure",
    reducedMotion: "reduce",
  },
  projects: cross.projects,
  webServer: {
    command: "node scripts/embed-preview-server.mjs 4186",
    port: 4186,
    reuseExistingServer: false,
  },
});
