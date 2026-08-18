import { expect, test, type Page } from "@playwright/test";

/**
 * Browser coverage for Printability (`/tools/printability/`): loads one
 * local model, runs `assessPrintability` in a worker, and reports evidence
 * for wall thickness, overhangs, islands, build-volume fit, and scale --
 * never a print/no-print verdict. Complements
 * `tests/accessibility.spec.ts`/`tests/privacy.spec.ts` (which both already
 * include `/tools/printability/` in their route sweeps).
 *
 * Every fixture below is a hand-verified, outward-consistently-wound box (or
 * a single triangle with a hand-computed normal), so every reported
 * thickness, angle, area, and orientation-fit result is exact and
 * hand-checkable, independent of the engine's own internals.
 */

/** A closed, outward-CCW-wound axis-aligned box: 8 vertices, 12 triangles,
 *  every face's winding hand-verified to produce an outward-pointing normal
 *  (unlike some other fixtures' box helpers in this test suite, which are
 *  fine for distance/section queries that do not depend on winding but are
 *  not suitable for wall-thickness probing, which casts a ray along each
 *  triangle's own *inverted outward* normal). */
function boxStl(
  name: string,
  min: [number, number, number],
  max: [number, number, number],
): string {
  return `solid ${name}\n${boxFacets(min, max)}\nendsolid ${name}\n`;
}

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
    [0, 3, 2], // bottom (z = min), outward -Z
    [4, 5, 6],
    [4, 6, 7], // top (z = max), outward +Z
    [0, 1, 5],
    [0, 5, 4], // front (y = min), outward -Y
    [3, 6, 2],
    [3, 7, 6], // back (y = max), outward +Y
    [0, 4, 7],
    [0, 7, 3], // left (x = min), outward -X
    [1, 2, 6],
    [1, 6, 5], // right (x = max), outward +X
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

// A 20 x 20 x 0.3mm slab: every top/bottom triangle probes to exactly 0.3mm
// thickness (well under the default 0.8mm threshold), and every side
// triangle probes to a much larger, unflagged thickness.
const thinPlateStl = boxStl("thin-plate", [0, 0, 0], [20, 20, 0.3]);

// Two 10mm cubes, 100mm apart on X, combined into one mesh (one STL "solid"
// block, two disjoint vertex sets) -- one importer call, two disconnected
// components.
const twoIslandsStl = `solid two-islands\n${boxFacets(
  [0, 0, 0],
  [10, 10, 10],
)}\n${boxFacets([100, 0, 0], [110, 10, 10])}\nendsolid two-islands\n`;

// A 100 x 20 x 20mm box: too long to fit a 50mm-per-axis build volume in any
// orientation, but fits a 30 x 30 x 110mm build volume only when its
// 100mm-long axis is reoriented onto the build volume's 110mm axis.
const longBoxStl = boxStl("long-box", [0, 0, 0], [100, 20, 20]);

// A single, open (not watertight -- deliberately, since only this section's
// overhang classification is under test) triangle whose outward normal is
// hand-computed to sit at exactly 63.43 degrees from vertical (atan(10/5)),
// via vertex order (0,0,0) -> (0,10,-5) -> (10,0,0): e1 = (0,10,-5),
// e2 = (10,0,0), cross(e1,e2) = (0,-50,-100), i.e. outward normal
// (0, -0.4472, -0.8944). Area = 0.5 * |cross| = 55.9017mm^2.
const overhangTriangleStl = `solid overhang\nfacet normal 0 0 0\nouter loop\nvertex 0 0 0\nvertex 0 10 -5\nvertex 10 0 0\nendloop\nendfacet\nendsolid overhang\n`;

async function chooseFile(page: Page, name: string, contents: string) {
  await page.locator("#model-file").setInputFiles({
    name,
    mimeType: "model/stl",
    buffer: Buffer.from(contents),
  });
}

async function assess(page: Page, sourceName: string) {
  const button = page.getByRole("button", { name: "Assess printability" });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(
    page.getByRole("heading", { level: 2, name: sourceName }),
  ).toBeVisible({ timeout: 20_000 });
}

test("the disclaimer is visible, prominent, and never promises printability", async ({
  page,
}) => {
  await page.goto("/tools/printability/");
  await chooseFile(page, "thin-plate.stl", thinPlateStl);
  await assess(page, "thin-plate.stl");

  const disclaimer = page.locator(".printability-disclaimer");
  await expect(disclaimer).toBeVisible();
  await expect(disclaimer).toContainText(
    "This is evidence, not a printability verdict.",
  );
  await expect(disclaimer).toContainText("not a printability verdict");
  await expect(disclaimer).toContainText(
    "does not certify that this model will print successfully",
  );
  // Not a tooltip: visible without hover/focus, as ordinary page content.
  await expect(disclaimer).toBeVisible();
});

test("a thin plate surfaces a thin-wall finding alongside its sampling caveat", async ({
  page,
}) => {
  await page.goto("/tools/printability/");
  await chooseFile(page, "thin-plate.stl", thinPlateStl);
  await assess(page, "thin-plate.stl");

  const section = page.locator(
    '[aria-labelledby="printability-wall-thickness-title"]',
  );
  await expect(section).toBeVisible();
  await expect(section).toContainText("Approximate");

  // Sampling caveat figures, always shown next to the claim. Anchored at the
  // start of the row's text (rather than a plain substring) so "Sampled
  // triangles" does not also match the "Unsampled triangles" row below --
  // Playwright's `hasText` string form is a case-insensitive substring
  // match, and "Unsampled triangles" contains "sampled triangles".
  await expect(
    section.locator('[role="row"]', { hasText: /^Sampled triangles/u }),
  ).toContainText("12 of 12");
  await expect(
    section.locator('[role="row"]', { hasText: "Unsampled triangles" }),
  ).toContainText("0");
  await expect(
    section.locator('[role="row"]', { hasText: "Sample spacing upper bound" }),
  ).toContainText("mm");
  await expect(
    section.locator('[role="row"]', { hasText: "Missed probes" }),
  ).toContainText("0");

  // The 0.3mm slab thickness is found on (at least) the top/bottom faces.
  const findings = section.locator(".diagnostic-list li");
  await expect(findings.first()).toBeVisible();
  await expect(section).toContainText("0.3 mm");
  await expect(
    section.locator('[role="row"]', { hasText: "Findings detected" }),
  ).not.toContainText("0");
});

test("an overhanging shape reports overhang area at one threshold and not at a stricter one", async ({
  page,
}) => {
  // Default threshold (45deg): the 63.43deg-from-vertical triangle is
  // flagged as one full-area overhang region.
  await page.goto("/tools/printability/");
  await chooseFile(page, "overhang.stl", overhangTriangleStl);
  await assess(page, "overhang.stl");

  const flaggedSection = page.locator(
    '[aria-labelledby="printability-overhangs-title"]',
  );
  await expect(
    flaggedSection.locator('[role="row"]', { hasText: "Regions detected" }),
  ).toContainText("1");
  await expect(
    flaggedSection.locator('[role="row"]', { hasText: "Overhang area" }),
  ).toContainText("100%");
  await expect(flaggedSection.locator(".diagnostic-list li")).toHaveCount(1);

  // Stricter threshold (70deg): the same 63.43deg triangle no longer exceeds
  // it, so nothing is flagged.
  await page.goto("/tools/printability/");
  await chooseFile(page, "overhang.stl", overhangTriangleStl);
  await page.locator("#printability-overhang-threshold").fill("70");
  await assess(page, "overhang.stl");

  const unflaggedSection = page.locator(
    '[aria-labelledby="printability-overhangs-title"]',
  );
  await expect(
    unflaggedSection.locator('[role="row"]', { hasText: "Regions detected" }),
  ).toContainText("0");
  await expect(
    unflaggedSection.locator('[role="row"]', { hasText: "Overhang area" }),
  ).toContainText("0%");
  await expect(unflaggedSection.locator(".empty-findings")).toContainText(
    "No triangle's angle from vertical exceeded the threshold",
  );
});

test("a two-island model lists both islands and warns about multiple shells", async ({
  page,
}) => {
  await page.goto("/tools/printability/");
  await chooseFile(page, "two-islands.stl", twoIslandsStl);
  await assess(page, "two-islands.stl");

  const section = page.locator(
    '[aria-labelledby="printability-islands-title"]',
  );
  await expect(section).toContainText("2 disconnected components detected.");
  const items = section.locator(".diagnostic-list li");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("12 triangles");
  await expect(items.nth(1)).toContainText("12 triangles");
  await expect(section).toContainText("disconnected shells");
});

test("a build volume too small in every orientation reports no fit anywhere", async ({
  page,
}) => {
  await page.goto("/tools/printability/");
  await chooseFile(page, "long-box.stl", longBoxStl);
  await page.getByLabel("Check against a build volume").check();
  await page.locator("#printability-build-volume-x").fill("50");
  await page.locator("#printability-build-volume-y").fill("50");
  await page.locator("#printability-build-volume-z").fill("50");
  await assess(page, "long-box.stl");

  const section = page.locator(
    '[aria-labelledby="printability-build-volume-title"]',
  );
  await expect(section).toContainText(
    "Does not fit in any axis-aligned orientation.",
  );
  // Every orientation row reports "No".
  const rows = section.locator(".geometry-table[role='table'] [role='row']");
  const rowCount = await rows.count();
  for (let index = 1; index < rowCount; index += 1) {
    await expect(rows.nth(index)).toContainText("No");
  }
});

test("a build volume that only fits when reoriented shows the orientation that fits, not just a plain failure", async ({
  page,
}) => {
  await page.goto("/tools/printability/");
  await chooseFile(page, "long-box.stl", longBoxStl);
  await page.getByLabel("Check against a build volume").check();
  // The box is 100 x 20 x 20mm; this build volume is too short on X (30) to
  // fit as given, but its Z axis (110) is long enough for the box's 100mm
  // length once reoriented.
  await page.locator("#printability-build-volume-x").fill("30");
  await page.locator("#printability-build-volume-y").fill("30");
  await page.locator("#printability-build-volume-z").fill("110");
  await assess(page, "long-box.stl");

  const section = page.locator(
    '[aria-labelledby="printability-build-volume-title"]',
  );
  await expect(section).toContainText(
    "Does not fit as given, but fits in another axis-aligned orientation.",
  );
  const rows = section.locator(".geometry-table[role='table'] [role='row']");
  const rowCount = await rows.count();
  let sawFittingOrientation = false;
  for (let index = 1; index < rowCount; index += 1) {
    const text = await rows.nth(index).innerText();
    if (text.includes("Yes")) sawFittingOrientation = true;
  }
  expect(sawFittingOrientation).toBe(true);
});

test("with WebGL unavailable, the disclaimer and every check's evidence remain fully usable", async ({
  page,
}) => {
  await page.addInitScript(() => {
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

  await page.goto("/tools/printability/");
  await chooseFile(page, "thin-plate.stl", thinPlateStl);
  await assess(page, "thin-plate.stl");

  // No WebGL context was ever created, so no canvas exists; the accessible
  // non-canvas fallback takes its place instead.
  await expect(page.locator(".printability-viewport canvas")).toHaveCount(0);
  await expect(
    page.locator(".printability-viewport .render-fallback"),
  ).toBeVisible();

  // Every textual section remains present and usable regardless.
  await expect(page.locator(".printability-disclaimer")).toBeVisible();
  await expect(
    page.locator('[aria-labelledby="printability-wall-thickness-title"]'),
  ).toBeVisible();
  await expect(
    page.locator('[aria-labelledby="printability-overhangs-title"]'),
  ).toBeVisible();
  await expect(
    page.locator('[aria-labelledby="printability-islands-title"]'),
  ).toBeVisible();
  await expect(
    page.locator('[aria-labelledby="printability-build-volume-title"]'),
  ).toBeVisible();
  await expect(
    page.locator('[aria-labelledby="printability-scale-title"]'),
  ).toBeVisible();

  // Selecting a finding from the text list still works without WebGL.
  const findingButton = page
    .locator(
      '[aria-labelledby="printability-wall-thickness-title"] .diagnostic-list li button',
    )
    .first();
  await findingButton.click();
  await expect(findingButton).toHaveAttribute("aria-pressed", "true");

  await expect(
    page.getByRole("button", { name: "Assess another model" }),
  ).toBeEnabled();
});

test("Printability appears in the tools catalog as available and links to /tools/printability/", async ({
  page,
}) => {
  await page.goto("/tools/");
  const card = page.locator("a.tool-card-available").filter({
    has: page.getByRole("heading", { level: 2, name: "Printability" }),
  });
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute("href", "/tools/printability/");
  await expect(card).toContainText("Available");

  await card.click();
  await expect(page).toHaveURL(/\/tools\/printability\/$/u);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "What does this model's surface actually measure like?",
    }),
  ).toBeVisible();
});
