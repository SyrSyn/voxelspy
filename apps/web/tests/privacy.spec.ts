import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * Comprehensive network audit for VoxelSpy's core promise: comparing two
 * models never sends model data (or anything else) off the page's own
 * origin. This file is the behavioral half of that evidence; the
 * Content-Security-Policy shipped in `public/_headers` (verified by
 * `scripts/verify-static.mjs`) is the structural half. See
 * `tests/README.md` for what each half proves and what it cannot prove.
 *
 * Every test here uses two independent detectors that must both come back
 * empty:
 *
 *  - a Playwright `request` listener, which sees every network request the
 *    browser actually issues, regardless of which API triggered it (fetch,
 *    XHR, `<img>`, CSS, worker scripts, `sendBeacon`, …), and
 *  - an in-page hook installed before any application script runs, which
 *    records every *call* to fetch/XHR/WebSocket/EventSource/sendBeacon/
 *    `serviceWorker.register` whose target resolves off-origin. This layer
 *    exists so the assertion is about "the app never even attempted this",
 *    not only "the browser never sent it" — the two can diverge if a call
 *    fails before dispatch (e.g. a malformed URL) or is blocked by another
 *    layer first.
 */

const ROUTES = [
  "/",
  "/tools/",
  "/compare/",
  "/tools/inspect/",
  "/tools/scale/",
  "/tools/volume/",
  "/tools/watertight/",
  "/tools/file-forensics/",
  "/docs/",
  "/docs/getting-started/",
  "/docs/privacy/",
  "/docs/geometry/",
];

const baseline = `solid baseline
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 10 0 0
vertex 0 10 0
endloop
endfacet
endsolid baseline
`;

const candidate = `solid candidate
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 10 0 0
vertex 0 10 1
endloop
endfacet
endsolid candidate
`;

type OffOriginAttempt = { kind: string; url: string };

/**
 * Installs the in-page attempt recorder. Must run via `addInitScript`
 * *before* the first navigation so it observes the very first script the
 * page executes, and it stays installed across every subsequent
 * same-page navigation for the lifetime of the `page`/context.
 */
async function installAuditHooks(page: Page) {
  await page.addInitScript(() => {
    const globalAny = window as unknown as {
      __privacyAudit: { attempts: OffOriginAttempt[] };
    };
    globalAny.__privacyAudit = { attempts: [] };
    const origin = location.origin;

    const record = (kind: string, rawTarget: unknown) => {
      let resolved: string;
      let offOrigin = true;
      try {
        resolved = new URL(String(rawTarget), location.href).href;
        offOrigin = new URL(resolved).origin !== origin;
      } catch {
        resolved = String(rawTarget);
      }
      if (offOrigin) {
        globalAny.__privacyAudit.attempts.push({ kind, url: resolved });
      }
    };

    const realFetch = window.fetch?.bind(window);
    if (realFetch) {
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        record("fetch", url);
        return realFetch(input, init);
      }) as typeof window.fetch;
    }

    const realOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      record("xhr", url);
      return (
        realOpen as unknown as (
          this: XMLHttpRequest,
          ...args: unknown[]
        ) => void
      ).apply(this, [method, url, ...rest]);
    };

    const RealWebSocket = window.WebSocket;
    if (RealWebSocket) {
      class AuditedWebSocket extends RealWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          record("websocket", url);
          super(url, protocols);
        }
      }
      window.WebSocket = AuditedWebSocket as unknown as typeof WebSocket;
    }

    const RealEventSource = (
      window as unknown as { EventSource?: typeof EventSource }
    ).EventSource;
    if (RealEventSource) {
      class AuditedEventSource extends RealEventSource {
        constructor(url: string | URL, init?: EventSourceInit) {
          record("eventsource", url);
          super(url, init);
        }
      }
      (window as unknown as { EventSource: typeof EventSource }).EventSource =
        AuditedEventSource as unknown as typeof EventSource;
    }

    if (navigator.sendBeacon) {
      const realBeacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = ((url: string | URL, data?: BodyInit) => {
        record("sendBeacon", url);
        return realBeacon(url as string, data);
      }) as typeof navigator.sendBeacon;
    }

    if ("serviceWorker" in navigator && navigator.serviceWorker.register) {
      const realRegister = navigator.serviceWorker.register.bind(
        navigator.serviceWorker,
      );
      navigator.serviceWorker.register = ((
        ...args: Parameters<typeof navigator.serviceWorker.register>
      ) => {
        record("serviceWorker.register", args[0]);
        return realRegister(...args);
      }) as typeof navigator.serviceWorker.register;
    }
  });
}

async function readAuditAttempts(page: Page): Promise<OffOriginAttempt[]> {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __privacyAudit: { attempts: OffOriginAttempt[] };
        }
      ).__privacyAudit.attempts,
  );
}

async function serviceWorkerScopes(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return [];
    const registrations = await navigator.serviceWorker.getRegistrations();
    return registrations.map((registration) => registration.scope);
  });
}

/** Tracks every request's origin for the lifetime of a page. */
function trackRequestOrigins(page: Page): string[] {
  const origins: string[] = [];
  page.on("request", (request) => {
    try {
      origins.push(new URL(request.url()).origin);
    } catch {
      origins.push(request.url());
    }
  });
  return origins;
}

function assertAllSameOrigin(origins: string[], testOrigin: string) {
  const stray = origins.filter((origin) => origin !== testOrigin);
  expect(stray).toEqual([]);
}

test("every static route loads with no off-origin activity and no service worker registered", async ({
  page,
}) => {
  await installAuditHooks(page);
  const origins = trackRequestOrigins(page);

  for (const route of ROUTES) {
    await page.goto(route);
    await expect(page.locator("#main-content")).toBeVisible();
  }

  const testOrigin = new URL(page.url()).origin;
  assertAllSameOrigin(origins, testOrigin);
  expect(await readAuditAttempts(page)).toEqual([]);
  expect(await serviceWorkerScopes(page)).toEqual([]);
});

test("the full import-compare-interact-export-save-reopen workflow never leaves the origin", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await installAuditHooks(page);
  const origins = trackRequestOrigins(page);

  await page.goto("/compare/");
  const testOrigin = new URL(page.url()).origin;

  // --- model import + comparison run ---
  const cards = page.locator(".source-card");
  await cards
    .nth(0)
    .locator('input[type="file"]')
    .setInputFiles({
      name: "baseline.stl",
      mimeType: "model/stl",
      buffer: Buffer.from(baseline),
    });
  await cards
    .nth(1)
    .locator('input[type="file"]')
    .setInputFiles({
      name: "candidate.stl",
      mimeType: "model/stl",
      buffer: Buffer.from(candidate),
    });
  await expect(
    page.getByRole("button", { name: "Validate and compare" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Validate and compare" }).click();
  await expect(
    page.getByRole("heading", { name: "Comparison workbench" }),
  ).toBeVisible({ timeout: 20_000 });
  expect(await page.locator(".findings li").count()).toBeGreaterThan(0);

  // --- idle after a completed comparison: nothing should happen on its own ---
  const requestsBeforeIdle = origins.length;
  // No app signal exists for "nothing will ever happen"; a bounded wait is
  // the only way to give a background poller, telemetry timer, or retry
  // loop a chance to fire before asserting silence.
  await page.waitForTimeout(3_000);
  expect(origins.length).toBe(requestsBeforeIdle);

  // --- workbench interaction: region selection ---
  const firstFinding = page.locator(".findings li button").first();
  await firstFinding.click();
  await expect(firstFinding).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".selected-region")).toBeVisible();

  // --- workbench interaction: cross-section slider ---
  const slider = page.getByRole("slider", { name: /Cross section/ });
  await slider.fill("50");
  await expect(page.locator(".workbench-toolbar output")).toHaveText("50%");

  // --- workbench interaction: theme toggle ---
  await page.setViewportSize({ width: 1440, height: 900 });
  const themeButton = page.locator(".theme-button");
  const before = await themeButton.getAttribute("aria-label");
  await themeButton.click();
  await expect(themeButton).not.toHaveAttribute("aria-label", before ?? "");

  // --- report export ---
  const exportButton = page.getByRole("button", { name: "Export report" });
  await expect(exportButton).toBeEnabled({ timeout: 20_000 });
  const reportDownload = page.waitForEvent("download");
  await exportButton.click();
  const report = await reportDownload;
  expect(report.suggestedFilename()).toMatch(/^voxelspy-report-.*\.html$/u);

  // --- session save ---
  const saveButton = page.getByRole("button", { name: "Save session" });
  await expect(saveButton).toBeEnabled({ timeout: 20_000 });
  const sessionDownload = page.waitForEvent("download");
  await saveButton.click();
  const session = await sessionDownload;
  expect(session.suggestedFilename()).toMatch(
    /^voxelspy-session-.*\.voxelspy$/u,
  );
  const sessionPath = await session.path();
  expect(sessionPath).not.toBeNull();
  const sessionBytes = readFileSync(sessionPath!);

  // --- session reopen ---
  await page.getByRole("button", { name: "New comparison" }).click();
  await expect(
    page.getByRole("heading", { name: "Start with two models" }),
  ).toBeVisible();
  await page.locator("#session-open-file").setInputFiles({
    name: "reopened-session.voxelspy",
    mimeType: "application/zip",
    buffer: sessionBytes,
  });
  await expect(
    page.getByRole("heading", { name: "Comparison workbench" }),
  ).toBeVisible({ timeout: 20_000 });

  assertAllSameOrigin(origins, testOrigin);
  expect(await readAuditAttempts(page)).toEqual([]);
  expect(await serviceWorkerScopes(page)).toEqual([]);
});

test("a deliberately failing import stays local", async ({ page }) => {
  await installAuditHooks(page);
  const origins = trackRequestOrigins(page);

  await page.goto("/compare/");
  const testOrigin = new URL(page.url()).origin;

  // 200 bytes that are neither a valid ASCII STL ("solid ...") nor a
  // structurally valid binary STL (80-byte header + uint32 triangle count
  // whose declared size matches the remaining bytes) — this passes the
  // UI's cheap extension/size preflight and fails inside the importer,
  // exercising the real import-failure path rather than a client-side
  // validation shortcut.
  const corrupt = Buffer.alloc(200, "x");
  const cards = page.locator(".source-card");
  await cards.nth(0).locator('input[type="file"]').setInputFiles({
    name: "corrupt-baseline.stl",
    mimeType: "model/stl",
    buffer: corrupt,
  });
  await cards.nth(1).locator('input[type="file"]').setInputFiles({
    name: "corrupt-candidate.stl",
    mimeType: "model/stl",
    buffer: corrupt,
  });
  await expect(
    page.getByRole("button", { name: "Validate and compare" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Validate and compare" }).click();
  await expect(page.getByText("Comparison could not continue")).toBeVisible({
    timeout: 20_000,
  });

  // The page stays usable after the failure, and still never left the
  // origin while failing.
  await expect(
    page.getByRole("button", { name: "Validate and compare" }),
  ).toBeVisible();
  assertAllSameOrigin(origins, testOrigin);
  expect(await readAuditAttempts(page)).toEqual([]);
});
