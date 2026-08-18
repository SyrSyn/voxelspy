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

test("saves a completed comparison as a portable session and reopens it directly", async ({
  page,
}) => {
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
  await page.getByRole("button", { name: "Validate and compare" }).click();
  await expect(
    page.getByRole("heading", { name: "Comparison workbench" }),
  ).toBeVisible({ timeout: 20_000 });

  // Evidence a session actually restores the analyzed comparison, not just a
  // blank workbench: capture the rendered findings and stats before saving.
  const findingsBefore = await page.locator(".findings").textContent();
  const statsBefore = await page.locator(".analysis-stats").textContent();
  const summaryBefore = await page.locator(".evidence-summary").textContent();

  await expect(
    page.getByText(
      "Saving embeds both models’ original geometry in the downloaded file",
      { exact: false },
    ),
  ).toBeVisible();

  const firstDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save session" }).click();
  const download = await firstDownload;
  expect(download.suggestedFilename()).toMatch(
    /^voxelspy-session-.*\.voxelspy$/u,
  );
  const sessionPath = await download.path();
  expect(sessionPath).not.toBeNull();
  const sessionBytes = readFileSync(sessionPath!);

  // Saving the same, unchanged comparison again must be byte-identical: no
  // timestamps or randomness may leak into the archive.
  const secondDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save session" }).click();
  const secondSessionBytes = readFileSync(
    (await (await secondDownload).path())!,
  );
  expect(secondSessionBytes.equals(sessionBytes)).toBe(true);

  await page.getByRole("button", { name: "New comparison" }).click();
  await expect(
    page.getByRole("heading", { name: "Start with two models" }),
  ).toBeVisible();

  // "Validate and compare" is never clicked again below: whatever restores
  // the workbench next comes entirely from the reopened session archive.
  await page.locator("#session-open-file").setInputFiles({
    name: "reopened-session.voxelspy",
    mimeType: "application/zip",
    buffer: sessionBytes,
  });
  await expect(
    page.getByRole("heading", { name: "Comparison workbench" }),
  ).toBeVisible({ timeout: 20_000 });
  // Reopening imports the stored source models again to rebuild renderable
  // geometry, but must never re-run analysis: that progress message (used
  // only by the compare-and-analyze path) must never appear.
  await expect(
    page.getByText("Analyzing tessellated surface distance"),
  ).toHaveCount(0);

  expect(findingsBefore).not.toBeNull();
  expect(statsBefore).not.toBeNull();
  expect(summaryBefore).not.toBeNull();
  await expect(page.locator(".findings")).toHaveText(findingsBefore!);
  await expect(page.locator(".analysis-stats")).toHaveText(statsBefore!);
  await expect(page.locator(".evidence-summary")).toHaveText(summaryBefore!);
});

test("fails closed with a clear message when a corrupted session file is opened", async ({
  page,
}) => {
  await page.goto("/compare/");
  await page.locator("#session-open-file").setInputFiles({
    name: "corrupt.voxelspy",
    mimeType: "application/zip",
    buffer: Buffer.from("this is not a valid VoxelSpy session archive"),
  });
  await expect(page.getByText("Session could not be opened")).toBeVisible();
  // The page stays usable: no crash, and the ordinary comparison path still
  // works after a failed open.
  await expect(
    page.getByRole("heading", { name: "Start with two models" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Validate and compare" }),
  ).toBeDisabled();
});
