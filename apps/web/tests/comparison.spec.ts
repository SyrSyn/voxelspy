import { expect, test } from "@playwright/test";

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

test("opens with a working sample difference above its source models", async ({
  page,
}) => {
  const offOrigin: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== "http://127.0.0.1:4173")
      offOrigin.push(request.url());
  });

  await page.goto("/");
  const sample = page.locator(".workbench-sample");
  await expect(
    sample.getByRole("heading", { name: "A 3D Toolkit, Free Forever." }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(sample.getByText("Instant - Local - Open Source")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "VoxelSpy on GitHub, 0 stars" }),
  ).toHaveAttribute("href", "https://github.com/SyrSyn/voxelspy");
  await expect(sample.locator("canvas")).toHaveCount(3);

  const views = sample.locator(".viewport");
  await expect(views).toHaveCount(3);
  await expect(views.nth(0)).toHaveClass(/viewport-difference/);
  await expect(views.nth(1)).toHaveClass(/viewport-baseline/);
  await expect(views.nth(2)).toHaveClass(/viewport-candidate/);
  const boxes = await views.evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom };
    }),
  );
  expect(boxes[1]!.top).toBeGreaterThanOrEqual(boxes[0]!.bottom - 1);
  expect(boxes[2]!.top).toBeGreaterThanOrEqual(boxes[0]!.bottom - 1);

  await expect(
    sample.getByRole("heading", { name: "Changed regions" }),
  ).toBeVisible();
  expect(await sample.locator(".findings li").count()).toBeGreaterThan(0);
  await sample.getByRole("slider", { name: /Cross section/ }).fill("50");
  await expect(sample.locator(".workbench-toolbar output")).toHaveText("50%");
  await expect(
    sample.getByRole("link", { name: "Compare your own models" }),
  ).toBeVisible();
  await expect(page.locator("#main-content h1")).toHaveCount(1);
  expect(offOrigin).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    ),
  ).toBe(false);
});

test("imports, analyzes, and opens synchronized comparison views locally", async ({
  page,
}) => {
  const offOrigin: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== "http://127.0.0.1:4173")
      offOrigin.push(request.url());
  });
  await page.goto("/compare/");
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
  for (const card of [cards.nth(0), cards.nth(1)]) {
    await card.getByLabel("Source unit").selectOption("millimetre");
    await card.getByLabel("Source up-axis").selectOption("right-handed-z-up");
  }
  await expect(
    page.getByRole("button", { name: "Validate and compare" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Validate and compare" }).click();
  await expect(
    page.getByRole("heading", { name: "Comparison workbench" }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".viewport")).toHaveCount(3);
  await expect(
    page.getByRole("heading", { name: "Changed regions" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Analysis interpretation" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Approximation and uncertainty" }),
  ).toBeVisible();
  await expect(page.getByText("omittedRegionCount")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Import interpretation" }),
  ).toBeVisible();
  const baselineEvidence = page
    .getByRole("article")
    .filter({ hasText: "Baseline import" });
  await expect(baselineEvidence.getByText("millimetres · user")).toBeVisible();
  await expect(
    baselineEvidence.getByText("right-handed, Z up · user"),
  ).toBeVisible();
  await expect(
    baselineEvidence.getByText("user-source-frame", { exact: false }),
  ).toBeVisible();
  await expect(
    baselineEvidence.getByText("Facet normals are retained neither", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    baselineEvidence.getByLabel("Baseline source-to-model transform rows"),
  ).toBeVisible();
  await expect(
    page.getByText("Model data remains in this browser."),
  ).toBeVisible();
  expect(offOrigin).toEqual([]);
  await page.screenshot({ path: "test-results/workbench.png", fullPage: true });
});

test("keeps capability guidance usable on a compact viewport", async ({
  page,
}) => {
  await page.goto("/compare/");
  await expect(
    page.getByRole("heading", { name: "Start with two models" }),
  ).toBeVisible();
  await expect(page.getByText("Choose a local STL or OBJ file.")).toHaveCount(
    2,
  );
  await expect(
    page.getByRole("button", { name: "Validate and compare" }),
  ).toBeDisabled();
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});

test("requires a fresh source-frame interpretation when a file is replaced", async ({
  page,
}) => {
  await page.goto("/compare/");
  const baselineCard = page.locator(".source-card").first();
  const fileInput = baselineCard.locator('input[type="file"]');
  await fileInput.setInputFiles({
    name: "first.stl",
    mimeType: "model/stl",
    buffer: Buffer.from(baseline),
  });
  await baselineCard.getByLabel("Source unit").selectOption("millimetre");
  await baselineCard
    .getByLabel("Source up-axis")
    .selectOption("right-handed-z-up");
  await expect(baselineCard.getByText("Supported mesh format")).toBeVisible();

  await fileInput.setInputFiles({
    name: "replacement.stl",
    mimeType: "model/stl",
    buffer: Buffer.from(candidate),
  });

  await expect(baselineCard.getByLabel("Source unit")).toHaveValue("");
  await expect(baselineCard.getByLabel("Source up-axis")).toHaveValue("");
  await expect(
    baselineCard.getByText("Choose the source unit and up-axis", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Validate and compare" }),
  ).toBeDisabled();
});
