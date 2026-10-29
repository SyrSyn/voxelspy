import { expectViewportsRendered } from "./webgl";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
const model = (tip: number) =>
  `solid part\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 ${tip}\nendloop\nendfacet\nendsolid part\n`;
test.setTimeout(90000);
test("authors notes/distances and restores actual named views through a portable session", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/compare/");
  for (const [index, tip] of [0, 1].entries())
    await page
      .locator('.source-card input[type="file"]')
      .nth(index)
      .setInputFiles({
        name: `part-${index}.stl`,
        mimeType: "model/stl",
        buffer: Buffer.from(model(tip)),
      });
  await page.getByRole("button", { name: "Validate and compare" }).click();
  await expect(
    page.getByRole("heading", { name: "Comparison workbench" }),
  ).toBeVisible({ timeout: 20000 });
  await page.locator(".review-panel > summary").click();
  await page
    .getByLabel("Annotation label", { exact: true })
    .fill("<hostile> note");
  await page
    .getByLabel("Callout text", { exact: true })
    .fill('<img src=x onerror="alert(1)"> Review this corner');
  await page.getByLabel("Start / anchor (mm)", { exact: true }).fill("1,2,0");
  await page
    .getByRole("button", { name: "Add annotation", exact: true })
    .click();
  await expect(
    page.getByRole("list", { name: "Review annotations" }),
  ).toContainText("Review this corner");
  await page
    .getByLabel("Annotation type", { exact: true })
    .selectOption("distance");
  await page
    .getByLabel("Annotation label", { exact: true })
    .fill("Five millimetres");
  await page.getByLabel("Start / anchor (mm)", { exact: true }).fill("0,0,0");
  await page.getByLabel("End point (mm)", { exact: true }).fill("3,4,0");
  await page
    .getByRole("button", { name: "Add annotation", exact: true })
    .click();
  await expect(
    page.getByRole("list", { name: "Review annotations" }),
  ).toContainText("5 mm");
  await page.getByLabel("Show baseline model", { exact: true }).uncheck();
  await page
    .getByLabel("Primary view", { exact: true })
    .selectOption("overlay");
  await page.getByRole("button", { name: "Reset camera" }).click();
  const initialCamera = await page.getByTestId("review-camera").textContent();
  const webgl = await expectViewportsRendered(
    page,
    page.locator(".workbench"),
    3,
  );
  if (webgl) {
    // Exercise actual OrbitControls where the browser supplies WebGL.
    const canvas = page.locator(".workbench-stage canvas").first();
    await canvas.scrollIntoViewIfNeeded();
    const box = await canvas.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box!.x + box!.width / 2 + 35,
      box!.y + box!.height / 2 + 20,
      { steps: 8 },
    );
    await page.mouse.up();
  } else {
    test.info().annotations.push({
      type: "graphics",
      description:
        "WebGL unavailable: verified all three accessible fallbacks and named camera focus/restore through ranked evidence.",
    });
    // The accessible evidence list still focuses a named region's camera
    // when 3D rendering is unavailable; all authoring/persistence runs.
    await page.locator(".findings ol button").first().click();
  }
  await expect
    .poll(() => page.getByTestId("review-camera").textContent())
    .not.toBe(initialCamera);
  const cameraBefore = await page.getByTestId("review-camera").textContent();
  await page
    .getByLabel("Saved view name", { exact: true })
    .fill("Corner review");
  await page
    .getByRole("button", { name: "Save named view", exact: true })
    .click();
  await page.getByRole("button", { name: "Reset camera" }).click();
  await page.getByLabel("Show baseline model", { exact: true }).check();
  await page
    .getByRole("button", { name: "Restore view Corner review", exact: true })
    .click();
  await expect(page.getByTestId("review-camera")).toHaveText(cameraBefore!);
  await expect(
    page.getByLabel("Show baseline model", { exact: true }),
  ).not.toBeChecked();
  const save = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save session", exact: true }).click();
  const bytes = readFileSync((await (await save).path())!);
  const saveAgain = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save session", exact: true }).click();
  expect(readFileSync((await (await saveAgain).path())!).equals(bytes)).toBe(
    true,
  );
  const exportEvent = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export report", exact: true })
    .click();
  const html = readFileSync((await (await exportEvent).path())!, "utf8");
  expect(html).toContain("&lt;hostile&gt; note");
  expect(html).toContain("Distance: 5.000 mm");
  expect(html).toContain("Corner review");
  expect(html).not.toContain("<img src=x");
  const renderedReport = await page.context().newPage();
  await renderedReport.setContent(html);
  await expect(
    renderedReport.getByRole("heading", {
      name: "<hostile> note",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    renderedReport.getByText("Distance: 5.000 mm", { exact: true }),
  ).toBeVisible();
  await expect(renderedReport.locator("img")).toHaveCount(0);
  await renderedReport.close();
  await page
    .getByRole("button", { name: "New comparison", exact: true })
    .click();
  await page.locator("#session-open-file").setInputFiles({
    name: "review.voxelspy",
    mimeType: "application/zip",
    buffer: bytes,
  });
  await expect(page.locator(".review-panel > summary")).toContainText(
    "2 annotations",
    { timeout: 20000 },
  );
  await page.locator(".review-panel > summary").click();
  await expect(
    page.getByRole("button", {
      name: "Restore view Corner review",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByTestId("review-camera")).toHaveText(cameraBefore!);
  await expect(page.getByLabel("Primary view", { exact: true })).toHaveValue(
    "overlay",
  );
  await expect(
    page.getByLabel("Show baseline model", { exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("list", { name: "Review annotations" }),
  ).toContainText("5 mm");
  await page
    .getByLabel("Show annotation Five millimetres", { exact: true })
    .uncheck();
  await page
    .getByRole("button", {
      name: "Delete annotation Five millimetres",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Select annotation Five millimetres",
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Delete view Corner review", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Restore view Corner review",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
