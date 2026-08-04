import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const staticRoutes = [
  {
    path: "/",
    title: "VoxelSpy — Compare 3D models privately",
    heading: "See what changed",
  },
  {
    path: "/tools/",
    title: "Tools — VoxelSpy",
    heading: "Start with the models",
  },
  {
    path: "/docs/",
    title: "Documentation — VoxelSpy",
    heading: "Know what the result means",
  },
  {
    path: "/docs/getting-started/",
    title: "Getting started — VoxelSpy Docs",
    heading: "Getting started",
  },
  {
    path: "/docs/privacy/",
    title: "Privacy by default — VoxelSpy Docs",
    heading: "Privacy by default",
  },
  {
    path: "/docs/geometry-contract/",
    title: "Geometry contract — VoxelSpy Docs",
    heading: "Geometry contract",
  },
  {
    path: "/docs/brand/",
    title: "Brand assets — VoxelSpy Docs",
    heading: "Brand assets",
  },
] as const;

for (const route of staticRoutes) {
  test(`${route.path} serves matching prerendered HTML before hydration`, async ({
    browser,
    page,
    request,
  }) => {
    const response = await request.get(route.path);
    expect(response.status()).toBe(200);
    const html = await response.text();
    expect(html).toContain(`<title>${route.title}</title>`);
    expect(html).toContain(route.heading);

    const noScriptContext = await browser.newContext({
      javaScriptEnabled: false,
    });
    const noScriptPage = await noScriptContext.newPage();
    await noScriptPage.goto(route.path);
    await expect(noScriptPage).toHaveTitle(route.title);
    await expect(noScriptPage.getByRole("heading", { level: 1 })).toContainText(
      route.heading,
    );
    await noScriptContext.close();

    const hydrationErrors: string[] = [];
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        /hydration|did not match|#418/iu.test(message.text())
      ) {
        hydrationErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => hydrationErrors.push(error.message));
    await page.goto(route.path);
    await page.waitForLoadState("networkidle");
    expect(hydrationErrors).toEqual([]);
    const nonCanonicalLinks = await page
      .locator('a[href^="/"]')
      .evaluateAll((links) =>
        links
          .map((link) => link.getAttribute("href") ?? "")
          .filter((href) => {
            const pathname = new URL(href, location.origin).pathname;
            return pathname !== "/" && !pathname.endsWith("/");
          }),
      );
    expect(nonCanonicalLinks).toEqual([]);
  });
}

test("home is responsive, local-first, and keyboard reachable", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "See what changed",
  );
  await expect(page.getByText("Private by default")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.locator(".skip-link")).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: /menu/i })).toBeVisible();
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
});

test("deep links arrive as prerendered routes and search stays local", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto("/docs/privacy/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Privacy by default",
  );
  await page.goto("/docs/");
  await page.getByLabel("Search documentation").fill("units");
  await expect(page.locator(".search-results")).toContainText(
    "Preserve source meaning",
  );
  expect(
    requests.every((url) => url.startsWith("http://127.0.0.1")),
  ).toBeTruthy();
});

test("search anchors leave the target heading below the sticky header", async ({
  page,
}) => {
  await page.goto("/docs/");
  await page.getByLabel("Search documentation").fill("units");
  await page.getByRole("link", { name: /Preserve source meaning/iu }).click();
  await expect(page).toHaveURL(/\/docs\/geometry-contract\/#preserve-source$/u);
  const target = page.getByRole("heading", {
    level: 2,
    name: "Preserve source meaning",
  });
  await expect(target).toBeVisible();
  await expect
    .poll(() =>
      target.evaluate((heading) => {
        const header = document.querySelector(".site-header");
        if (!(header instanceof HTMLElement)) return false;
        const top = heading.getBoundingClientRect().top;
        return (
          top >= header.getBoundingClientRect().bottom && top < innerHeight
        );
      }),
    )
    .toBe(true);
});

test("theme preference persists without hiding system mode", async ({
  page,
}) => {
  await page.goto("/");
  const theme = page.getByRole("button", { name: /^Theme:/ });
  await expect(theme).toHaveAttribute("aria-label", /Theme: system/);
  await theme.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme-preference",
    "light",
  );
});

test("local file selection exposes readiness without uploading", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto("/tools/");
  await page.locator("#tool-baseline").setInputFiles({
    name: "baseline.stl",
    mimeType: "model/stl",
    buffer: Buffer.from("solid baseline"),
  });
  await page.locator("#tool-candidate").setInputFiles({
    name: "candidate.stl",
    mimeType: "model/stl",
    buffer: Buffer.from("solid candidate"),
  });
  await expect(page.getByText("Both models ready")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Prepare comparison" }),
  ).toBeEnabled();
  expect(
    requests.every((url) => url.startsWith("http://127.0.0.1")),
  ).toBeTruthy();
});

test("dark brand specimens pass automated accessibility checks", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("voxelspy-theme", "dark"),
  );
  await page.goto("/docs/brand/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".specimen--small svg")).toHaveCount(3);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

for (const route of [
  "/",
  "/tools/",
  "/docs/",
  "/docs/getting-started/",
  "/docs/brand/",
]) {
  test(`${route} has no automatically detectable accessibility violations`, async ({
    page,
  }) => {
    await page.goto(route);
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
}
