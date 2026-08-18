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

// ---------------------------------------------------------------------------
// Focused entry points into Inspect: /tools/scale/, /tools/volume/,
// /tools/watertight/. Same worker-backed inspection and the same report as
// /tools/inspect/, each with its own question-first landing page. See
// apps/web/src/content.ts's `inspectFocusPages` and
// apps/web/src/InspectFlow.tsx's `focus` prop.
// ---------------------------------------------------------------------------

const focusRoutes: {
  path: string;
  h1: string;
  descriptionContains: string;
}[] = [
  {
    path: "/tools/scale/",
    h1: "Is this model in millimetres or inches?",
    descriptionContains: "unit and axis",
  },
  {
    path: "/tools/volume/",
    h1: "What is this model's volume?",
    descriptionContains: "enclosed volume",
  },
  {
    path: "/tools/watertight/",
    h1: "Is this model watertight?",
    descriptionContains: "closed/not-closed verdict",
  },
];

for (const { path, h1, descriptionContains } of focusRoutes) {
  test(`${path} renders its own H1 and metadata, distinct from /tools/inspect/`, async ({
    page,
  }) => {
    await page.goto(path);
    await expect(
      page.getByRole("heading", { level: 1, name: h1 }),
    ).toBeVisible();
    // The <title> and meta description come from this page's own
    // InspectFocusPage entry, not the general Inspect metadata.
    await expect(page).toHaveTitle(`${h1} — VoxelSpy`);
    const description = await page
      .locator('meta[name="description"]')
      .getAttribute("content");
    expect(description).toContain(descriptionContains);
    expect(description).not.toMatch(/full local report/u);

    // Leads with intro copy before the shared report/import form below.
    await expect(page.locator(".inspect-focus-intro")).toBeVisible();
    await expect(
      page.locator(".inspect-focus-intro").getByRole("link", {
        name: "Open the full Inspect report →",
      }),
    ).toHaveAttribute("href", "/tools/inspect/");
  });
}

test("an import on a focus route produces the same full report as /tools/inspect/", async ({
  page,
}) => {
  await page.goto("/tools/volume/");
  await chooseFile(page, "tetrahedron.stl", tetrahedronStl);
  await page.getByRole("button", { name: "Validate and inspect" }).click();

  await expect(
    page.getByRole("heading", { level: 2, name: "tetrahedron.stl" }),
  ).toBeVisible({ timeout: 20_000 });

  // The full report -- not a cut-down volume-only view -- appears below.
  const measurements = page.locator(
    '[aria-labelledby="inspect-measurements-title"]',
  );
  await expect(
    measurements.locator('[role="row"]', { hasText: "Volume" }),
  ).not.toContainText("Not valid");
  await expect(page.locator(".watertight-badge strong")).toHaveText("Closed");
  await expect(
    page.locator('[aria-labelledby="mesh-breakdown-title"]'),
  ).toBeVisible();

  // The H1 stays this page's own question-first title even after the report
  // renders (it does not revert to the general Inspect heading).
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "What is this model's volume?",
    }),
  ).toBeVisible();
});

test("/tools/scale/ opens the expert unit/axis selector by default", async ({
  page,
}) => {
  await page.goto("/tools/scale/");
  // The Expert settings <details> is open without a click, unlike the
  // general Inspect page, so the reinterpretation control is immediately
  // visible.
  await expect(page.getByLabel("Source unit")).toBeVisible();
  await expect(page.getByLabel("Source up-axis")).toBeVisible();
});

test("/tools/inspect/ points to the three focused entry points", async ({
  page,
}) => {
  await page.goto("/tools/inspect/");
  const nav = page.locator(".inspect-entrypoints");
  await expect(nav).toBeVisible();
  await expect(nav.getByRole("link")).toHaveCount(3);
  await expect(
    nav.getByRole("link", { name: "Is this model in millimetres or inches?" }),
  ).toHaveAttribute("href", "/tools/scale/");
  await expect(
    nav.getByRole("link", {
      name: "What is this model's volume, and can it be trusted?",
    }),
  ).toHaveAttribute("href", "/tools/volume/");
  await expect(
    nav.getByRole("link", { name: "Is this model watertight?" }),
  ).toHaveAttribute("href", "/tools/watertight/");
});

test("the tools catalog represents the focus pages as entry points into Inspect, not as separate tool cards", async ({
  page,
}) => {
  await page.goto("/tools/");

  // Exactly two available, real tool cards: Compare and Inspect. The three
  // focus pages must not inflate this count.
  await expect(page.locator("a.tool-card-available")).toHaveCount(2);

  const inspectCard = page
    .locator("a.tool-card-available")
    .filter({ has: page.getByRole("heading", { level: 2, name: "Inspect" }) });
  const entryPoints = page.locator(".tool-entry-points");
  await expect(entryPoints).toHaveCount(1);
  await expect(entryPoints).toContainText("Entry points into Inspect");

  const links = entryPoints.getByRole("link");
  await expect(links).toHaveCount(3);
  await expect(
    links.filter({ hasText: "Is this model in millimetres or inches?" }),
  ).toHaveAttribute("href", "/tools/scale/");
  await expect(
    links.filter({ hasText: "What is this model's volume?" }),
  ).toHaveAttribute("href", "/tools/volume/");
  await expect(
    links.filter({ hasText: "Is this model watertight?" }),
  ).toHaveAttribute("href", "/tools/watertight/");

  // The entry-points list is not itself (or inside) the Inspect card's own
  // link, so nothing is nested inside another link.
  await expect(inspectCard.locator("a")).toHaveCount(0);

  await links.filter({ hasText: "Is this model watertight?" }).click();
  await expect(page).toHaveURL(/\/tools\/watertight\/$/u);
});
