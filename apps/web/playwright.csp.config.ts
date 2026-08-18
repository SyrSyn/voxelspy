import { defineConfig, devices } from "@playwright/test";

/**
 * Runs the exact same Playwright suite as `playwright.config.ts`, but
 * against `scripts/csp-preview-server.mjs` instead of `vite preview` --
 * a static server that attaches the real response headers declared in
 * `dist/_headers` (including the Content-Security-Policy) to every
 * request, rather than a policy only inspected as text. A full green run
 * here is evidence that the shipped CSP does not break the real app: every
 * script, worker, stylesheet, and connection the app actually uses loads
 * under enforcement, not just under an unrestricted preview server.
 *
 * This is a one-off verification config, not part of the default
 * `pnpm test:e2e` run: it requires `dist/` to already contain the built,
 * `_headers`-bearing output (`pnpm build`), and it does not exercise
 * things a header-only policy cannot demonstrate client-side, such as
 * `frame-ancestors` (see `scripts/csp-preview-server.mjs` and
 * `tests/README.md` for the full list of limits).
 *
 * Usage: `pnpm build && npx playwright test --config=playwright.csp.config.ts`
 */
export default defineConfig({
  testDir: "tests",
  outputDir: "test-results-csp",
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4174",
    trace: "retain-on-failure",
    reducedMotion: "reduce",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "node scripts/csp-preview-server.mjs 4174",
    port: 4174,
    reuseExistingServer: false,
  },
});
