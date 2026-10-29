import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
const facet = (points: number[][]) =>
  `facet normal 0 0 0\nouter loop\n${points.map((p) => `vertex ${p.join(" ")}`).join("\n")}\nendloop\nendfacet`;
const model = (facets: string[]) =>
  `solid diagnostic\n${facets.join("\n")}\nendsolid diagnostic\n`;
const crossing = model([
  facet([
    [0, 0, 0],
    [4, 0, 0],
    [0, 4, 0],
  ]),
  facet([
    [1, 1, -1],
    [1, 1, 1],
    [3, 1, 0],
  ]),
]);
test("Mesh Health runs explicit intersection evidence and downloads the exact result", async ({
  page,
}) => {
  await page.goto("/tools/");
  await page
    .getByRole("link")
    .filter({
      has: page.getByRole("heading", { name: "Mesh Health", exact: true }),
    })
    .click();
  await page.locator("#model-file").setInputFiles({
    name: "crossing.stl",
    mimeType: "model/stl",
    buffer: Buffer.from(crossing),
  });
  await page.getByRole("button", { name: "Validate and inspect" }).click();
  const panel = page.locator('[aria-labelledby="self-intersection-heading"]');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await panel.getByRole("button", { name: "Check self-intersections" }).click();
  await expect(panel).toContainText(
    "1 intersecting or contacting triangle pairs observed",
    { timeout: 20_000 },
  );
  const download = page.waitForEvent("download");
  await panel
    .getByRole("button", { name: "Download mesh health evidence" })
    .click();
  const artifact = await download;
  const report = JSON.parse(await readFile((await artifact.path())!, "utf8"));
  expect(report.schemaVersion).toBe(1);
  expect(report.kind).toBe("mesh-health");
  expect(report.provenance.sourceName).toBe("crossing.stl");
  expect(report.evidence.pairCount).toBe(1);
  expect(report.evidence.pairs[0].first.meshLocalTriangleIndex).toBe(0);
  expect(report.evidence.pairs[0].second.meshLocalTriangleIndex).toBe(1);
  await page.getByRole("button", { name: "Inspect another model" }).click();
  await expect(panel).toHaveCount(0);
});
test("degenerate geometry is indeterminate rather than reported clean", async ({
  page,
}) => {
  await page.goto("/tools/mesh-health/");
  await page.locator("#model-file").setInputFiles({
    name: "degenerate.stl",
    mimeType: "model/stl",
    buffer: Buffer.from(
      model([
        facet([
          [0, 0, 0],
          [1, 0, 0],
          [2, 0, 0],
        ]),
      ]),
    ),
  });
  await page.getByRole("button", { name: "Validate and inspect" }).click();
  const panel = page.locator('[aria-labelledby="self-intersection-heading"]');
  await panel.getByRole("button", { name: "Check self-intersections" }).click();
  await expect(panel).toContainText("Indeterminate: degenerate-triangle", {
    timeout: 20_000,
  });
});
