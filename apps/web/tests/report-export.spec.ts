import { readFileSync } from "node:fs";
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

test("exports a self-contained report document from a completed comparison", async ({
  page,
}) => {
  await page.goto("/compare/");
  const cards = page.locator(".source-card");
  await cards
    .nth(0)
    .locator('input[type="file"]')
    .setInputFiles({
      name: "reference-bracket.stl",
      mimeType: "model/stl",
      buffer: Buffer.from(baseline),
    });
  await cards
    .nth(1)
    .locator('input[type="file"]')
    .setInputFiles({
      name: "revised-bracket.stl",
      mimeType: "model/stl",
      buffer: Buffer.from(candidate),
    });
  await page.getByRole("button", { name: "Validate and compare" }).click();
  await expect(
    page.getByRole("heading", { name: "Comparison workbench" }),
  ).toBeVisible({ timeout: 20_000 });

  const exportButton = page.getByRole("button", { name: "Export report" });
  // The export and save actions both depend on the asynchronous geometry
  // summary; Playwright's click() already waits for the button to become
  // enabled, but asserting it explicitly documents that dependency and
  // gives a clearer failure if the summary never settles.
  await expect(exportButton).toBeEnabled({ timeout: 20_000 });

  const download = page.waitForEvent("download");
  await exportButton.click();
  const exported = await download;
  expect(exported.suggestedFilename()).toMatch(/^voxelspy-report-.*\.html$/u);
  const reportPath = await exported.path();
  expect(reportPath).not.toBeNull();
  const html = readFileSync(reportPath!, "utf8");

  // Self-contained: no external resource references of any kind, and no
  // executable script content, even though the fixtures above are benign.
  expect(html).not.toMatch(/https?:\/\//iu);
  expect(html).not.toMatch(/<script/iu);

  // Carries real evidence, not a placeholder: both source filenames, and a
  // non-empty findings/region section.
  expect(html).toContain("reference-bracket.stl");
  expect(html).toContain("revised-bracket.stl");
  expect(html).toMatch(/<h2[^>]*>Findings<\/h2>/u);
  expect(html).toMatch(/class="finding"/u);
  expect(html).toMatch(/<h3>Regions<\/h3>/u);
  expect(html).not.toContain("No findings are recorded.");

  // The workbench stays usable afterward: no crash, and the export can be
  // repeated (each click producing a fresh, still self-contained document).
  await expect(exportButton).toBeEnabled();
  const secondDownload = page.waitForEvent("download");
  await exportButton.click();
  const secondExported = await secondDownload;
  const secondPath = await secondExported.path();
  expect(secondPath).not.toBeNull();
  const secondHtml = readFileSync(secondPath!, "utf8");
  expect(secondHtml).not.toMatch(/https?:\/\//iu);
  expect(secondHtml).not.toMatch(/<script/iu);
});
