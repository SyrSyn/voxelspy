import { expect, test, type Page } from "@playwright/test";

/**
 * Browser coverage for Measure & Section (`/tools/measure-section/`):
 * click-to-measure and cross-section for one loaded model. The fixture is a
 * 10mm axis-aligned box (12 triangles) so every measured distance,
 * perimeter, and area is hand-computable and exact, independent of
 * tessellation.
 */

function boxStl(
  name: string,
  min: [number, number, number],
  max: [number, number, number],
): string {
  const [minX, minY, minZ] = min;
  const [maxX, maxY, maxZ] = max;
  const corners = {
    a: [minX, minY, minZ],
    b: [maxX, minY, minZ],
    c: [maxX, maxY, minZ],
    d: [minX, maxY, minZ],
    e: [minX, minY, maxZ],
    f: [maxX, minY, maxZ],
    g: [maxX, maxY, maxZ],
    h: [minX, maxY, maxZ],
  } as const;
  const faces: [
    keyof typeof corners,
    keyof typeof corners,
    keyof typeof corners,
  ][] = [
    ["a", "b", "c"],
    ["a", "c", "d"],
    ["e", "g", "f"],
    ["e", "h", "g"],
    ["a", "e", "f"],
    ["a", "f", "b"],
    ["b", "f", "g"],
    ["b", "g", "c"],
    ["c", "g", "h"],
    ["c", "h", "d"],
    ["d", "h", "e"],
    ["d", "e", "a"],
  ];
  const facets = faces
    .map(([p1, p2, p3]) => {
      const v1 = corners[p1].join(" ");
      const v2 = corners[p2].join(" ");
      const v3 = corners[p3].join(" ");
      return `facet normal 0 0 0\nouter loop\nvertex ${v1}\nvertex ${v2}\nvertex ${v3}\nendloop\nendfacet`;
    })
    .join("\n");
  return `solid ${name}\n${facets}\nendsolid ${name}\n`;
}

// A 10mm cube at the origin.
const box = boxStl("box", [0, 0, 0], [10, 10, 10]);

async function loadBox(page: Page) {
  await page.goto("/tools/measure-section/");
  await page.locator("#model-file").setInputFiles({
    name: "box.stl",
    mimeType: "model/stl",
    buffer: Buffer.from(box),
  });
  const loadButton = page.getByRole("button", { name: "Load model" });
  await expect(loadButton).toBeEnabled();
  await loadButton.click();
  await expect(
    page.getByRole("heading", { level: 2, name: "box.stl" }),
  ).toBeVisible({ timeout: 20_000 });
}

async function enterManualPoint(page: Page, point: [number, number, number]) {
  await page.locator("#manual-x").fill(String(point[0]));
  await page.locator("#manual-y").fill(String(point[1]));
  await page.locator("#manual-z").fill(String(point[2]));
  await page
    .getByRole("button", { name: "Snap to nearest surface point" })
    .click();
}

test("numeric point entry produces a correct point-to-point distance on a known box", async ({
  page,
}) => {
  await loadBox(page);

  // Two opposite corners of the 10mm cube: the true distance is the space
  // diagonal, sqrt(10^2 + 10^2 + 10^2) ~= 17.32mm, and both points are
  // already exactly on the surface (corner vertices), so each snaps to a
  // vertex with zero displacement.
  await enterManualPoint(page, [0, 0, 0]);
  await expect(page.getByText("Point 1 · Vertex")).toBeVisible();

  await enterManualPoint(page, [10, 10, 10]);
  await expect(page.getByText("Point 2 · Vertex")).toBeVisible();

  const distancePanel = page.locator(
    '[aria-labelledby="measure-pending-title"]',
  );
  await expect(distancePanel).toBeVisible();
  await expect(
    distancePanel.locator('[role="row"]', { hasText: "Distance" }),
  ).toContainText("17.3 mm");
  await expect(
    distancePanel.locator('[role="row"]', { hasText: "Δ" }),
  ).toContainText("10, 10, 10 mm");

  await page.getByRole("button", { name: "Keep measurement" }).click();
  const kept = page.locator('[aria-labelledby="measure-kept-title"]');
  await expect(kept).toContainText("Measurements taken (1)");
  await expect(kept).toContainText("17.3 mm");

  // The active-point panel resets once a measurement is kept.
  await expect(
    page.getByText("No points selected yet.", { exact: false }),
  ).toBeVisible();
});

test("a section plane through a known box yields a closed loop with the expected perimeter and area", async ({
  page,
}) => {
  await loadBox(page);

  // Default normal is Z; a mid-height cut (z=5) through the 10x10x10 cube is
  // a 10mm square: perimeter 40mm, area 100mm^2, and it must close (the box
  // is watertight).
  await page.locator("#plane-offset").fill("5");
  await page.getByRole("button", { name: "Run section" }).click();

  const loops = page.locator('[aria-labelledby="section-loops-title"]');
  await expect(loops).toBeVisible({ timeout: 20_000 });
  await expect(loops).toContainText("Section loops (1)");
  await expect(loops).toContainText("Closed loop");
  await expect(loops).toContainText("perimeter 40 mm");
  await expect(loops).toContainText("100 mm²");
  await expect(loops.locator(".clearance-caveat")).toHaveCount(0);
});

test("a plane missing the model entirely reports an empty section without an error", async ({
  page,
}) => {
  await loadBox(page);

  // z = 1000mm is far above the 10mm-tall box: the plane crosses no
  // triangle, so this must report zero loops, not an error.
  await page.locator("#plane-offset").fill("1000");
  await page.getByRole("button", { name: "Run section" }).click();

  const loops = page.locator('[aria-labelledby="section-loops-title"]');
  await expect(loops).toBeVisible({ timeout: 20_000 });
  await expect(loops).toContainText("Section loops (0)");
  await expect(loops).toContainText(
    "The plane does not cross the model's surface",
  );
  await expect(page.locator(".comparison-error")).toHaveCount(0);
});

test("a plane coincident with a face surfaces the coincident-triangle caveat", async ({
  page,
}) => {
  await loadBox(page);

  // Default offset (0) with the default Z normal lies exactly in the box's
  // bottom face (z=0): both of that face's triangles are coincident with
  // the cutting plane.
  await page.getByRole("button", { name: "Run section" }).click();

  const loops = page.locator('[aria-labelledby="section-loops-title"]');
  await expect(loops).toBeVisible({ timeout: 20_000 });
  const caveat = loops.locator(".clearance-caveat");
  await expect(caveat).toBeVisible();
  await expect(caveat).toContainText("triangle");
  await expect(caveat).toContainText("lie exactly in this plane");
});

test("with WebGL unavailable, measuring and sectioning remain fully usable and the page does not crash", async ({
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

  await loadBox(page);

  await expect(page.locator(".measure-section-viewport canvas")).toHaveCount(0);
  await expect(
    page.locator(".measure-section-viewport .render-fallback"),
  ).toBeVisible();
  await expect(
    page.getByText("3D measurement preview unavailable", { exact: false }),
  ).toBeVisible();

  await enterManualPoint(page, [0, 0, 0]);
  await enterManualPoint(page, [10, 0, 0]);
  const distancePanel = page.locator(
    '[aria-labelledby="measure-pending-title"]',
  );
  await expect(distancePanel).toContainText("10 mm");
  await page.getByRole("button", { name: "Keep measurement" }).click();
  await expect(
    page.locator('[aria-labelledby="measure-kept-title"]'),
  ).toContainText("Measurements taken (1)");

  await page.locator("#plane-offset").fill("5");
  await page.getByRole("button", { name: "Run section" }).click();
  await expect(
    page.locator('[aria-labelledby="section-loops-title"]'),
  ).toContainText("perimeter 40 mm", { timeout: 20_000 });
});

test("Measure & Section appears in the tools catalog as available and links to /tools/measure-section/", async ({
  page,
}) => {
  await page.goto("/tools/");
  const card = page.locator("a.tool-card-available").filter({
    has: page.getByRole("heading", { level: 2, name: "Measure & Section" }),
  });
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute("href", "/tools/measure-section/");
  await expect(card).toContainText("Available");

  await card.click();
  await expect(page).toHaveURL(/\/tools\/measure-section\/$/u);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "How big is this, and what does it look like sliced open?",
    }),
  ).toBeVisible();
});
