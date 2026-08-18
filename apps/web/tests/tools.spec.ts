import { expect, test } from "@playwright/test";

test("the tools catalog lists the toolbox, links the available tools, and does not link planned ones", async ({
  page,
}) => {
  await page.goto("/tools/");

  await expect(
    page.getByRole("heading", { level: 1, name: "A toolbox for 3D geometry" }),
  ).toBeVisible();

  // Compare and Inspect are the two available tools today: real links into
  // /compare/ and /tools/inspect/. Matched by each card's own heading (not
  // `hasText`, which also matches Inspect's description mentioning "compare
  // against").
  const compareCard = page
    .locator("a.tool-card-available")
    .filter({ has: page.getByRole("heading", { level: 2, name: "Compare" }) });
  await expect(compareCard).toHaveCount(1);
  await expect(compareCard).toHaveAttribute("href", "/compare/");
  await expect(compareCard).toContainText("Available");

  await compareCard.click();
  await expect(page).toHaveURL(/\/compare\/$/u);

  await page.goto("/tools/");
  // Matched by its own heading (not `hasText`, which also matches File
  // Forensics' summary copy mentioning "Inspect a file's...").
  const inspectCard = page
    .locator("a.tool-card-available")
    .filter({ has: page.getByRole("heading", { level: 2, name: "Inspect" }) });
  await expect(inspectCard).toHaveCount(1);
  await expect(inspectCard).toHaveAttribute("href", "/tools/inspect/");
  await expect(inspectCard).toContainText("Available");

  await inspectCard.click();
  await expect(page).toHaveURL(/\/tools\/inspect\/$/u);
});

test("planned tools render as non-link cards with a text status, not just color", async ({
  page,
}) => {
  await page.goto("/tools/");

  const plannedCards = page.locator(".tool-card-planned");
  const plannedCount = await plannedCards.count();
  expect(
    plannedCount,
    "the seeded catalog must list more than one planned tool",
  ).toBeGreaterThan(1);

  for (let index = 0; index < plannedCount; index += 1) {
    const card = plannedCards.nth(index);
    // A planned card must not itself be (or contain) a link -- it must not
    // look clickable-but-broken.
    await expect(card.locator("a")).toHaveCount(0);
    const tag = await card.evaluate((el) => el.tagName);
    expect(tag).not.toBe("A");
    await expect(card).toContainText("Planned");
    await expect(card).toContainText("not built yet");
  }

  // Inspect specifically is no longer planned -- it is a real, linked tool
  // now (see tests/inspect.spec.ts for its own coverage) -- so it must not
  // appear among the planned cards.
  const inspectPlannedCard = page
    .locator(".tool-card-planned")
    .filter({ has: page.getByRole("heading", { level: 2, name: "Inspect" }) });
  await expect(inspectPlannedCard).toHaveCount(0);
});

test("the primary navigation reads Tools / Compare / Docs, with Home reachable via the brand lockup", async ({
  page,
}) => {
  // The primary nav is hidden behind a closed hamburger menu below the
  // 850px breakpoint (see accessibility.spec.ts); a fixed desktop-sized
  // viewport keeps this test's role-based queries meaningful under both the
  // desktop and mobile Playwright projects.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");

  const nav = page.locator('nav[aria-label="Primary navigation"]');
  await expect(nav.getByRole("link", { name: "Tools" })).toHaveAttribute(
    "href",
    "/tools/",
  );
  await expect(nav.getByRole("link", { name: "Compare" })).toHaveAttribute(
    "href",
    "/compare/",
  );
  await expect(nav.getByRole("link", { name: "Docs" })).toHaveAttribute(
    "href",
    "/docs/",
  );
  await expect(
    nav.getByRole("link", { name: "Home", exact: true }),
  ).toHaveCount(0);

  await expect(
    page.getByRole("link", { name: "VoxelSpy home" }),
  ).toHaveAttribute("href", "/");

  await nav.getByRole("link", { name: "Tools" }).click();
  await expect(page).toHaveURL(/\/tools\/$/u);
  await expect(
    page.getByRole("heading", { level: 1, name: "A toolbox for 3D geometry" }),
  ).toBeVisible();
});
