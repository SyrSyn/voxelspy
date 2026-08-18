import { expect, test, type Page } from "@playwright/test";

/**
 * Browser coverage for the Inspect tool (`/tools/inspect/`): the second real
 * tool in the toolbox, and the first that is not a comparison. Complements
 * `tests/comparison.spec.ts` (baseline/candidate flow) and
 * `tests/accessibility.spec.ts`/`tests/privacy.spec.ts` (which both already
 * include `/tools/inspect/` in their route sweeps).
 */

// A fully closed, consistently-oriented tetrahedron (outward CCW winding on
// every face -- see apps/web/src/InspectFlow.tsx's watertightness handoff
// notes): 4 triangles, 6 edges each shared by exactly two triangle corners
// in opposite winding directions, so the report should read "Closed" with
// no topology findings.
const tetrahedronStl = `solid tetra
facet normal 0 0 -1
outer loop
vertex 0 0 0
vertex 0 10 0
vertex 10 0 0
endloop
endfacet
facet normal 0 -1 0
outer loop
vertex 0 0 0
vertex 10 0 0
vertex 0 0 10
endloop
endfacet
facet normal -1 0 0
outer loop
vertex 0 0 0
vertex 0 0 10
vertex 0 10 0
endloop
endfacet
facet normal 1 1 1
outer loop
vertex 10 0 0
vertex 0 10 0
vertex 0 0 10
endloop
endfacet
endsolid tetra
`;

// A single triangle: an intentionally open surface. Every one of its three
// edges is touched by exactly one triangle, so this should report 3
// boundary edges (info severity) and a "not closed" verdict.
const openTriangleStl = `solid open
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 10 0 0
vertex 0 10 0
endloop
endfacet
endsolid open
`;

async function chooseFile(page: Page, name: string, contents: string | Buffer) {
  await page.locator("#model-file").setInputFiles({
    name,
    mimeType: "model/stl",
    buffer: Buffer.isBuffer(contents) ? contents : Buffer.from(contents),
  });
}

test("inspecting a valid closed model renders a complete, correct-looking report", async ({
  page,
}) => {
  await page.goto("/tools/inspect/");
  await chooseFile(page, "tetrahedron.stl", tetrahedronStl);

  const inspectButton = page.getByRole("button", {
    name: "Validate and inspect",
  });
  await expect(inspectButton).toBeEnabled();
  await inspectButton.click();

  await expect(
    page.getByRole("heading", { level: 2, name: "tetrahedron.stl" }),
  ).toBeVisible({ timeout: 20_000 });

  const measurements = page.locator(
    '[aria-labelledby="inspect-measurements-title"]',
  );
  await expect(
    measurements.locator('[role="row"]', { hasText: "Dimensions (mm)" }),
  ).toContainText("10 × 10 × 10");
  await expect(
    measurements.locator('[role="row"]', { hasText: "Triangles (placed)" }),
  ).toContainText("4");
  await expect(
    measurements.locator('[role="row"]', { hasText: "Meshes" }),
  ).toContainText("1");
  await expect(
    measurements.locator('[role="row"]', { hasText: "Connected components" }),
  ).toContainText("1");
  // Volume must be reported (not withheld) for a genuinely closed solid.
  await expect(
    measurements.locator('[role="row"]', { hasText: "Volume" }),
  ).not.toContainText("Not valid");

  // Watertightness: conveyed by visible text, not color alone.
  await expect(page.locator(".watertight-badge strong")).toHaveText("Closed");

  // No topology issues for a clean, closed tetrahedron.
  await expect(page.locator(".empty-findings")).toBeVisible();
  await expect(page.locator(".topology-item")).toHaveCount(0);

  // Mesh breakdown lists the one imported mesh.
  const meshBreakdown = page.locator(
    '[aria-labelledby="mesh-breakdown-title"]',
  );
  await expect(meshBreakdown.locator('[role="row"]')).toHaveCount(2); // header + 1 mesh

  // Provenance panel: format, importer, and resolved unit/axis are present.
  await page.getByText("Provenance & interpretation").click();
  const provenance = page.locator(".technical-details");
  await expect(provenance).toContainText("stl");
  await expect(provenance).toContainText("Millimetres");
  await expect(provenance).toContainText("Right-handed, Z up");
});

test("inspecting an open surface reports not-closed with its reason", async ({
  page,
}) => {
  await page.goto("/tools/inspect/");
  await chooseFile(page, "open-triangle.stl", openTriangleStl);
  await page.getByRole("button", { name: "Validate and inspect" }).click();

  await expect(
    page.getByRole("heading", { level: 2, name: "open-triangle.stl" }),
  ).toBeVisible({ timeout: 20_000 });

  await expect(page.locator(".watertight-badge strong")).toHaveText(
    "Not closed",
  );
  await expect(page.locator(".watertight-badge span")).toContainText(
    "boundary edges",
  );

  const findings = page.locator(".topology-item");
  await expect(findings).toHaveCount(1);
  await expect(findings.first()).toContainText("Boundary edges");
  await expect(findings.first()).toContainText("Info");
  await expect(findings.first()).toContainText("3");

  // Volume must be withheld, with the reason stated plainly.
  const measurements = page.locator(
    '[aria-labelledby="inspect-measurements-title"]',
  );
  await expect(
    measurements.locator('[role="row"]', { hasText: "Volume" }),
  ).toContainText("Not valid");
  await expect(measurements).toContainText("Volume withheld");
  await expect(measurements).toContainText("open boundary edges");
});

test("a corrupt file fails visibly and the tool stays usable", async ({
  page,
}) => {
  await page.goto("/tools/inspect/");
  // 200 bytes that are neither a valid ASCII STL ("solid ...") nor a
  // structurally valid binary STL -- mirrors the corrupt fixture in
  // tests/privacy.spec.ts, exercising the real import-failure path.
  const corrupt = Buffer.alloc(200, "x");
  await chooseFile(page, "corrupt.stl", corrupt);
  await page.getByRole("button", { name: "Validate and inspect" }).click();

  await expect(page.getByText("Inspection could not continue")).toBeVisible({
    timeout: 20_000,
  });

  // The page stays usable: the form is still present, and a valid file can
  // be inspected right after the failure.
  const inspectButton = page.getByRole("button", {
    name: "Validate and inspect",
  });
  await expect(inspectButton).toBeVisible();
  await chooseFile(page, "open-triangle.stl", openTriangleStl);
  await expect(inspectButton).toBeEnabled();
  await inspectButton.click();
  await expect(
    page.getByRole("heading", { level: 2, name: "open-triangle.stl" }),
  ).toBeVisible({ timeout: 20_000 });
});

test("Inspect appears in the tools catalog as available and links to /tools/inspect/", async ({
  page,
}) => {
  await page.goto("/tools/");
  const card = page
    .locator("a.tool-card-available")
    .filter({ has: page.getByRole("heading", { level: 2, name: "Inspect" }) });
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute("href", "/tools/inspect/");
  await expect(card).toContainText("Available");

  await card.click();
  await expect(page).toHaveURL(/\/tools\/inspect\/$/u);
  await expect(
    page.getByRole("heading", { level: 1, name: "Look inside one model" }),
  ).toBeVisible();
});
