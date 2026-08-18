import { expect, test, type Page } from "@playwright/test";

/**
 * Browser coverage for Convert (`/tools/convert/`): loads one local model,
 * optionally simplifies it (`simplifyModel`) with a certified, disclaimed
 * measured deviation, then exports (`exportModel`) to STL/OBJ with an
 * explicit unit and axis -- never a print/no-print-style silent default.
 * Complements `tests/accessibility.spec.ts`/`tests/privacy.spec.ts` (which
 * both already include `/tools/convert/` in their route sweeps) and
 * `src/convert-worker-client.test.ts` (which proves the exported bytes
 * re-import to equivalent geometry as a Node-side unit test, more reliably
 * than asserting on a browser download's raw bytes).
 *
 * A 10mm axis-aligned box (12 triangles) is used throughout: large enough
 * that a `triangle-count` target below it is meaningful, and (per
 * `packages/analysis/test/simplify.test.ts`'s own coverage of the identical
 * shape) reliably reaches a mild target while reliably failing to reach an
 * impossible one (a closed 2-manifold mesh cannot go below 4 triangles).
 */

function boxFacets(
  min: [number, number, number],
  max: [number, number, number],
): string {
  const [minX, minY, minZ] = min;
  const [maxX, maxY, maxZ] = max;
  const vertices: Record<number, [number, number, number]> = {
    0: [minX, minY, minZ],
    1: [maxX, minY, minZ],
    2: [maxX, maxY, minZ],
    3: [minX, maxY, minZ],
    4: [minX, minY, maxZ],
    5: [maxX, minY, maxZ],
    6: [maxX, maxY, maxZ],
    7: [minX, maxY, maxZ],
  };
  const faces: [number, number, number][] = [
    [0, 2, 1],
    [0, 3, 2],
    [4, 5, 6],
    [4, 6, 7],
    [0, 1, 5],
    [0, 5, 4],
    [3, 6, 2],
    [3, 7, 6],
    [0, 4, 7],
    [0, 7, 3],
    [1, 2, 6],
    [1, 6, 5],
  ];
  return faces
    .map(([i1, i2, i3]) => {
      const v1 = vertices[i1]!.join(" ");
      const v2 = vertices[i2]!.join(" ");
      const v3 = vertices[i3]!.join(" ");
      return `facet normal 0 0 0\nouter loop\nvertex ${v1}\nvertex ${v2}\nvertex ${v3}\nendloop\nendfacet`;
    })
    .join("\n");
}

const boxStl = `solid convert-box\n${boxFacets([0, 0, 0], [10, 10, 10])}\nendsolid convert-box\n`;

async function chooseFile(page: Page, name: string, contents: string) {
  await page.locator("#model-file").setInputFiles({
    name,
    mimeType: "model/stl",
    buffer: Buffer.from(contents),
  });
}

async function loadModel(page: Page, name: string, contents: string) {
  await chooseFile(page, name, contents);
  const button = page.getByRole("button", { name: "Load model" });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByText(`Loaded ${name}`, { exact: false })).toBeVisible({
    timeout: 20_000,
  });
}

test("Convert appears in the tools catalog as available and links to /tools/convert/", async ({
  page,
}) => {
  await page.goto("/tools/");
  const card = page.locator("a.tool-card-available").filter({
    has: page.getByRole("heading", { level: 2, name: "Convert" }),
  });
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute("href", "/tools/convert/");
  await expect(card).toContainText("Available");

  await card.click();
  await expect(page).toHaveURL(/\/tools\/convert\/$/u);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Simplify and convert a model, with the deviation this introduced",
    }),
  ).toBeVisible();
});

test("loading a model reports its placed triangle and vertex counts", async ({
  page,
}) => {
  await page.goto("/tools/convert/");
  await loadModel(page, "box.stl", boxStl);
  await expect(page.getByText("12 triangles", { exact: false })).toBeVisible();
  // STL carries no shared-vertex index: each of the 12 triangles lists its
  // own 3 unwelded vertices, so the placed count is 36, not the box's 8
  // geometric corners -- the same honest, no-implicit-welding count
  // `simplifyModel`'s own "original" count will report if simplified next.
  await expect(page.getByText("36 vertices", { exact: false })).toBeVisible();
});

test("a mild simplification reports the certified reduction and measured deviation, with the disclaimer visible", async ({
  page,
}) => {
  await page.goto("/tools/convert/");
  await loadModel(page, "box.stl", boxStl);

  await page.locator("#convert-simplify-mode").selectOption("triangle-count");
  await page.locator("#convert-target-triangle-count").fill("10");
  await page.getByRole("button", { name: "Run simplification" }).click();

  const report = page.locator('[aria-labelledby="convert-simplify-title"]');
  await expect(report).toBeVisible({ timeout: 20_000 });

  // The headline claim: reduction percentage together with the measured
  // maximum deviation, never the bare millimetre figure alone.
  await expect(report.locator(".watertight-badge")).toContainText(
    "fewer triangles",
  );
  await expect(report.locator(".watertight-badge")).toContainText(
    "maximum measured deviation",
  );
  await expect(report.locator(".watertight-badge")).toHaveClass(
    /watertight-closed/u,
  );

  // The certification disclaimer is always shown next to that number, never
  // just the bare millimetre figure.
  const disclaimer = report.locator(".convert-disclaimer");
  await expect(disclaimer).toBeVisible();
  await expect(disclaimer).toContainText(
    "This certification is a sampled, approximate measurement",
  );

  await expect(
    report.locator('[role="row"]', { hasText: "Target reached" }),
  ).toContainText("Yes");
  const removedText = (
    await report
      .locator('[role="row"]', { hasText: "Triangles removed" })
      .locator("span")
      .innerText()
  ).trim();
  expect(Number(removedText.replace(/,/gu, ""))).toBeGreaterThan(0);
});

test("an unreachable target reports partial progress honestly, never a hidden or silent failure", async ({
  page,
}) => {
  await page.goto("/tools/convert/");
  await loadModel(page, "box.stl", boxStl);

  await page.locator("#convert-simplify-mode").selectOption("triangle-count");
  // A closed 12-triangle box cannot be decimated below its manifold floor
  // (4 triangles); requesting 1 is unreachable no matter how decimation
  // proceeds -- see packages/analysis/test/simplify.test.ts's own coverage
  // of this exact shape.
  await page.locator("#convert-target-triangle-count").fill("1");
  await page.getByRole("button", { name: "Run simplification" }).click();

  const report = page.locator('[aria-labelledby="convert-simplify-title"]');
  await expect(report).toBeVisible({ timeout: 20_000 });

  await expect(report.locator(".watertight-badge")).toHaveClass(
    /watertight-not-closed/u,
  );
  await expect(report.locator(".watertight-badge")).toContainText(
    "Target not fully reached",
  );
  await expect(
    report.locator('[role="row"]', { hasText: "Target reached" }),
  ).toContainText("No");
  // The achieved count is still reported honestly -- more than the
  // impossible target of 1, never hidden or replaced with an error.
  const simplifiedRow = report.locator('[role="row"]', {
    hasText: "Simplified triangles",
  });
  await expect(simplifiedRow).toBeVisible();
  const achievedText = (await simplifiedRow.locator("span").innerText()).trim();
  expect(Number(achievedText)).toBeGreaterThan(1);

  await expect(report).toContainText("simplify.target-not-reached");
});

test("export always shows the unit-not-declared notice and downloads a named file", async ({
  page,
}) => {
  await page.goto("/tools/convert/");
  await loadModel(page, "box.stl", boxStl);

  await page.locator("#convert-export-format").selectOption("stl-ascii");
  await page.locator("#convert-export-unit").selectOption("inch");
  await page.locator("#convert-export-axis").selectOption("right-handed-y-up");

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export and download" }).click();
  const exported = await download;
  expect(exported.suggestedFilename()).toBe("box.stl");

  const report = page.locator('[aria-labelledby="convert-export-title"]');
  await expect(report).toBeVisible({ timeout: 20_000 });

  const disclaimer = report.locator(".convert-disclaimer");
  await expect(disclaimer).toBeVisible();
  await expect(disclaimer).toContainText(
    "This file cannot record its own unit or axis.",
  );
  await expect(disclaimer).toContainText("inch");
  await expect(disclaimer).toContainText("right-handed-y-up");

  await expect(
    report.locator('[role="row"]', { hasText: "Output unit" }),
  ).toContainText("Inches");
  await expect(
    report.locator('[role="row"]', { hasText: "Output up-axis" }),
  ).toContainText("Right-handed, Y up");
  await expect(
    report.locator('[role="row"]', { hasText: "Source model" }),
  ).toContainText("Original");
});

test("exporting after simplification defaults to the simplified model, but the original stays selectable", async ({
  page,
}) => {
  await page.goto("/tools/convert/");
  await loadModel(page, "box.stl", boxStl);

  await page.locator("#convert-simplify-mode").selectOption("triangle-count");
  await page.locator("#convert-target-triangle-count").fill("10");
  await page.getByRole("button", { name: "Run simplification" }).click();
  await expect(
    page.locator('[aria-labelledby="convert-simplify-title"]'),
  ).toBeVisible({ timeout: 20_000 });

  const exportSourceSelect = page.locator("#convert-export-source");
  await expect(exportSourceSelect).toHaveValue("simplified");

  await page.locator("#convert-export-format").selectOption("obj");
  await page.locator("#convert-export-unit").selectOption("millimetre");
  await page.locator("#convert-export-axis").selectOption("right-handed-z-up");

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export and download" }).click();
  await download;

  const report = page.locator('[aria-labelledby="convert-export-title"]');
  await expect(
    report.locator('[role="row"]', { hasText: "Source model" }),
  ).toContainText("Simplified");

  await exportSourceSelect.selectOption("original");
  const secondDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export and download" }).click();
  const secondExported = await secondDownload;
  expect(secondExported.suggestedFilename()).toBe("box.obj");
  await expect(
    report.locator('[role="row"]', { hasText: "Source model" }),
  ).toContainText("Original");
});
