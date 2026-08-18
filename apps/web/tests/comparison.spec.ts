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
  // Compared against the first observed request's origin rather than a
  // hardcoded port: this file also runs under playwright.csp.config.ts,
  // which serves the same build on a different port to exercise the real
  // Content-Security-Policy headers (see tests/README.md).
  const offOrigin: string[] = [];
  let pageOrigin: string | undefined;
  page.on("request", (request) => {
    const requestOrigin = new URL(request.url()).origin;
    pageOrigin ??= requestOrigin;
    if (requestOrigin !== pageOrigin) offOrigin.push(request.url());
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
  // Mobile emulation grows the layout viewport itself when content cannot
  // fit the device width, which the scrollWidth check above cannot see.
  expect(await page.evaluate(() => window.innerWidth)).toBe(
    page.viewportSize()?.width,
  );
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
  // Mobile emulation grows the layout viewport itself when content cannot
  // fit the device width, which the scrollWidth check above cannot see.
  expect(await page.evaluate(() => window.innerWidth)).toBe(
    page.viewportSize()?.width,
  );
});

test("imports, analyzes, and opens synchronized comparison views locally", async ({
  page,
}) => {
  // Compared against the first observed request's origin rather than a
  // hardcoded port: this file also runs under playwright.csp.config.ts,
  // which serves the same build on a different port to exercise the real
  // Content-Security-Policy headers (see tests/README.md).
  const offOrigin: string[] = [];
  let pageOrigin: string | undefined;
  page.on("request", (request) => {
    const requestOrigin = new URL(request.url()).origin;
    pageOrigin ??= requestOrigin;
    if (requestOrigin !== pageOrigin) offOrigin.push(request.url());
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
  // The starting value is a device-aware recommendation (see the dedicated
  // capability-preflight tests below), so only its well-formedness is
  // checked here rather than one fixed number -- the real reading depends
  // on the host's reported memory and cores.
  const recommended = Number(await memory.inputValue());
  expect(recommended).toBeGreaterThanOrEqual(128);
  expect(recommended).toBeLessThanOrEqual(768);
  expect(recommended % 128).toBe(0);
  const recommendation = page.locator("#analysis-memory-recommendation");
  await expect(recommendation).toBeVisible();
  await expect(recommendation).not.toHaveText("");
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

/**
 * Overrides the device signals `capability.ts` reads, deterministically and
 * before any page script runs, so the capability-preflight tests below do
 * not depend on the host machine's actual memory or core count.
 */
async function stubDeviceSignals(
  page: import("@playwright/test").Page,
  signals: {
    deviceMemory?: number;
    hardwareConcurrency?: number;
    coarsePointer?: boolean;
  },
) {
  await page.addInitScript((values) => {
    if (values.deviceMemory !== undefined) {
      Object.defineProperty(window.navigator, "deviceMemory", {
        get: () => values.deviceMemory,
        configurable: true,
      });
    }
    if (values.hardwareConcurrency !== undefined) {
      Object.defineProperty(window.navigator, "hardwareConcurrency", {
        get: () => values.hardwareConcurrency,
        configurable: true,
      });
    }
    if (values.coarsePointer !== undefined) {
      const originalMatchMedia = window.matchMedia.bind(window);
      window.matchMedia = (query: string) =>
        query === "(pointer: coarse)"
          ? ({
              matches: values.coarsePointer,
              media: query,
              onchange: null,
              addListener() {},
              removeListener() {},
              addEventListener() {},
              removeEventListener() {},
              dispatchEvent: () => false,
            } as MediaQueryList)
          : originalMatchMedia(query);
    }
  }, signals);
}

test("recommends a conservative, explained allowance on a simulated low-memory phone", async ({
  page,
}) => {
  await stubDeviceSignals(page, {
    deviceMemory: 2,
    hardwareConcurrency: 4,
    coarsePointer: true,
  });
  await page.goto("/compare/");
  const memory = page.getByRole("slider", { name: "Analysis RAM allowance" });
  await expect(memory).toHaveValue("256");
  await expect(
    page.getByText("This device reports 2 GB of memory", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("touch/mobile device", { exact: false }),
  ).toBeVisible();
  // The recommendation is a starting point, never a hard cap.
  await memory.fill("768");
  await expect(page.locator(".analysis-capacity output")).toHaveText("768 MiB");
});

test("recommends the full allowance on a simulated high-end, confirmed non-mobile desktop", async ({
  page,
}) => {
  await stubDeviceSignals(page, {
    deviceMemory: 8,
    hardwareConcurrency: 16,
    coarsePointer: false,
  });
  await page.goto("/compare/");
  const memory = page.getByRole("slider", { name: "Analysis RAM allowance" });
  await expect(memory).toHaveValue("768");
  await expect(
    page.getByText("This device reports 8 GB of memory", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("also reports 16 CPU cores", { exact: false }),
  ).toBeVisible();
});

test("blocks comparison with a clear message instead of crashing when Web Workers are unavailable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    // @ts-expect-error -- deliberately simulating a browser without Worker
    // support for the capability-preflight fallback path.
    delete window.Worker;
  });
  await page.goto("/compare/");
  await expect(
    page.getByText("Local comparison is unavailable in this browser"),
  ).toBeVisible();
  await expect(
    page.getByText("does not support Web Workers", { exact: false }),
  ).toBeVisible();
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
  // Even with two otherwise-ready files chosen, the missing Worker support
  // keeps the run disabled rather than letting it throw when it later tries
  // to construct one.
  await expect(
    page.getByRole("button", { name: "Validate and compare" }),
  ).toBeDisabled();
});

test("warns before running when the chosen files are unlikely to fit the chosen allowance", async ({
  page,
}) => {
  await page.goto("/compare/");
  const cards = page.locator(".source-card");
  const memory = page.getByRole("slider", { name: "Analysis RAM allowance" });
  await memory.fill("128");
  // Content does not need to be a valid mesh: the fit estimate is computed
  // from file size alone, before any import or parsing happens.
  await cards
    .nth(0)
    .locator('input[type="file"]')
    .setInputFiles({
      name: "large-baseline.stl",
      mimeType: "model/stl",
      buffer: Buffer.alloc(20 * 1024 * 1024),
    });
  await cards
    .nth(1)
    .locator('input[type="file"]')
    .setInputFiles({
      name: "large-candidate.stl",
      mimeType: "model/stl",
      buffer: Buffer.alloc(20 * 1024 * 1024),
    });
  await expect(
    page.getByText("Estimated analysis memory need is roughly", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("This is a rough estimate, not a guarantee", {
      exact: false,
    }),
  ).toBeVisible();
  // Raising the allowance past the rough estimate clears the warning.
  await memory.fill("768");
  await expect(
    page.getByText("Estimated analysis memory need is roughly", {
      exact: false,
    }),
  ).toBeHidden();
});

test("keeps findings and session/report actions usable when WebGL is unavailable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    // Simulates a browser/GPU combination that cannot create a WebGL
    // context, without depending on a real headless GPU configuration.
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
  // No WebGL context was ever created, so no canvas exists, and each
  // viewport shows the accessible non-canvas fallback instead.
  await expect(page.locator("canvas")).toHaveCount(0);
  await expect(page.locator(".render-fallback")).toHaveCount(3);
  await expect(
    page.getByText("3D preview unavailable", { exact: false }).first(),
  ).toBeVisible();
  // Findings, evidence, and the export/session actions do not depend on a
  // live 3D view and must remain usable.
  await expect(
    page.getByRole("heading", { name: "Changed regions" }),
  ).toBeVisible();
  expect(await page.locator(".findings li").count()).toBeGreaterThan(0);
  const saveButton = page.getByRole("button", { name: "Save session" });
  const exportButton = page.getByRole("button", { name: "Export report" });
  await expect(saveButton).toBeEnabled({ timeout: 20_000 });
  await expect(exportButton).toBeEnabled();
});
