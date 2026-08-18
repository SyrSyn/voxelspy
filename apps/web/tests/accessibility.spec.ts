import { expect, test, type Locator, type Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// A small, self-contained WCAG contrast helper (no axe-core, per constraints).
// ---------------------------------------------------------------------------

type Rgb = [number, number, number];

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance([r, g, b]: Rgb): number {
  return (
    0.2126 * srgbToLinear(r) +
    0.7152 * srgbToLinear(g) +
    0.0722 * srgbToLinear(b)
  );
}

/** WCAG 2.x contrast ratio, from 1:1 (no contrast) to 21:1 (max). */
function contrastRatio(a: Rgb, b: Rgb): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const [lighter, darker] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}

function hexToRgb(hex: string): Rgb {
  const value = hex.trim().replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;
  const n = Number.parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function parseCssColor(value: string): Rgb {
  const match = value.match(/rgba?\(([^)]+)\)/u);
  if (match) {
    const parts = match[1]!
      .split(",")
      .map((part) => Number.parseFloat(part.trim()));
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  }
  return hexToRgb(value);
}

/**
 * Reads a CSS custom property directly off :root for a given theme. Custom
 * properties preserve their literal authored value (e.g. "#1d8d53"), so this
 * checks the design tokens themselves -- the same source of truth the
 * `styles.css` rules consume -- rather than depending on some particular
 * element happening to be reachable in a given state.
 */
async function themeTokens(page: Page, theme: "light" | "dark") {
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value;
  }, theme);
  return page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const read = (name: string) => style.getPropertyValue(name).trim();
    return {
      text: read("--text"),
      muted: read("--muted"),
      dangerText: read("--danger-text"),
      orange: read("--orange"),
      diffAdded: read("--diff-added"),
      diffRemoved: read("--diff-removed"),
      diffDeviation: read("--diff-deviation"),
      diffShared: read("--diff-shared"),
      green: read("--green"),
      greenInk: read("--green-ink"),
      greenBright: read("--green-bright"),
      bg: read("--bg"),
      surfaceSolid: read("--surface-solid"),
      surfaceMuted: read("--surface-muted"),
    };
  });
}

/**
 * Composites an element's own background over every ancestor's background
 * (or, with `fromParent`, starts one level up -- for a swatch whose own
 * background *is* the foreground color being measured) so a translucent
 * surface (e.g. `--surface`'s alpha) resolves to the color actually visible
 * on screen, not just its own un-blended channel values.
 */
async function compositedBackground(
  locator: Locator,
  options: { fromParent?: boolean } = {},
): Promise<Rgb> {
  return locator.evaluate((element, fromParent) => {
    function parse(value: string): [number, number, number, number] | null {
      const match = value.match(/rgba?\(([^)]+)\)/u);
      if (!match) return null;
      const parts = match[1]!
        .split(",")
        .map((part) => Number.parseFloat(part.trim()));
      return [
        parts[0] ?? 0,
        parts[1] ?? 0,
        parts[2] ?? 0,
        parts.length > 3 ? (parts[3] ?? 1) : 1,
      ];
    }
    let node: HTMLElement | null = fromParent
      ? element.parentElement
      : (element as HTMLElement);
    const chain: string[] = [];
    while (node) {
      chain.push(getComputedStyle(node).backgroundColor);
      node = node.parentElement;
    }
    chain.reverse();
    let r = 255;
    let g = 255;
    let b = 255;
    let a = 0;
    for (const raw of chain) {
      const parsed = parse(raw);
      if (!parsed || parsed[3] === 0) continue;
      const [fr, fg, fb, fa] = parsed;
      const outA = fa + a * (1 - fa);
      if (outA === 0) continue;
      r = (fr * fa + r * a * (1 - fa)) / outA;
      g = (fg * fa + g * a * (1 - fa)) / outA;
      b = (fb * fa + b * a * (1 - fa)) / outA;
      a = outA;
    }
    return [Math.round(r), Math.round(g), Math.round(b)];
  }, options.fromParent ?? false);
}

async function foregroundColor(locator: Locator): Promise<Rgb> {
  const color = await locator.evaluate((el) => getComputedStyle(el).color);
  return parseCssColor(color);
}

async function swatchColor(locator: Locator): Promise<Rgb> {
  const color = await locator.evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  return parseCssColor(color);
}

// ---------------------------------------------------------------------------
// Keyboard-path helpers
// ---------------------------------------------------------------------------

type FocusSnapshot = {
  tag: string;
  id: string;
  text: string;
  className: string;
  outlineStyle: string;
  outlineWidth: string;
  ariaPressed: string | null;
  inFindingsList: boolean;
  inSessionPanel: boolean;
};

async function focusSnapshot(page: Page): Promise<FocusSnapshot | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const style = getComputedStyle(el);
    return {
      tag: el.tagName,
      id: el.id,
      text: (el.textContent ?? "").trim().slice(0, 60),
      className: typeof el.className === "string" ? el.className : "",
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      ariaPressed: el.getAttribute("aria-pressed"),
      inFindingsList: Boolean(el.closest(".findings li")),
      inSessionPanel: Boolean(el.closest(".session-panel")),
    };
  });
}

/**
 * Presses Tab repeatedly (real keyboard input, not `.focus()`) until the
 * active element matches `matches`, asserting along the way that focus never
 * falls back to <body> -- the signal used here for "focus was lost" / a
 * keyboard trap -- so a caller that reaches its target has proof of an
 * unbroken, forward-progressing focus path from wherever it started.
 */
async function tabUntil(
  page: Page,
  matches: (snapshot: FocusSnapshot) => boolean,
  {
    maxSteps = 50,
    label = "target",
    key = "Tab",
  }: { maxSteps?: number; label?: string; key?: "Tab" | "Shift+Tab" } = {},
): Promise<FocusSnapshot> {
  const path: string[] = [];
  for (let step = 0; step < maxSteps; step += 1) {
    await page.keyboard.press(key);
    const snapshot = await focusSnapshot(page);
    expect(
      snapshot,
      `focus fell back to <body> while tabbing toward ${label} (a keyboard trap or dead end); path so far: ${path.join(" -> ")}`,
    ).not.toBeNull();
    path.push(
      `${snapshot!.tag}#${snapshot!.id || "-"}.${(snapshot!.className || "-").split(" ")[0]}(${snapshot!.text.slice(0, 24)})`,
    );
    if (matches(snapshot!)) return snapshot!;
  }
  throw new Error(
    `Did not reach ${label} within ${maxSteps} ${key} presses. Focus path: ${path.join(" -> ")}`,
  );
}

function assertVisibleOutline(snapshot: FocusSnapshot, label: string) {
  expect(
    snapshot.outlineStyle,
    `${label} has no visible keyboard focus indicator (outline-style: ${snapshot.outlineStyle})`,
  ).not.toBe("none");
  expect(Number.parseFloat(snapshot.outlineWidth)).toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------
// Fixtures. The "rich" pair places three well-separated triangles so the
// analysis reports multiple, spatially distinct bounded regions -- one
// shifted vertex (a deviation), one triangle removed in the candidate, and
// one triangle added in the candidate -- which region selection and the
// non-color-semantics checks below need to exercise more than a single
// finding. tests/session.spec.ts and tests/report-export.spec.ts already
// cover the plain single-triangle case; this file does not repeat that.
// ---------------------------------------------------------------------------

const richBaselineStl = `solid baseline
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 10 0 0
vertex 0 10 0
endloop
endfacet
facet normal 0 0 1
outer loop
vertex 100 100 0
vertex 110 100 0
vertex 100 110 0
endloop
endfacet
endsolid baseline
`;

const richCandidateStl = `solid candidate
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 10 0 0
vertex 0 10 1
endloop
endfacet
facet normal 0 0 1
outer loop
vertex 200 200 0
vertex 210 200 0
vertex 200 210 0
endloop
endfacet
endsolid candidate
`;

async function attachRichFixture(page: Page) {
  const cards = page.locator(".source-card");
  await cards
    .nth(0)
    .locator('input[type="file"]')
    .setInputFiles({
      name: "baseline.stl",
      mimeType: "model/stl",
      buffer: Buffer.from(richBaselineStl),
    });
  await cards
    .nth(1)
    .locator('input[type="file"]')
    .setInputFiles({
      name: "candidate.stl",
      mimeType: "model/stl",
      buffer: Buffer.from(richCandidateStl),
    });
}

// ---------------------------------------------------------------------------
// Landmarks, headings, skip link, and aria-controls
// ---------------------------------------------------------------------------

const routes = [
  "/",
  "/tools/",
  "/compare/",
  "/tools/inspect/",
  "/tools/scale/",
  "/tools/volume/",
  "/tools/watertight/",
  "/tools/file-forensics/",
  "/docs/",
  "/docs/getting-started/",
  "/nope/",
];

for (const route of routes) {
  test(`landmark and heading structure are correct on ${route}`, async ({
    page,
  }) => {
    await page.goto(route);

    // Exactly one banner, main, and contentinfo landmark, plus the primary
    // and footer navigation landmarks -- checked structurally (not via
    // getByRole, which excludes display:none content) since the primary nav
    // is hidden behind a closed hamburger menu on narrow viewports.
    // `<header>`/`<footer>` also legitimately label sub-sections (page
    // heroes, the workbench header, individual viewport headers), so the
    // single site-wide banner/contentinfo landmark is matched by class.
    await expect(page.locator("header.site-header")).toHaveCount(1);
    await expect(page.locator("main#main-content")).toHaveCount(1);
    await expect(page.locator("footer.site-footer")).toHaveCount(1);
    await expect(
      page.locator('nav[aria-label="Primary navigation"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('nav[aria-label="Footer navigation"]'),
    ).toHaveCount(1);

    // Exactly one visible h1, and no visible heading level skips a step.
    // Collapsed <details> content (e.g. the workbench's technical-details
    // sections) is excluded by the visibility check, matching what a
    // screen-reader user browsing by heading actually encounters before
    // expanding anything.
    const headings = page.locator("h1, h2, h3, h4, h5, h6");
    const total = await headings.count();
    const levels: number[] = [];
    for (let index = 0; index < total; index += 1) {
      const heading = headings.nth(index);
      if (await heading.isVisible()) {
        const tag = await heading.evaluate((el) => el.tagName);
        levels.push(Number(tag[1]));
      }
    }
    expect(
      levels.filter((level) => level === 1),
      `expected exactly one visible h1 on ${route}, saw levels: ${levels.join(", ")}`,
    ).toHaveLength(1);
    for (let index = 1; index < levels.length; index += 1) {
      expect(
        levels[index]! - levels[index - 1]!,
        `heading level skipped on ${route} around position ${index}: ...${levels.slice(Math.max(0, index - 2), index + 1).join(",")}...`,
      ).toBeLessThanOrEqual(1);
    }
  });
}

test("the skip link is keyboard reachable first and moves real focus into main content", async ({
  page,
}) => {
  await page.goto("/compare/");
  await page.keyboard.press("Tab");
  const first = await focusSnapshot(page);
  expect(first?.tag).toBe("A");
  expect(first?.className).toContain("skip-link");
  assertVisibleOutline(first!, "skip link");

  await page.keyboard.press("Enter");
  const afterActivation = await focusSnapshot(page);
  expect(
    afterActivation?.id,
    "activating the skip link must move focus into #main-content, not just scroll to it",
  ).toBe("main-content");
});

test("the primary navigation menu button exposes aria-controls and every icon-only control has an accessible name", async ({
  page,
}) => {
  await page.goto("/");
  // Structural, not role-based: the menu button is display:none above the
  // 850px breakpoint (desktop project), which excludes it from the
  // accessibility tree entirely, but its markup must still be correct.
  const menuButton = page.locator(".menu-button");
  await expect(menuButton).toHaveAttribute(
    "aria-controls",
    "primary-navigation",
  );
  await expect(page.locator("#primary-navigation")).toHaveCount(1);

  // Icon-only controls: the theme toggle (SVG icon, no visible text) and the
  // GitHub link (its "GitHub" label is hidden by CSS on narrow viewports)
  // must still resolve a real accessible name.
  const themeButton = page.getByRole("button", { name: /^Theme:/u });
  await expect(themeButton).toBeVisible();
  await expect(themeButton).toHaveAttribute("aria-label", /^Theme:/u);

  const githubLink = page.getByRole("link", { name: "VoxelSpy on GitHub" });
  await expect(githubLink).toBeVisible();

  const brandLink = page.getByRole("link", { name: "VoxelSpy home" });
  await expect(brandLink).toBeVisible();
});

// ---------------------------------------------------------------------------
// Contrast: design tokens, checked directly (no navigation to a completed
// comparison required) against every surface color that actually hosts
// them.
// ---------------------------------------------------------------------------

test("difference-category and status color tokens meet WCAG contrast minimums in both themes", async ({
  page,
}) => {
  await page.goto("/compare/");
  for (const theme of ["light", "dark"] as const) {
    const tokens = await themeTokens(page, theme);
    const surfaces: [string, Rgb][] = [
      ["surface-solid", hexToRgb(tokens.surfaceSolid)],
      ["surface-muted", hexToRgb(tokens.surfaceMuted)],
    ];

    // Non-text UI indicators (legend swatches, finding-list cues): WCAG
    // 1.4.11 non-text contrast, 3:1 against every surface they render on.
    const swatches: [string, string][] = [
      ["diff-added", tokens.diffAdded],
      ["diff-removed", tokens.diffRemoved],
      ["diff-deviation", tokens.diffDeviation],
      ["diff-shared", tokens.diffShared],
      ["orange (capability status dot)", tokens.orange],
    ];
    for (const [name, hex] of swatches) {
      for (const [surfaceName, surface] of surfaces) {
        const ratio = contrastRatio(hexToRgb(hex), surface);
        expect(
          ratio,
          `${theme} theme: --${name} (${hex}) vs ${surfaceName} is only ${ratio.toFixed(2)}:1, below the 3:1 non-text minimum`,
        ).toBeGreaterThanOrEqual(3);
      }
    }

    // Text tokens: 4.5:1 against every surface they render on.
    const texts: [string, string][] = [
      ["text", tokens.text],
      ["muted", tokens.muted],
      ["danger-text (indeterminate-result error)", tokens.dangerText],
      ["green (links/eyebrows)", tokens.green],
    ];
    for (const [name, hex] of texts) {
      for (const [surfaceName, surface] of [
        ...surfaces,
        ["bg", hexToRgb(tokens.bg)] as [string, Rgb],
      ]) {
        const ratio = contrastRatio(hexToRgb(hex), surface);
        expect(
          ratio,
          `${theme} theme: --${name} (${hex}) vs ${surfaceName} is only ${ratio.toFixed(2)}:1, below the 4.5:1 text minimum`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }

    // button-primary text on its own background.
    const buttonRatio = contrastRatio(
      hexToRgb(tokens.greenInk),
      hexToRgb(tokens.greenBright),
    );
    expect(buttonRatio).toBeGreaterThanOrEqual(4.5);
  }
});

// ---------------------------------------------------------------------------
// Full keyboard path + canvas accessible names + non-color semantics + live
// regions, all against one completed comparison (the expensive part of this
// suite, so related assertions share it rather than repeating a full
// worker-backed comparison per concern).
// ---------------------------------------------------------------------------

test("full keyboard path reaches compare, findings, region selection, shortcuts, and save/export with no keyboard trap", async ({
  page,
}) => {
  await page.goto("/compare/");

  const baselineFocus = await tabUntil(page, (s) => s.id === "baseline-file", {
    label: "baseline file input",
  });
  assertVisibleOutline(baselineFocus, "baseline file input");
  // The <input> itself is visually 1px; its wrapping label must also show a
  // perceivable ring so a sighted keyboard user can see where focus is.
  await expect(
    page.locator(".source-card").nth(0).locator(".source-file"),
  ).toHaveCSS("outline-style", "solid");
  await page
    .locator(".source-card")
    .nth(0)
    .locator('input[type="file"]')
    .setInputFiles({
      name: "baseline.stl",
      mimeType: "model/stl",
      buffer: Buffer.from(richBaselineStl),
    });

  const candidateFocus = await tabUntil(
    page,
    (s) => s.id === "candidate-file",
    {
      label: "candidate file input",
    },
  );
  assertVisibleOutline(candidateFocus, "candidate file input");
  await page
    .locator(".source-card")
    .nth(1)
    .locator('input[type="file"]')
    .setInputFiles({
      name: "candidate.stl",
      mimeType: "model/stl",
      buffer: Buffer.from(richCandidateStl),
    });

  const validateFocus = await tabUntil(
    page,
    (s) => s.tag === "BUTTON" && s.text === "Validate and compare",
    { label: '"Validate and compare" button' },
  );
  assertVisibleOutline(validateFocus, "Validate and compare button");

  // Keyboard activation (Enter), not a mouse click.
  await page.keyboard.press("Enter");

  // The progress live region's text is set synchronously in the click
  // handler before any async work starts, so this is not a race against the
  // (very fast, tiny) comparison actually finishing.
  await expect(page.locator(".comparison-status")).toHaveAttribute(
    "aria-live",
    "polite",
  );
  await expect(page.locator(".comparison-status")).toContainText(
    /Starting local comparison|Comparing locally/u,
  );

  await expect(
    page.getByRole("heading", { name: "Comparison workbench" }),
  ).toBeVisible({
    timeout: 20_000,
  });

  // --- Canvas accessible names ---------------------------------------------
  const diffCanvas = page.locator(".viewport-difference").getByRole("img");
  const baselineCanvas = page.locator(".viewport-baseline").getByRole("img");
  const candidateCanvas = page.locator(".viewport-candidate").getByRole("img");
  await expect(diffCanvas).toHaveCount(1);
  await expect(baselineCanvas).toHaveCount(1);
  await expect(candidateCanvas).toHaveCount(1);

  const diffLabel = await diffCanvas.getAttribute("aria-label");
  expect(diffLabel).toContain("baseline.stl");
  expect(diffLabel).toContain("candidate.stl");
  await expect(diffCanvas).toHaveAttribute(
    "aria-describedby",
    "findings-equivalent-note",
  );
  await expect(page.locator("#findings-equivalent-note")).toHaveCount(1);
  await expect(page.locator("#findings-equivalent-note")).toHaveText(
    /accessible, text equivalent/u,
  );

  const baselineLabel = await baselineCanvas.getAttribute("aria-label");
  expect(baselineLabel).toContain("baseline.stl");
  const candidateLabel = await candidateCanvas.getAttribute("aria-label");
  expect(candidateLabel).toContain("candidate.stl");

  // --- Non-color semantics --------------------------------------------------
  const legend = page.locator(".change-legend");
  for (const word of ["Added", "Removed", "Shared", "Deviation"]) {
    await expect(legend).toContainText(word);
  }
  const legendEntries = legend.locator("span");
  const legendCount = await legendEntries.count();
  expect(legendCount).toBeGreaterThanOrEqual(4);
  for (let index = 0; index < legendCount; index += 1) {
    const text = (await legendEntries.nth(index).innerText()).trim();
    expect(
      text.length,
      "every legend swatch must carry a visible text label, not color alone",
    ).toBeGreaterThan(0);
  }

  const findingButtons = page.locator(".findings li button");
  const findingCount = await findingButtons.count();
  expect(
    findingCount,
    "the fixture must produce at least one finding",
  ).toBeGreaterThan(0);
  for (let index = 0; index < findingCount; index += 1) {
    const categoryText = (
      await findingButtons.nth(index).locator("strong").innerText()
    )
      .trim()
      .toLocaleLowerCase("en-US");
    expect(["added", "removed", "deviation", "shared"]).toContain(categoryText);
  }

  // --- Reach Save session / Export report with the keyboard ----------------
  // These sit earlier in the DOM (right under the workbench header) than the
  // toolbar and findings list below, so this must happen -- and the summary
  // must already be ready, or the disabled buttons are skipped entirely --
  // before tabbing forward into the findings list, since Tab only moves
  // forward and there is no going back to an earlier DOM position.
  await expect(page.getByRole("button", { name: "Save session" })).toBeEnabled({
    timeout: 20_000,
  });
  const saveFocus = await tabUntil(
    page,
    (s) => s.tag === "BUTTON" && s.text === "Save session",
    { label: '"Save session" button' },
  );
  assertVisibleOutline(saveFocus, "Save session button");
  const exportFocus = await tabUntil(
    page,
    (s) => s.tag === "BUTTON" && s.text === "Export report",
    { label: '"Export report" button' },
  );
  assertVisibleOutline(exportFocus, "Export report button");

  // --- Region selection with the keyboard, continuing forward from Export
  // report into the toolbar and then the findings list ----------------------
  const firstFinding = await tabUntil(page, (s) => s.inFindingsList, {
    label: "first finding button",
  });
  assertVisibleOutline(firstFinding, "first finding button");
  // Selecting it again with the keyboard (Enter) must keep it pressed --
  // proving the control is genuinely operable via keyboard, not just mouse.
  await page.keyboard.press("Enter");
  await expect(page.locator(".findings li button").nth(0)).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // --- Documented keyboard shortcuts: arrow keys select regions, but only
  // when focus is not on a form control -------------------------------------
  if (findingCount >= 2) {
    // Focused on a real form control (the cross-section slider): ArrowDown
    // must move the slider, not cycle the selected region.
    await page.locator('input[type="range"]').first().focus();
    const sliderValueBefore = await page
      .locator('input[type="range"]')
      .first()
      .inputValue();
    await page.keyboard.press("ArrowDown");
    const sliderValueAfter = await page
      .locator('input[type="range"]')
      .first()
      .inputValue();
    expect(sliderValueAfter).not.toBe(sliderValueBefore);
    await expect(page.locator(".findings li button").nth(0)).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Not focused on a form control: ArrowDown must cycle the selected
    // region.
    await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    );
    await page.keyboard.press("ArrowDown");
    await expect(page.locator(".findings li button").nth(1)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator(".findings li button").nth(0)).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  }

  // --- Contrast, spot-checked on the real rendered elements (in addition to
  // the token-level check above), in both themes -----------------------------
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);

    for (const swatch of [
      page.locator(".change-legend .legend-added"),
      page.locator(".change-legend .legend-removed"),
      page.locator(".change-legend .legend-deviation"),
      page.locator(".finding-cue").first(),
    ]) {
      const fg = await swatchColor(swatch);
      const bg = await compositedBackground(swatch, { fromParent: true });
      const ratio = contrastRatio(fg, bg);
      expect(
        ratio,
        `${theme} theme swatch contrast is only ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(3);
    }

    for (const text of [
      page.locator("#workbench-title"),
      page.locator(".findings li button strong").first(),
      page.locator(".findings li button small").first(),
      page.locator(".evidence-summary p"),
    ]) {
      const fg = await foregroundColor(text);
      const bg = await compositedBackground(text);
      const ratio = contrastRatio(fg, bg);
      expect(
        ratio,
        `${theme} theme text contrast is only ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  }
});

// ---------------------------------------------------------------------------
// Live regions: cancellation notice and a genuine, deterministic role="alert"
// failure surface (the session-open error banner reuses the exact
// `.comparison-error[role="alert"]` component the save/export failure
// banners in Workbench.tsx also render).
// ---------------------------------------------------------------------------

test("cancelling an in-flight comparison is keyboard reachable and announced via the live region", async ({
  page,
}) => {
  // A real single- or few-triangle comparison finishes before a click on
  // Cancel could ever be dispatched, and artificially slowing it down with
  // CPU throttling made the in-flight UI re-render too fast/unstable for
  // reliable interaction. Delaying the worker script's own network response
  // instead keeps the main thread completely unthrottled (so normal
  // keyboard interaction stays reliable) while deterministically holding
  // the run in its "starting" stage long enough to cancel it.
  await page.route("**/comparison.worker*.js", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await route.continue();
  });
  await page.goto("/compare/");
  await attachRichFixture(page);
  await page.getByRole("button", { name: "Validate and compare" }).click();

  const cancelButton = page.getByRole("button", { name: "Cancel comparison" });
  await expect(cancelButton).toBeVisible();
  // Clicking "Validate and compare" disables it (progress is now truthy),
  // which drops it from the tab order and leaves the just-clicked position
  // as the focus-navigation reference point; Cancel comparison renders as
  // its immediately preceding sibling, so it is reached with Shift+Tab, not
  // Tab. Real keyboard presses (not `.focus()`, which does not trigger
  // :focus-visible / a visible ring in Chromium) so the outline check below
  // reflects what a keyboard user actually sees.
  const cancelFocus = await tabUntil(
    page,
    (s) => s.text === "Cancel comparison",
    {
      label: "Cancel comparison button",
      key: "Shift+Tab",
    },
  );
  assertVisibleOutline(cancelFocus, "Cancel comparison button");
  await page.keyboard.press("Enter");

  await expect(page.locator(".comparison-status")).toHaveAttribute(
    "aria-live",
    "polite",
  );
  await expect(page.locator(".comparison-status")).toContainText(
    "Comparison cancelled.",
    {
      timeout: 10_000,
    },
  );
  // The page stays usable: comparison can still be started again afterward.
  await expect(
    page.getByRole("button", { name: "Validate and compare" }),
  ).toBeEnabled();
});

test("a session-open failure is announced via role=alert (the same pattern save/export failures reuse)", async ({
  page,
}) => {
  await page.goto("/compare/");
  await page.locator("#session-open-file").setInputFiles({
    name: "corrupt.voxelspy",
    mimeType: "application/zip",
    buffer: Buffer.from("this is not a valid VoxelSpy session archive"),
  });
  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("Session could not be opened");
});

// ---------------------------------------------------------------------------
// Reduced motion
// ---------------------------------------------------------------------------

test("reduced motion disables transitions and animations on interactive elements", async ({
  page,
}) => {
  // playwright.config.ts already sets reducedMotion: "reduce" for every
  // project, but this environment's Chromium does not consistently reflect
  // that context option in matchMedia() before the first navigation, so it
  // is applied explicitly here too to make this test self-reliant.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/compare/");
  const prefersReduced = await page.evaluate(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  expect(prefersReduced).toBe(true);

  async function assertNoMotion(locator: Locator, label: string) {
    const { transitionDuration, animationDuration } = await locator.evaluate(
      (el) => {
        const style = getComputedStyle(el);
        return {
          transitionDuration: style.transitionDuration,
          animationDuration: style.animationDuration,
        };
      },
    );
    const maxMs = (value: string) =>
      Math.max(
        0,
        ...value
          .split(",")
          .map((part) => part.trim())
          .map((part) =>
            part.endsWith("ms")
              ? Number.parseFloat(part)
              : Number.parseFloat(part) * 1000,
          ),
      );
    expect(
      maxMs(transitionDuration),
      `${label} has a non-zero transition-duration (${transitionDuration}) under reduced motion`,
    ).toBeLessThanOrEqual(1);
    expect(
      maxMs(animationDuration),
      `${label} has a non-zero animation-duration (${animationDuration}) under reduced motion`,
    ).toBeLessThanOrEqual(1);
  }

  await assertNoMotion(
    page.getByRole("button", { name: "Validate and compare" }),
    "Validate and compare button",
  );
  await assertNoMotion(
    page.locator(".source-card").nth(0).locator(".source-file"),
    "baseline file target",
  );
  await assertNoMotion(
    page.getByRole("link", { name: "VoxelSpy on GitHub" }),
    "GitHub link",
  );
  await assertNoMotion(
    page.getByRole("button", { name: /^Theme:/u }),
    "theme button",
  );

  await attachRichFixture(page);
  await page.getByRole("button", { name: "Validate and compare" }).click();
  await expect(
    page.getByRole("heading", { name: "Comparison workbench" }),
  ).toBeVisible({
    timeout: 20_000,
  });
  await assertNoMotion(
    page.locator(".findings li button").first(),
    "finding list button",
  );
  await assertNoMotion(
    page.getByRole("button", { name: "Reset camera" }),
    "reset camera button",
  );
});

// ---------------------------------------------------------------------------
// Touch targets (mobile project only)
// ---------------------------------------------------------------------------

test("primary controls meet the 44x44 CSS px touch target minimum", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-chromium",
    "touch targets are only asserted on the mobile project",
  );
  await page.goto("/compare/");

  async function assertMinimumHitArea(locator: Locator, label: string) {
    const box = await locator.boundingBox();
    expect(
      box,
      `${label} has no bounding box (not visible/rendered)`,
    ).not.toBeNull();
    expect(
      box!.width,
      `${label} width ${box!.width}px is below the 44px minimum`,
    ).toBeGreaterThanOrEqual(44);
    expect(
      box!.height,
      `${label} height ${box!.height}px is below the 44px minimum`,
    ).toBeGreaterThanOrEqual(44);
  }

  await assertMinimumHitArea(
    page.getByRole("button", { name: "Menu" }),
    "nav toggle",
  );
  await assertMinimumHitArea(
    page.getByRole("button", { name: /^Theme:/u }),
    "theme button",
  );
  await assertMinimumHitArea(
    page.locator(".source-card").nth(0).locator(".source-file"),
    "baseline file target",
  );
  await assertMinimumHitArea(
    page.locator(".source-card").nth(1).locator(".source-file"),
    "candidate file target",
  );
  await assertMinimumHitArea(
    page.locator(".session-open-input"),
    "session-open file target",
  );
  await assertMinimumHitArea(
    page.locator("#analysis-memory"),
    "analysis RAM slider",
  );

  await attachRichFixture(page);
  const validateButton = page.getByRole("button", {
    name: "Validate and compare",
  });
  await assertMinimumHitArea(validateButton, "Validate and compare button");
  await validateButton.click();
  await expect(
    page.getByRole("heading", { name: "Comparison workbench" }),
  ).toBeVisible({
    timeout: 20_000,
  });

  await assertMinimumHitArea(
    page.getByRole("button", { name: "Reset camera" }),
    "reset camera button",
  );
  await assertMinimumHitArea(
    page.getByRole("button", { name: "New comparison" }),
    "new comparison button",
  );
  await assertMinimumHitArea(
    page.locator(".workbench-toolbar input[type='range']"),
    "cross-section slider",
  );
  await expect(page.getByRole("button", { name: "Save session" })).toBeEnabled({
    timeout: 20_000,
  });
  await assertMinimumHitArea(
    page.getByRole("button", { name: "Save session" }),
    "Save session button",
  );
  await assertMinimumHitArea(
    page.getByRole("button", { name: "Export report" }),
    "Export report button",
  );
});
