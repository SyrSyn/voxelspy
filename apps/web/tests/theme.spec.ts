import { expect, test } from "@playwright/test";

test("System follows OS changes while explicit choices stay fixed", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/tools/");
  const root = page.locator("html");
  const button = page.getByRole("button", { name: /^Theme:/ });
  await expect(button).toHaveAccessibleName("Theme: system. Change to light.");
  await expect(root).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(root).toHaveAttribute("data-theme", "dark");
  await button.click();
  await expect(root).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "light" });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(root).toHaveAttribute("data-theme", "light");
  await button.click();
  await expect(root).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(root).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(button).toHaveAccessibleName("Theme: dark. Change to system.");
  await expect(root).toHaveAttribute("data-theme", "dark");
  await button.click();
  await expect(root).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("voxelspy-theme")))
    .toBeNull();
});

test("theme controls remain usable when browser storage is blocked", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    for (const method of ["getItem", "setItem", "removeItem"]) {
      Object.defineProperty(Storage.prototype, method, {
        configurable: true,
        value: () => {
          throw new DOMException("Storage blocked", "SecurityError");
        },
      });
    }
  });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/tools/");
  const button = page.getByRole("button", { name: /^Theme:/ });
  const root = page.locator("html");
  await expect(button).toHaveAccessibleName("Theme: system. Change to light.");
  await expect(root).toHaveAttribute("data-theme", "light");
  for (const choice of ["light", "dark", "system"]) {
    await button.click();
    await expect(root).toHaveAttribute("data-theme-preference", choice);
    await expect(root).toHaveAttribute(
      "data-theme",
      choice === "system" ? "light" : choice,
    );
  }
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(root).toHaveAttribute("data-theme", "dark");
  expect(errors).toEqual([]);
});
