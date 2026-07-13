import { expect, test } from "@playwright/test";

test.describe("iPhone WebKit smoke", () => {
  test("navigates inventory, recipes, and forms with usable touch targets", async ({
    page,
  }) => {
    for (const path of [
      "/inventory/session",
      "/recipes",
      "/recipes/new",
      "/products/new",
    ]) {
      // Wait through TanStack Start hydration before starting the next direct
      // navigation; WebKit can otherwise race its same-URL hydration replace.
      await page.goto(path, { waitUntil: "networkidle" });
      await expect(page.locator("body")).not.toContainText(
        "Internal Server Error",
      );
    }

    const targets = page.locator(
      '[data-slot="button"]:visible, [data-slot="input"]:visible, [data-slot="tabs-trigger"]:visible, [role="option"]:visible, [role="menuitem"]:visible',
    );
    for (let index = 0; index < (await targets.count()); index += 1) {
      const box = await targets.nth(index).boundingBox();
      if (!box) continue;
      expect
        .soft(box.width, `target ${index} width`)
        .toBeGreaterThanOrEqual(44);
      expect
        .soft(box.height, `target ${index} height`)
        .toBeGreaterThanOrEqual(44);
    }
  });

  test("offline fallback remains usable on iPhone", async ({ page }) => {
    await page.goto("/offline.html");
    await expect(
      page.getByRole("heading", { name: "You're offline" }),
    ).toBeVisible();
    const retry = page.getByRole("button", { name: "Try again" });
    await expect(retry).toBeVisible();
    const box = await retry.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  });
});
