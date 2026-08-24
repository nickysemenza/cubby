import { expect, test } from "./e2e-test";

test.describe("Main navigation", () => {
  test("mobile bottom nav shows the public navbar when signed out", async ({
    page,
  }) => {
    // Mobile viewport first so the page renders the (md:hidden) bottom nav from
    // the start.
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const bottomNav = page.getByRole("navigation", { name: "Main navigation" });
    await expect(bottomNav).toBeVisible();

    const signIn = bottomNav.getByRole("link", { name: "Sign In" });
    await expect(signIn).toBeVisible({ timeout: 15000 });

    await expect(bottomNav.getByRole("link", { name: "Home" })).toBeVisible();
    await expect(
      bottomNav.getByRole("link", { name: "Inventory" }),
    ).toHaveCount(0);

    await signIn.click();
    await page.waitForURL(/\/auth\/sign-in/, { timeout: 30000 });
  });
});
