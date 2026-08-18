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

  // Exactly three available, real tool cards: Compare, Inspect, and File
  // Forensics (see tests/forensics.spec.ts). The three Inspect focus pages
  // must not inflate this count.
  await expect(page.locator("a.tool-card-available")).toHaveCount(3);

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

// ---------------------------------------------------------------------------
// Full diagnostic evidence (`diagnoseMeshHealth`): opt-in, on-demand detail
// beyond the topology findings above, with a 3D view of the selected item.
// See apps/web/src/InspectFlow.tsx's `DiagnosticEvidenceSection` and
// apps/web/src/MeshHealthViewer.tsx.
// ---------------------------------------------------------------------------

/** `count` open, mutually disjoint triangles (spaced far enough apart on X
 * that no vertex coincides across triangles), each an independent connected
 * component with its own 3-edge closed boundary loop -- used to push the
 * boundary-loop count past `diagnoseMeshHealth`'s default 20-loop cap
 * without needing a large or hand-written fixture. */
function manyOpenTrianglesStl(count: number): string {
  const facets = Array.from({ length: count }, (_, index) => {
    const offset = index * 20;
    return `facet normal 0 0 1
outer loop
vertex ${offset} 0 0
vertex ${offset + 10} 0 0
vertex ${offset} 10 0
endloop
endfacet`;
  }).join("\n");
  return `solid many\n${facets}\nendsolid many\n`;
}

test("the full diagnostic evidence panel is opt-in: it is not offered without topology findings, and never runs automatically", async ({
  page,
}) => {
  await page.goto("/tools/inspect/");
  await chooseFile(page, "tetrahedron.stl", tetrahedronStl);
  await page.getByRole("button", { name: "Validate and inspect" }).click();
  await expect(
    page.getByRole("heading", { level: 2, name: "tetrahedron.stl" }),
  ).toBeVisible({ timeout: 20_000 });

  // A clean, closed model has nothing to diagnose, so the panel is absent
  // entirely rather than offered with an empty result.
  await expect(
    page.getByRole("heading", { level: 3, name: "Full diagnostic evidence" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Load full diagnostic evidence" }),
  ).toHaveCount(0);
});

test("opening the full diagnostic evidence loads and renders boundary-loop, edge, and triangle evidence with a 3D view", async ({
  page,
}) => {
  await page.goto("/tools/inspect/");
  await chooseFile(page, "open-triangle.stl", openTriangleStl);
  await page.getByRole("button", { name: "Validate and inspect" }).click();
  await expect(
    page.getByRole("heading", { level: 2, name: "open-triangle.stl" }),
  ).toBeVisible({ timeout: 20_000 });

  // Present but not yet run: the heavier pass is opt-in, not automatic.
  const evidenceHeading = page.getByRole("heading", {
    level: 3,
    name: "Full diagnostic evidence",
  });
  await expect(evidenceHeading).toBeVisible();
  const loadButton = page.getByRole("button", {
    name: "Load full diagnostic evidence",
  });
  await expect(loadButton).toBeVisible();
  await loadButton.click();

  await expect(
    page.getByText("Computing full diagnostic evidence…"),
  ).toBeVisible();

  // The open triangle's 3 boundary edges form exactly one closed loop.
  await expect(
    page.getByRole("heading", { level: 4, name: "Boundary loops (1)" }),
  ).toBeVisible({ timeout: 20_000 });
  const loopButtons = page.locator(
    '[aria-labelledby="diagnostic-boundary-loops-title"] .diagnostic-list li button',
  );
  await expect(loopButtons).toHaveCount(1);
  await expect(loopButtons.first()).toContainText("Loop 1");
  await expect(loopButtons.first()).toContainText("3 edges");
  await expect(loopButtons.first()).toContainText("Closed loop");
  await expect(loopButtons.first()).toContainText("perimeter");

  // The other three evidence categories are correctly empty for one clean
  // open triangle (no non-manifold edges, no inconsistent orientation, no
  // degenerate triangles).
  await expect(
    page.getByRole("heading", { level: 4, name: "Non-manifold edges (0)" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      level: 4,
      name: "Inconsistent-orientation edges (0)",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 4, name: "Degenerate triangles (0)" }),
  ).toBeVisible();

  // The 3D view renders (WebGL is available in this test environment) with
  // an accessible name distinct from the evidence lists it complements.
  const canvas = page.locator(".mesh-health-viewport").getByRole("img");
  await expect(canvas).toHaveCount(1);
  const label = await canvas.getAttribute("aria-label");
  expect(label).toContain("open-triangle.stl");

  // Selecting the loop from the text list marks it selected (aria-pressed),
  // which is also what highlights it in the 3D overlay.
  await loopButtons.first().click();
  await expect(loopButtons.first()).toHaveAttribute("aria-pressed", "true");
  await loopButtons.first().click();
  await expect(loopButtons.first()).toHaveAttribute("aria-pressed", "false");
});

test("truncation notes state the exact counts when the boundary-loop cap is hit", async ({
  page,
}) => {
  await page.goto("/tools/inspect/");
  // 22 disjoint open triangles: 22 boundary loops, one past
  // `diagnoseMeshHealth`'s default 20-loop cap.
  await chooseFile(page, "many-triangles.stl", manyOpenTrianglesStl(22));
  await page.getByRole("button", { name: "Validate and inspect" }).click();
  await expect(
    page.getByRole("heading", { level: 2, name: "many-triangles.stl" }),
  ).toBeVisible({ timeout: 20_000 });

  await page
    .getByRole("button", { name: "Load full diagnostic evidence" })
    .click();
  await expect(
    page.getByRole("heading", { level: 4, name: "Boundary loops (22)" }),
  ).toBeVisible({ timeout: 20_000 });

  const boundarySection = page.locator(
    '[aria-labelledby="diagnostic-boundary-loops-title"]',
  );
  await expect(boundarySection.locator(".diagnostic-list li")).toHaveCount(20);
  await expect(boundarySection.locator(".topology-truncated")).toHaveText(
    "Showing 20 of 22 boundary loops.",
  );
});

test("with WebGL unavailable, the diagnostic evidence lists remain fully usable and the page does not crash", async ({
  page,
}) => {
  await page.addInitScript(() => {
    // Simulates a browser/GPU combination that cannot create a WebGL
    // context, mirroring tests/comparison.spec.ts's own WebGL-unavailable
    // coverage for the workbench.
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      type: string,
      ...args: unknown[]
    ) {
      if (type === "webgl2" || type === "webgl") return null;
      return (original as (...callArgs: unknown[]) => unknown).apply(this, [
        type,
        ...args,
      ]);
    } as typeof HTMLCanvasElement.prototype.getContext;
  });

  await page.goto("/tools/inspect/");
  await chooseFile(page, "open-triangle.stl", openTriangleStl);
  await page.getByRole("button", { name: "Validate and inspect" }).click();
  await expect(
    page.getByRole("heading", { level: 2, name: "open-triangle.stl" }),
  ).toBeVisible({ timeout: 20_000 });

  await page
    .getByRole("button", { name: "Load full diagnostic evidence" })
    .click();
  await expect(
    page.getByRole("heading", { level: 4, name: "Boundary loops (1)" }),
  ).toBeVisible({ timeout: 20_000 });

  // No WebGL context was ever created, so no canvas exists; the accessible
  // non-canvas fallback takes its place instead.
  await expect(page.locator(".mesh-health-viewport canvas")).toHaveCount(0);
  await expect(
    page.locator(".mesh-health-viewport .render-fallback"),
  ).toBeVisible();
  await expect(
    page.getByText("3D diagnostic preview unavailable", { exact: false }),
  ).toBeVisible();

  // The textual evidence -- the accessible equivalent of the 3D view -- is
  // fully present and interactive regardless.
  const loopButtons = page.locator(
    '[aria-labelledby="diagnostic-boundary-loops-title"] .diagnostic-list li button',
  );
  await expect(loopButtons).toHaveCount(1);
  await expect(loopButtons.first()).toContainText("3 edges");
  await loopButtons.first().click();
  await expect(loopButtons.first()).toHaveAttribute("aria-pressed", "true");

  // The rest of the page (including starting a new inspection) still works.
  await expect(
    page.getByRole("button", { name: "Inspect another model" }),
  ).toBeEnabled();
});
