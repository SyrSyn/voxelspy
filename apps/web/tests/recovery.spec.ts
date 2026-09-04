import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { isWebGLAvailable } from "./webgl";

/**
 * Recovery and resilience in the real browser: a worker that fails to load,
 * a comparison cancelled mid-flight, repeated runs that must not accumulate
 * canvases or WebGL contexts, a reload mid-comparison, a corrupt import, and
 * a corrupt session -- each proving the app returns to a genuinely usable
 * state afterward rather than hanging or requiring a reload.
 *
 * `comparison.spec.ts`, `session.spec.ts`, `privacy.spec.ts`, and
 * `accessibility.spec.ts` already cover the corresponding happy paths (and,
 * in `accessibility.spec.ts`'s case, one cancellation flow focused on
 * keyboard reachability during the "starting" stage via a delayed worker
 * script). This file is the dedicated pass over failure and recovery.
 */

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

/**
 * Builds a deterministic binary STL grid mesh with `2 * (gridSize - 1) ** 2`
 * triangles -- large enough to keep the real import+analysis worker path
 * busy for a genuine, non-instant interval, unlike the tiny single-triangle
 * fixtures used elsewhere in this suite (which settle before a cancellation
 * click could ever land mid-flight). `bump` elevates a central patch so a
 * bumped candidate is genuinely different from a flat baseline; the exact
 * geometry is not asserted on here, only that the run takes real work and
 * later completes normally.
 */
function buildGridStl(
  gridSize: number,
  extentMm: number,
  bump: boolean,
): Buffer {
  const cells = gridSize - 1;
  const triangleCount = cells * cells * 2;
  const bytes = Buffer.alloc(84 + triangleCount * 50);
  bytes.writeUInt32LE(triangleCount, 80);
  const step = extentMm / cells;
  const z = (i: number, j: number) => {
    if (!bump) return 0;
    const fx = i / cells;
    const fy = j / cells;
    return fx > 0.4 && fx < 0.6 && fy > 0.4 && fy < 0.6 ? 5 : 0;
  };
  const writeFacet = (
    facetIndex: number,
    v0: [number, number, number],
    v1: [number, number, number],
    v2: [number, number, number],
  ) => {
    // Facet layout: 12-byte normal (left zero; the importer discards
    // it -- see stl.ts's parse notes), then three 12-byte vertices, then a
    // 2-byte attribute count (also left zero).
    const base = 84 + facetIndex * 50 + 12;
    for (const [index, vertex] of [v0, v1, v2].entries()) {
      bytes.writeFloatLE(vertex[0], base + index * 12);
      bytes.writeFloatLE(vertex[1], base + index * 12 + 4);
      bytes.writeFloatLE(vertex[2], base + index * 12 + 8);
    }
  };
  let facetIndex = 0;
  for (let i = 0; i < cells; i += 1) {
    for (let j = 0; j < cells; j += 1) {
      const x0 = i * step;
      const x1 = (i + 1) * step;
      const y0 = j * step;
      const y1 = (j + 1) * step;
      const z00 = z(i, j);
      const z10 = z(i + 1, j);
      const z01 = z(i, j + 1);
      const z11 = z(i + 1, j + 1);
      writeFacet(facetIndex, [x0, y0, z00], [x1, y0, z10], [x0, y1, z01]);
      facetIndex += 1;
      writeFacet(facetIndex, [x1, y0, z10], [x1, y1, z11], [x0, y1, z01]);
      facetIndex += 1;
    }
  }
  return bytes;
}

// 2 * 180 * 180 = 64,800 triangles per model. An earlier reproduction found
// 16,200 triangles (~1.8s to reach the workbench on Chromium) enough for a
// cancellation click to land mid-flight there, but cross-engine CI evidence
// showed that margin was Chromium-specific: on WebKit the same fixture's
// pipeline can finish before the click lands, so nothing is left in flight
// to cancel (see the test below, which now also synchronizes on the
// "analysis" stage starting rather than on the Cancel button merely being
// visible). This size trades a still-modest fixture for a wider safety
// margin against engines that run this workload faster than Chromium did in
// that reproduction.
const GRID_SIZE = 181;
const GRID_EXTENT_MM = 1000;

async function attachFixture(
  page: import("@playwright/test").Page,
  files: { baseline: Buffer | string; candidate: Buffer | string },
) {
  const cards = page.locator(".source-card");
  await cards
    .nth(0)
    .locator('input[type="file"]')
    .setInputFiles({
      name: "baseline.stl",
      mimeType: "model/stl",
      buffer: Buffer.isBuffer(files.baseline)
        ? files.baseline
        : Buffer.from(files.baseline),
    });
  await cards
    .nth(1)
    .locator('input[type="file"]')
    .setInputFiles({
      name: "candidate.stl",
      mimeType: "model/stl",
      buffer: Buffer.isBuffer(files.candidate)
        ? files.candidate
        : Buffer.from(files.candidate),
    });
}

test("surfaces a structured failure and recovers when the comparison worker fails to load", async ({
  page,
}) => {
  // Matches the built worker asset's URL pattern (see
  // `dist/assets/comparison.worker-*.js`, loaded via `new URL("./comparison
  // .worker.ts", import.meta.url)` in `worker-client.ts`) without depending
  // on its content hash.
  await page.route("**/comparison.worker*.js", (route) => route.abort());
  await page.goto("/compare/");
  await attachFixture(page, { baseline, candidate });
  await page.getByRole("button", { name: "Validate and compare" }).click();

  // A visible, structured failure surfaces quickly -- the worker's module
  // script never loads, which `worker-client.ts` treats as a genuine
  // protocol failure via `worker.addEventListener("error", ...)` -- well
  // inside the 120s inactivity watchdog, and without ever needing it.
  await expect(page.getByText("Comparison could not continue")).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    page.getByText("Comparison worker stopped unexpectedly."),
  ).toBeVisible();

  // No permanent "Comparing locally…" hang: the primary action returns to
  // its ready label and becomes usable again.
  await expect(
    page.getByRole("button", { name: "Comparing locally…" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Validate and compare" }),
  ).toBeEnabled();

  // Full recovery, not just a re-enabled button: once the worker script can
  // actually load, the very same inputs run a real, successful comparison
  // without a reload.
  await page.unroute("**/comparison.worker*.js");
  await page.getByRole("button", { name: "Validate and compare" }).click();
  await expect(
    page.getByRole("heading", { name: "Comparison workbench" }),
  ).toBeVisible({ timeout: 20_000 });
});

test("cancelling a comparison under real load stops the worker and leaves the page ready for a new one", async ({
  page,
}) => {
  await page.goto("/compare/");
  await attachFixture(page, {
    baseline: buildGridStl(GRID_SIZE, GRID_EXTENT_MM, false),
    candidate: buildGridStl(GRID_SIZE, GRID_EXTENT_MM, true),
  });
  await page.getByRole("button", { name: "Validate and compare" }).click();

  // "Cancel comparison" becomes visible the instant the run starts -- during
  // the pre-work "starting" stage, before either model has even begun
  // importing -- so waiting only for that button (as an earlier version of
  // this test did) does not actually prove genuine in-flight work gets
  // interrupted; it can pass by cancelling before any real work began. This
  // test wants the stronger claim, so it instead waits for the worker's own
  // "analysis" stage progress message -- meaning both imports already
  // finished and the heaviest step (tessellated surface distance over the
  // grid) has just started -- before clicking Cancel. That checkpoint is an
  // application-level signal rather than a wall-clock guess, so it holds
  // regardless of how much faster or slower a given engine's import step
  // runs; the grid is still sized (see `GRID_SIZE` above) to keep the
  // analysis step itself running long enough afterward for the click to
  // land before it finishes.
  const cancelButton = page.getByRole("button", { name: "Cancel comparison" });
  await expect(cancelButton).toBeVisible();
  await expect(page.locator(".comparison-status")).toContainText(
    "Analyzing tessellated surface distance",
    { timeout: 10_000 },
  );
  await cancelButton.click();

  await expect(page.locator(".comparison-status")).toContainText(
    "Comparison cancelled.",
    { timeout: 10_000 },
  );
  await expect(
    page.getByRole("button", { name: "Validate and compare" }),
  ).toBeEnabled();

  // The worker genuinely stopped, not merely "the UI moved on": if the
  // terminated run's result still arrived late, the workbench would appear
  // on its own within the time the full run would have taken. It must not.
  await page.waitForTimeout(2_000);
  await expect(
    page.getByRole("heading", { name: "Comparison workbench" }),
  ).toHaveCount(0);

  // A new comparison -- reusing the same now-idle inputs -- starts
  // immediately and completes normally: cancellation left no broken state.
  await page.getByRole("button", { name: "Validate and compare" }).click();
  await expect(
    page.getByRole("heading", { name: "Comparison workbench" }),
  ).toBeVisible({ timeout: 20_000 });
});

test("three back-to-back comparisons leave no detached canvases and no exhausted WebGL contexts", async ({
  page,
}) => {
  await page.goto("/compare/");
  // A fixed property of this browser install, not of any particular run, so
  // it is read once. Headless Firefox in CI has no WebGL context at all; the
  // app correctly falls back to `.render-fallback` markup there (see
  // `tests/webgl.ts`), so this test's leak evidence shifts from "canvases
  // and WebGL contexts don't accumulate" to "fallback elements don't
  // accumulate" -- still the same DOM-leak property, just observed through
  // whichever element the environment actually renders. Chromium and WebKit
  // are still held strictly to real canvases and healthy contexts.
  const webglAvailable = await isWebGLAvailable(page);
  for (let run = 0; run < 3; run += 1) {
    await attachFixture(page, { baseline, candidate });
    await page.getByRole("button", { name: "Validate and compare" }).click();
    await expect(
      page.getByRole("heading", { name: "Comparison workbench" }),
    ).toBeVisible({ timeout: 20_000 });

    if (webglAvailable) {
      // Exactly three live canvases (difference/baseline/candidate
      // viewports), never more -- `performance.memory`-style heap sampling
      // is not reliable evidence, but a stable DOM canvas count and
      // healthy, non-lost WebGL contexts on every one of them are directly
      // observable and would fail if a prior run's canvases or contexts
      // leaked.
      await expect(page.locator("canvas")).toHaveCount(3);
      const contextsHealthy = await page.evaluate(() =>
        Array.from(document.querySelectorAll("canvas")).every((canvas) => {
          const gl = (canvas.getContext("webgl2") ??
            canvas.getContext("webgl")) as
            WebGLRenderingContext | WebGL2RenderingContext | null;
          return gl !== null && !gl.isContextLost();
        }),
      );
      expect(contextsHealthy).toBe(true);
    } else {
      await expect(page.locator(".render-fallback")).toHaveCount(3);
    }

    if (run < 2) {
      await page.getByRole("button", { name: "New comparison" }).click();
      await expect(
        page.getByRole("heading", { name: "Start with two models" }),
      ).toBeVisible();
      // The previous run's canvases (or fallback elements) are actually
      // removed from the DOM, not just hidden, before the next run creates
      // its own three.
      if (webglAvailable) {
        await expect(page.locator("canvas")).toHaveCount(0);
      } else {
        await expect(page.locator(".render-fallback")).toHaveCount(0);
      }
    }
  }

  if (webglAvailable) {
    // A browser hard-limits the number of live WebGL contexts per page
    // (historically as low as 16 in some engines); a fresh context can
    // still be created after three full run/reset cycles, so the ceiling
    // was not eaten by leaked, undisposed contexts from the prior runs.
    // Meaningless where WebGL is unavailable at all (it would read `false`
    // whether or not anything leaked), so this final check only applies
    // when the environment actually has WebGL to exhaust.
    const freshContextAvailable = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      return gl !== null;
    });
    expect(freshContextAvailable).toBe(true);
  }
});

test("reloading mid-comparison returns to a clean, ready state", async ({
  page,
}) => {
  // Delays the worker script's own network response (the same technique
  // `accessibility.spec.ts` uses for its keyboard-cancellation test) so the
  // run is deterministically still in flight -- regardless of machine
  // speed -- at the moment the page is reloaded, rather than relying on a
  // large fixture and a timing guess.
  await page.route("**/comparison.worker*.js", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await route.continue();
  });
  await page.goto("/compare/");
  await attachFixture(page, { baseline, candidate });
  await page.getByRole("button", { name: "Validate and compare" }).click();
  await expect(
    page.getByRole("button", { name: "Comparing locally…" }),
  ).toBeVisible();

  await page.reload();

  await expect(
    page.getByRole("heading", { name: "Start with two models" }),
  ).toBeVisible();
  // No stuck progress and no error banner survived from the aborted run.
  await expect(page.locator(".comparison-error")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Comparing locally…" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Cancel comparison" }),
  ).toHaveCount(0);

  // Genuinely usable again, not just visually reset: a fresh comparison
  // (worker script no longer delayed) completes normally.
  await page.unroute("**/comparison.worker*.js");
  await attachFixture(page, { baseline, candidate });
  await expect(
    page.getByRole("button", { name: "Validate and compare" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Validate and compare" }).click();
  await expect(
    page.getByRole("heading", { name: "Comparison workbench" }),
  ).toBeVisible({ timeout: 20_000 });
});

test("recovers from a corrupt import to run a successful comparison without reloading", async ({
  page,
}) => {
  await page.goto("/compare/");
  // 200 bytes that are neither a valid ASCII STL nor a structurally valid
  // binary STL: passes the UI's cheap extension/size preflight and fails
  // inside the importer, exercising the real import-failure path (mirrors
  // the fixture `privacy.spec.ts` uses for the same reason).
  const corrupt = Buffer.alloc(200, "x");
  await attachFixture(page, { baseline: corrupt, candidate: corrupt });
  await expect(
    page.getByRole("button", { name: "Validate and compare" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Validate and compare" }).click();
  await expect(page.getByText("Comparison could not continue")).toBeVisible({
    timeout: 20_000,
  });

  // Without reloading, choosing valid files and running again succeeds.
  await attachFixture(page, { baseline, candidate });
  await expect(
    page.getByRole("button", { name: "Validate and compare" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Validate and compare" }).click();
  await expect(
    page.getByRole("heading", { name: "Comparison workbench" }),
  ).toBeVisible({ timeout: 20_000 });
});

test("a valid session still reopens after a prior corrupt-session failure", async ({
  page,
}) => {
  await page.goto("/compare/");
  await attachFixture(page, { baseline, candidate });
  await page.getByRole("button", { name: "Validate and compare" }).click();
  await expect(
    page.getByRole("heading", { name: "Comparison workbench" }),
  ).toBeVisible({ timeout: 20_000 });

  const firstDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save session" }).click();
  const sessionPath = await (await firstDownload).path();
  expect(sessionPath).not.toBeNull();
  const sessionBytes = readFileSync(sessionPath!);

  await page.getByRole("button", { name: "New comparison" }).click();
  await expect(
    page.getByRole("heading", { name: "Start with two models" }),
  ).toBeVisible();

  // A corrupt session must fail closed first...
  await page.locator("#session-open-file").setInputFiles({
    name: "corrupt.voxelspy",
    mimeType: "application/zip",
    buffer: Buffer.from("this is not a valid VoxelSpy session archive"),
  });
  await expect(page.getByText("Session could not be opened")).toBeVisible();

  // ...and then the same valid session must still reopen normally,
  // proving the failed attempt left no poisoned state behind.
  await page.locator("#session-open-file").setInputFiles({
    name: "reopened-session.voxelspy",
    mimeType: "application/zip",
    buffer: sessionBytes,
  });
  await expect(
    page.getByRole("heading", { name: "Comparison workbench" }),
  ).toBeVisible({ timeout: 20_000 });
});
