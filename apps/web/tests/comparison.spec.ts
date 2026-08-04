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
