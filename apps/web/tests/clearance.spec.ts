import { expect, test, type Page } from "@playwright/test";

/**
 * Browser coverage for Clearance & Fit (`/tools/clearance-fit/`): will two
 * independently, deliberately placed parts fit? Fixtures are simple
 * axis-aligned boxes (12 triangles each) so the true minimum distance and
 * interference are hand-computable and exact, independent of tessellation:
 * two boxes translated only along Z have their true closest approach
 * exactly at their corresponding corner vertices, which `checkClearance`
 * samples directly.
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

// A 10mm cube at the origin, reused as "the first part" across scenarios.
const boxOne = boxStl("box-one", [0, 0, 0], [10, 10, 10]);
// Well clear of box one: a 5mm gap between z=10 and z=15.
const boxTwoClear = boxStl("box-two", [0, 0, 15], [10, 10, 25]);
// A 0.4mm gap: below the 1mm desired clearance used in the tight scenario.
const boxTwoTight = boxStl("box-two", [0, 0, 10.4], [10, 10, 20.4]);
// A genuine 5mm volumetric overlap with box one.
const boxTwoInterfering = boxStl("box-two", [0, 0, 5], [10, 10, 15]);

async function chooseParts(
  page: Page,
  firstStl: string,
  secondStl: string,
  firstName = "first.stl",
  secondName = "second.stl",
) {
  await page.locator("#first-file").setInputFiles({
    name: firstName,
    mimeType: "model/stl",
    buffer: Buffer.from(firstStl),
  });
  await page.locator("#second-file").setInputFiles({
    name: secondName,
    mimeType: "model/stl",
    buffer: Buffer.from(secondStl),
  });
}

async function setDesiredClearance(page: Page, millimetres: number) {
  await page.locator("#desired-clearance").fill(String(millimetres));
}

async function runCheck(page: Page) {
  await page.getByRole("button", { name: "Check clearance" }).click();
  await expect(
    page.getByRole("heading", { level: 3, name: "Fit verdict" }),
  ).toBeVisible({ timeout: 20_000 });
}

test("two separated boxes report Clear with the expected minimum distance", async ({
  page,
}) => {
  await page.goto("/tools/clearance-fit/");
  await chooseParts(page, boxOne, boxTwoClear);
  await setDesiredClearance(page, 1);
  await runCheck(page);

  const verdict = page.locator(".clearance-badge");
  await expect(verdict).toContainText("Clear");
  await expect(verdict).toContainText(
    "meets or exceeds the requested clearance",
  );

  const distance = page.locator('[aria-labelledby="clearance-distance-title"]');
  await expect(distance).toContainText("5 mm");

  await expect(
    page.getByRole("heading", { level: 3, name: "Interference" }),
  ).toBeVisible();
  await expect(page.getByText("No intersecting triangle pairs")).toBeVisible();
  await expect(
    page.getByText("No interference volume is computed"),
  ).toBeVisible();
});

test("a gap under the desired clearance reports Tight with a region", async ({
  page,
}) => {
  await page.goto("/tools/clearance-fit/");
  await chooseParts(page, boxOne, boxTwoTight);
  await setDesiredClearance(page, 1);
  await runCheck(page);

  const verdict = page.locator(".clearance-badge");
  await expect(verdict).toContainText("Tight");
  await expect(verdict).toContainText("below the requested clearance");

  const distance = page.locator('[aria-labelledby="clearance-distance-title"]');
  await expect(distance).toContainText("0.4 mm");

  const regionsHeading = page.getByRole("heading", {
    level: 3,
    name: /Tight regions \(\d+\)/u,
  });
  await expect(regionsHeading).toBeVisible();
  const headingText = await regionsHeading.textContent();
  expect(headingText).not.toContain("Tight regions (0)");
  await expect(page.locator(".diagnostic-list li").first()).toBeVisible();
  await expect(
    page.locator('[aria-labelledby="clearance-tight-regions-title"]'),
  ).toContainText("mm apart");
});

test("volumetrically overlapping boxes report Interfering", async ({
  page,
}) => {
  await page.goto("/tools/clearance-fit/");
  await chooseParts(page, boxOne, boxTwoInterfering);
  await setDesiredClearance(page, 1);
  await runCheck(page);

  const verdict = page.locator(".clearance-badge");
  await expect(verdict).toContainText("Interfering");
  await expect(verdict).toContainText("exact triangle-triangle intersection");

  const interference = page.locator(
    '[aria-labelledby="clearance-interference-title"]',
  );
  await expect(interference).toContainText(
    /\d+ intersecting triangle pairs? found/u,
  );
  await expect(interference).toContainText(
    "No interference volume is computed",
  );
});

test("an explicit placement transform demonstrably changes the verdict", async ({
  page,
}) => {
  await page.goto("/tools/clearance-fit/");

  // At the identity placement (default, not moved), the two boxes are 5mm
  // apart and the desired clearance is 1mm: Clear.
  await chooseParts(page, boxOne, boxTwoClear);
  await setDesiredClearance(page, 1);
  await runCheck(page);
  await expect(page.locator(".clearance-badge")).toContainText("Clear");

  // Start over with the same two files, but this time move the second part
  // by an explicit -15mm Z translation, which lands it exactly on top of the
  // first part (box two was placed at z=[15,25]; -15 brings it to z=[0,10],
  // fully coincident with box one at z=[0,10]).
  await page.getByRole("button", { name: "Check another pair" }).click();
  await chooseParts(page, boxOne, boxTwoClear);
  await setDesiredClearance(page, 1);

  await page
    .locator("fieldset.source-card", { hasText: "Second part" })
    .getByText("Placement (optional)")
    .click();
  await page.locator("#second-translate-z").fill("-15");
  await expect(page.locator("#second-translate-z")).toHaveValue("-15");
  // The applied transform is shown for audit before the check even runs.
  await expect(page.locator(".placement-transform code").last()).toContainText(
    "-15",
  );

  await runCheck(page);
  await expect(page.locator(".clearance-badge")).toContainText("Interfering");
});

test("an undersampled tessellation adds an explicit caveat to a Clear verdict", async ({
  page,
}) => {
  await page.goto("/tools/clearance-fit/");
  // Same well-separated boxes as the Clear scenario, but with a desired
  // clearance (0.01mm) far below the sample-spacing bound these 10mm-edged
  // triangles carry: the verdict is still Clear (5mm actual gap), but the
  // engine's own sampling bound cannot back a guarantee at that clearance.
  await chooseParts(page, boxOne, boxTwoClear);
  await setDesiredClearance(page, 0.01);
  await runCheck(page);

  await expect(page.locator(".clearance-badge")).toContainText("Clear");
  const caveat = page.locator(".clearance-caveat");
  await expect(caveat).toBeVisible();
  await expect(caveat).toContainText("not a geometric guarantee");
  await expect(caveat).toContainText("sample spacing bound");
});

test("with WebGL unavailable, the fit report remains fully usable and the page does not crash", async ({
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

  await page.goto("/tools/clearance-fit/");
  await chooseParts(page, boxOne, boxTwoTight);
  await setDesiredClearance(page, 1);
  await runCheck(page);

  await expect(page.locator(".clearance-badge")).toContainText("Tight");
  const distance = page.locator('[aria-labelledby="clearance-distance-title"]');
  await expect(distance).toContainText("0.4 mm");

  await expect(page.locator(".clearance-viewport canvas")).toHaveCount(0);
  await expect(
    page.locator(".clearance-viewport .render-fallback"),
  ).toBeVisible();
  await expect(
    page.getByText("3D fit preview unavailable", { exact: false }),
  ).toBeVisible();
});

test("Clearance & Fit appears in the tools catalog as available and links to /tools/clearance-fit/", async ({
  page,
}) => {
  await page.goto("/tools/");
  const card = page.locator("a.tool-card-available").filter({
    has: page.getByRole("heading", { level: 2, name: "Clearance & Fit" }),
  });
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute("href", "/tools/clearance-fit/");
  await expect(card).toContainText("Available");

  await card.click();
  await expect(page).toHaveURL(/\/tools\/clearance-fit\/$/u);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Will these two parts fit?",
    }),
  ).toBeVisible();
});
