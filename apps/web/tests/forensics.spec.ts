import { expect, test, type Page } from "@playwright/test";

/**
 * Browser coverage for File Forensics (`/tools/file-forensics/`): the file's
 * structural and provenance truth, as distinct from Inspect's geometric
 * measurements (`tests/inspect.spec.ts`). Both tools import through the same
 * `@voxelspy/importers` `importModel`, so these fixtures deliberately reuse
 * the same kind of STL/OBJ content Inspect's own tests use, but assert on
 * Forensics-specific fields: detected format, byte-size-vs-ceiling, content
 * digest, mesh/instance structure, unit/axis provenance with its exact
 * applied transform, and every warning/note the importer recorded.
 */

// A single, clean, closed tetrahedron: 4 triangles, one ASCII STL solid
// block, no merge/degenerate/polygon warnings -- so its only importer note
// is the always-present "facet normals are not retained" one.
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

// Two sequential ASCII STL solid blocks, each one triangle: the importer
// merges every solid block in a file into a single mesh and warns about it
// (`stl-multiple-solids-merged`) whenever more than one block is present.
const multiSolidStl = `solid part1
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 10 0 0
vertex 0 10 0
endloop
endfacet
endsolid part1
solid part2
facet normal 0 0 1
outer loop
vertex 0 0 5
vertex 10 0 5
vertex 0 10 5
endloop
endfacet
endsolid part2
`;

// An OBJ file exercising every directive the importer accepts but does not
// evaluate as geometry (`o`, `g`, `vn`, `vt`, `usemtl`): triggers the
// `obj-data-not-evaluated` warning naming exactly those directives.
const objWithIgnoredDirectives = `o cube
g group1
v 0 0 0
v 10 0 0
v 0 10 0
vn 0 0 1
vt 0 0
usemtl mat1
f 1 2 3
`;

async function chooseFile(page: Page, name: string, contents: string | Buffer) {
  await page.locator("#forensics-model-file").setInputFiles({
    name,
    mimeType: "model/stl",
    buffer: Buffer.isBuffer(contents) ? contents : Buffer.from(contents),
  });
}

test("the importer's own supported-subset panel is visible before any file is chosen, read from the package", async ({
  page,
}) => {
  await page.goto("/tools/file-forensics/");
  const panel = page.locator(".importer-support");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("What this importer supports");
  await expect(panel).toContainText("STL");
  await expect(panel).toContainText("OBJ");
  await expect(panel).toContainText("32.00 MiB");
  await expect(panel).toContainText("500,000 triangles");
  await expect(panel).toContainText("1,500,000 vertices");
  await expect(panel).toContainText("may still be rejected elsewhere");
});

test("a valid STL reports its structure and provenance", async ({ page }) => {
  await page.goto("/tools/file-forensics/");
  await chooseFile(page, "tetrahedron.stl", tetrahedronStl);

  const analyzeButton = page.getByRole("button", {
    name: "Validate and analyze",
  });
  await expect(analyzeButton).toBeEnabled();
  await analyzeButton.click();

  await expect(
    page.getByRole("heading", { level: 2, name: "tetrahedron.stl" }),
  ).toBeVisible({ timeout: 20_000 });

  // File identity: detected format and how, byte size vs. the importer's own
  // ceiling, and a real SHA-256 content digest.
  const identity = page.locator('[aria-labelledby="forensics-identity-title"]');
  await expect(identity).toContainText("STL");
  await expect(identity).toContainText('ends in ".stl"');
  await expect(identity).toContainText("32.00 MiB input-size ceiling");
  const digest = identity.locator("dd").filter({ hasText: /^[a-f0-9]{64}$/u });
  await expect(digest).toHaveCount(1);

  // Mesh & instance structure: one mesh, one instance, 4 triangles, 12
  // (unshared) vertices -- STL never deduplicates vertices.
  const structure = page.locator(
    '[aria-labelledby="forensics-structure-title"]',
  );
  await expect(structure).toContainText("flat");
  await expect(structure).toContainText("1 mesh");
  await expect(structure).toContainText("1 instance");
  const meshRow = structure.locator('[role="row"]', {
    hasText: "mesh.imported",
  });
  await expect(meshRow).toContainText("4");
  await expect(meshRow).toContainText("12");
  await expect(structure).toContainText(
    "4 triangles placed of the importer’s 500,000-triangle ceiling",
  );
  // The one flat instance's exact applied transform is shown too.
  await expect(structure).toContainText("instance.imported");
  await expect(structure).toContainText("meshToModel transform");

  // Unit & axis interpretation: this format never declares either, so
  // detection is "unknown" and resolution falls back to the import default,
  // with the exact identity transform (millimetre, right-handed Z-up).
  const frame = page.locator('[aria-labelledby="forensics-frame-title"]');
  await expect(frame).toContainText("not declared by the file");
  await expect(frame).toContainText("Millimetres (import default)");
  await expect(frame).toContainText("Right-handed, Z up (import default)");
  await expect(frame).toContainText("1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1");

  // What the importer did not accept: no warnings for this clean file, but
  // the always-present STL note (facet normals are not retained) is shown.
  const refusals = page.locator('[aria-labelledby="forensics-refusals-title"]');
  await expect(refusals.getByText("Import warnings")).toHaveCount(0);
  await expect(refusals).toContainText("Importer notes");
  await expect(refusals).toContainText(
    "Facet normals are retained neither as geometry nor as proof of orientation.",
  );
});

test("a multi-solid ASCII STL surfaces the merge warning with its code and count", async ({
  page,
}) => {
  await page.goto("/tools/file-forensics/");
  await chooseFile(page, "multi-solid.stl", multiSolidStl);
  await page.getByRole("button", { name: "Validate and analyze" }).click();

  await expect(
    page.getByRole("heading", { level: 2, name: "multi-solid.stl" }),
  ).toBeVisible({ timeout: 20_000 });

  const structure = page.locator(
    '[aria-labelledby="forensics-structure-title"]',
  );
  await expect(structure).toContainText("1 mesh");
  await expect(structure).toContainText(
    "2 triangles placed of the importer’s 500,000-triangle ceiling",
  );

  const refusals = page.locator('[aria-labelledby="forensics-refusals-title"]');
  await expect(refusals).toContainText("Import warnings");
  await expect(refusals).toContainText("stl-multiple-solids-merged");
  await expect(refusals).toContainText(
    "2 STL solid blocks were merged into a single mesh.",
  );
});

test("an OBJ surfaces its ignored-directive notes and warning", async ({
  page,
}) => {
  await page.goto("/tools/file-forensics/");
  await chooseFile(page, "cube.obj", objWithIgnoredDirectives);
  await page.getByRole("button", { name: "Validate and analyze" }).click();

  await expect(
    page.getByRole("heading", { level: 2, name: "cube.obj" }),
  ).toBeVisible({ timeout: 20_000 });

  const identity = page.locator('[aria-labelledby="forensics-identity-title"]');
  await expect(identity).toContainText("OBJ");
  await expect(identity).toContainText('ends in ".obj"');

  const structure = page.locator(
    '[aria-labelledby="forensics-structure-title"]',
  );
  // OBJ's total-vertices-vs-ceiling line is specific to this format.
  await expect(structure).toContainText(
    "3 vertices parsed of the importer’s 1,500,000-vertex ceiling for OBJ.",
  );

  const refusals = page.locator('[aria-labelledby="forensics-refusals-title"]');
  await expect(refusals).toContainText("obj-data-not-evaluated");
  await expect(refusals).toContainText(
    "Non-geometric OBJ records were not evaluated.",
  );
  // The exact ignored directives, alphabetically sorted by the importer.
  await expect(refusals).toContainText("g, o, usemtl, vn, vt");
  await expect(refusals).toContainText("Importer notes");
  await expect(refusals).toContainText(
    "OBJ materials, normals, texture coordinates, and smoothing are not geometry inputs.",
  );
});

test("a corrupt file fails visibly with the importer's own reason and the tool stays usable", async ({
  page,
}) => {
  await page.goto("/tools/file-forensics/");
  // 200 bytes that are neither a valid ASCII STL ("solid ...") nor a
  // structurally valid binary STL -- the same corrupt fixture pattern used
  // in tests/inspect.spec.ts and tests/privacy.spec.ts, exercising the real
  // import-failure path rather than a client-side validation shortcut.
  const corrupt = Buffer.alloc(200, "x");
  await chooseFile(page, "corrupt.stl", corrupt);
  await page.getByRole("button", { name: "Validate and analyze" }).click();

  await expect(page.getByText("Analysis could not continue")).toBeVisible({
    timeout: 20_000,
  });

  // The page stays usable: the form is still present, the importer-support
  // panel is unaffected, and a valid file can be analyzed right after.
  await expect(page.locator(".importer-support")).toBeVisible();
  const analyzeButton = page.getByRole("button", {
    name: "Validate and analyze",
  });
  await expect(analyzeButton).toBeVisible();
  await chooseFile(page, "tetrahedron.stl", tetrahedronStl);
  await expect(analyzeButton).toBeEnabled();
  await analyzeButton.click();
  await expect(
    page.getByRole("heading", { level: 2, name: "tetrahedron.stl" }),
  ).toBeVisible({ timeout: 20_000 });
});

test("File Forensics appears in the tools catalog as available and links to /tools/file-forensics/", async ({
  page,
}) => {
  await page.goto("/tools/");
  const card = page.locator("a.tool-card-available").filter({
    has: page.getByRole("heading", { level: 2, name: "File Forensics" }),
  });
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute("href", "/tools/file-forensics/");
  await expect(card).toContainText("Available");

  await card.click();
  await expect(page).toHaveURL(/\/tools\/file-forensics\/$/u);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "What is actually inside this file?",
    }),
  ).toBeVisible();
});
