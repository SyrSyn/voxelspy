import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

// A source file name is the one field in a saved `.voxelspy` session that a
// real attacker fully controls end-to-end: it becomes
// `NormalizedModel.provenance.sourceName`, then `Report.models[].sourceName`
// embedded in the archive, and on reopen `sessionImportSpecFor` feeds it
// straight back into re-import, so the very same string is what the
// workbench renders again after a session round-trip. This script tag would
// set a global flag if the app ever interpreted it as markup instead of
// text; the `onerror` attribute injection covers the case where content
// lands in an HTML attribute rather than a text node.
const XSS_MARKER = "__voxelspyXssProbe";
const hostileName = (label: string) =>
  `<script>window.${XSS_MARKER}=(window.${XSS_MARKER}||0)+1</script>` +
  `<img src=x onerror="window.${XSS_MARKER}=(window.${XSS_MARKER}||0)+1">` +
  `${label}.stl`;

const baselineName = hostileName("baseline");
const candidateName = hostileName("candidate");

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

async function xssProbeValue(page: import("@playwright/test").Page) {
  return page.evaluate(
    (marker) => (window as unknown as Record<string, unknown>)[marker],
    XSS_MARKER,
  );
}

test("a hostile file name never executes, in the DOM or in an exported report, even after a session round-trip", async ({
  page,
}) => {
  await page.goto("/compare/");
  const scriptElementsAtLoad = await page.locator("script").count();

  const cards = page.locator(".source-card");
  await cards
    .nth(0)
    .locator('input[type="file"]')
    .setInputFiles({
      name: baselineName,
      mimeType: "model/stl",
      buffer: Buffer.from(baseline),
    });
  await cards
    .nth(1)
    .locator('input[type="file"]')
    .setInputFiles({
      name: candidateName,
      mimeType: "model/stl",
      buffer: Buffer.from(candidate),
    });

  // Before comparison ever runs, the file-choice card already shows the raw
  // name as text -- confirm it never executed there either.
  await expect(cards.nth(0).locator(".source-file span").first()).toHaveText(
    baselineName,
  );
  expect(await xssProbeValue(page)).toBeUndefined();

  await page.getByRole("button", { name: "Validate and compare" }).click();
  await expect(
    page.getByRole("heading", { name: "Comparison workbench" }),
  ).toBeVisible({ timeout: 20_000 });

  // The name is genuinely rendered (as safe text), not stripped or
  // suppressed -- and it never executed.
  await expect(page.locator(".workbench-footer")).toContainText(baselineName);
  await expect(page.locator(".workbench-footer")).toContainText(candidateName);
  expect(await xssProbeValue(page)).toBeUndefined();
  expect(await page.locator("script").count()).toBe(scriptElementsAtLoad);

  const saveButton = page.getByRole("button", { name: "Save session" });
  await expect(saveButton).toBeEnabled({ timeout: 20_000 });
  const sessionDownload = page.waitForEvent("download");
  await saveButton.click();
  const sessionBytes = readFileSync((await (await sessionDownload).path())!);

  await page.getByRole("button", { name: "New comparison" }).click();
  await expect(
    page.getByRole("heading", { name: "Start with two models" }),
  ).toBeVisible();

  // Reopen: the exact path a real attacker-authored `.voxelspy` file would
  // reach. Nothing below re-runs "Validate and compare".
  await page.locator("#session-open-file").setInputFiles({
    name: "reopened-session.voxelspy",
    mimeType: "application/zip",
    buffer: sessionBytes,
  });
  await expect(
    page.getByRole("heading", { name: "Comparison workbench" }),
  ).toBeVisible({ timeout: 20_000 });

  await expect(page.locator(".workbench-footer")).toContainText(baselineName);
  await expect(page.locator(".workbench-footer")).toContainText(candidateName);
  expect(await xssProbeValue(page)).toBeUndefined();
  expect(await page.locator("script").count()).toBe(scriptElementsAtLoad);

  // Exporting a report from this *reopened* session is the other reachable
  // path for the same attacker-controlled string: it must come out escaped
  // in the downloaded HTML, never as live markup.
  const exportButton = page.getByRole("button", { name: "Export report" });
  await expect(exportButton).toBeEnabled({ timeout: 20_000 });
  const reportDownload = page.waitForEvent("download");
  await exportButton.click();
  const reportPath = await (await reportDownload).path();
  expect(reportPath).not.toBeNull();
  const html = readFileSync(reportPath!, "utf8");

  expect(html).not.toContain("<script");
  expect(html).not.toContain(`onerror="window.${XSS_MARKER}`);
  expect(html).toContain(`&lt;script&gt;window.${XSS_MARKER}`);
  expect(html).toContain(
    baselineName.replace(/[<>"]/gu, (char) =>
      char === "<" ? "&lt;" : char === ">" ? "&gt;" : "&quot;",
    ),
  );
});
