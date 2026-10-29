import { defineConfig } from "@playwright/test";
import csp from "./playwright.csp.config";
import crossBrowser from "./playwright.cross-browser.config";

/** Full cross-engine suite against the actual shipped response policies. */
export default defineConfig({
  ...csp,
  outputDir: "test-results-complete",
  projects: crossBrowser.projects,
});
