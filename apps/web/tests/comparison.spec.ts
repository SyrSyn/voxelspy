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
  await expect(
    page.locator(".site-header").getByText("Instant - Local - Open Source"),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "VoxelSpy on GitHub" }),
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
    sample.getByRole("link", { name: "Import Models" }),
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

test("keeps the full comparison legible at desktop splash sizes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const sample = page.locator(".workbench-sample");
  await expect(sample.locator("canvas")).toHaveCount(3, { timeout: 20_000 });

  const difference = await sample.locator(".viewport-difference").boundingBox();
  const rail = await sample.locator(".evidence-rail").boundingBox();
  expect(difference).not.toBeNull();
  expect(rail).not.toBeNull();
  expect(difference!.y + difference!.height).toBeLessThan(660);
  expect(rail!.x).toBeGreaterThanOrEqual(difference!.x + difference!.width - 1);

  for (const kind of ["baseline", "candidate"]) {
    const box = await sample.locator(`.viewport-${kind}`).boundingBox();
    expect(box).not.toBeNull();
    const visibleHeight =
      Math.min(box!.y + box!.height, 900) - Math.max(box!.y, 0);
    expect(visibleHeight).toBeGreaterThan(120);
  }

  const title = await sample
    .getByRole("heading", {
      name: "A 3D Toolkit, Free Forever.",
    })
    .boundingBox();
  const actions = await sample.locator(".workbench-actions").boundingBox();
  expect(title).not.toBeNull();
  expect(actions).not.toBeNull();
  expect(Math.abs(title!.y - actions!.y)).toBeLessThan(40);

  const palette = sample.getByLabel("Model colors");
  await palette.selectOption("blueprint");
  await expect(palette).toHaveValue("blueprint");
  await expect(sample.getByLabel("Difference colors")).toContainText(
    "Added Removed Shared Deviation",
  );

  const theme = page.locator(".theme-button");
  await expect(theme).toHaveAttribute(
    "aria-label",
    "Theme: system. Change to light.",
  );
  await theme.click();
  await expect(theme).toHaveAttribute(
    "aria-label",
    "Theme: light. Change to dark.",
  );
  expect((await theme.textContent())?.trim()).toBe("");

  await page.evaluate(() => window.scrollTo(0, 0));
  await sample.locator(".viewport-difference .canvas-scroll-pad").hover();
  await page.mouse.wheel(0, 500);
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(0);

  await page.setViewportSize({ width: 1440, height: 1440 });
  await page.evaluate(() => window.scrollTo(0, 0));
  const sourceViews = await sample.locator(".source-views").boundingBox();
  expect(sourceViews).not.toBeNull();
  expect(sourceViews!.y + sourceViews!.height).toBeLessThan(1050);
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
  await expect(cards.locator("details")).toHaveCount(2);
  for (const card of [cards.nth(0), cards.nth(1)]) {
    await expect(card.locator("details")).not.toHaveAttribute("open", "");
    await expect(card.locator("summary")).toHaveText("Expert settings");
    await expect(card.getByLabel("Source unit")).toHaveValue("millimetre");
    await expect(card.getByLabel("Source up-axis")).toHaveValue(
      "right-handed-z-up",
    );
  }
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
    page.getByText(
      "Ready for local comparison using millimetres and right-handed Z-up.",
    ),
  ).toHaveCount(2);
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
  const analysisSummary = page
    .locator("details.technical-details > summary")
    .filter({ hasText: /^Analysis details$/u });
  const analysisDetails = analysisSummary.locator("..");
  await expect(analysisDetails).not.toHaveAttribute("open", "");
  await analysisSummary.click();
  await expect(
    page.getByRole("heading", { name: "Analysis interpretation" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Approximation and uncertainty" }),
  ).toBeVisible();
  await expect(page.getByText("omittedRegionCount")).toBeVisible();
  const importSummary = page
    .locator("details.technical-details > summary")
    .filter({ hasText: /^Import and provenance details$/u });
  const importDetails = importSummary.locator("..");
  await expect(importDetails).not.toHaveAttribute("open", "");
  await importSummary.click();
  await expect(
    page.getByRole("heading", { name: "Import interpretation" }),
  ).toBeVisible();
  const baselineEvidence = page
    .getByRole("article")
    .filter({ hasText: "Baseline import" });
  await expect(
    baselineEvidence.getByText("millimetres · default"),
  ).toBeVisible();
  await expect(
    baselineEvidence.getByText("right-handed, Z up · default"),
  ).toBeVisible();
  await expect(baselineEvidence.getByText("No import warnings.")).toBeVisible();
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

  const palette = page.getByLabel("Model colors");
  await expect(palette).toHaveValue("neutral");
  await palette.focus();
  await page.keyboard.press("ArrowDown");
  await expect(palette).toHaveValue("blueprint");

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
  const memory = page.getByRole("slider", {
    name: "Analysis RAM allowance",
  });
  await expect(memory).toHaveValue("256");
  await memory.fill("512");
  await expect(page.locator(".analysis-capacity output")).toHaveText("512 MiB");
  await expect(
    page.getByText("This is a ceiling, not preallocated memory", {
      exact: false,
    }),
  ).toBeVisible();
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});

test("restores ready source-frame defaults when a file is replaced", async ({
  page,
}) => {
  await page.goto("/compare/");
  const cards = page.locator(".source-card");
  const baselineCard = cards.first();
  const candidateCard = cards.nth(1);
  const fileInput = baselineCard.locator('input[type="file"]');
  await fileInput.setInputFiles({
    name: "first.stl",
    mimeType: "model/stl",
    buffer: Buffer.from(baseline),
  });
  await candidateCard.locator('input[type="file"]').setInputFiles({
    name: "candidate.stl",
    mimeType: "model/stl",
    buffer: Buffer.from(candidate),
  });
  const expertSettings = baselineCard.locator("details");
  await expertSettings.locator("summary").click();
  await expect(expertSettings).toHaveAttribute("open", "");
  await baselineCard.getByLabel("Source unit").selectOption("inch");
  await baselineCard
    .getByLabel("Source up-axis")
    .selectOption("right-handed-y-up");
  await expect(
    baselineCard.getByText(
      "Ready for local comparison using the selected expert source frame.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Validate and compare" }),
  ).toBeEnabled();
  await expertSettings.locator("summary").click();
  await expect(expertSettings).not.toHaveAttribute("open", "");

  await fileInput.setInputFiles({
    name: "replacement.stl",
    mimeType: "model/stl",
    buffer: Buffer.from(candidate),
  });

  await expect(baselineCard.getByLabel("Source unit")).toHaveValue(
    "millimetre",
  );
  await expect(baselineCard.getByLabel("Source up-axis")).toHaveValue(
    "right-handed-z-up",
  );
  await expect(expertSettings).not.toHaveAttribute("open", "");
  await expect(
    baselineCard.getByText(
      "Ready for local comparison using millimetres and right-handed Z-up.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Validate and compare" }),
  ).toBeEnabled();
});
