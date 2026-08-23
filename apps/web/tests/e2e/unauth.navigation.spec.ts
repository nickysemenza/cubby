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

    // The bar optimistically shows the authed tabs while the session is still
    // pending, then swaps to the minimal public navbar once the session
    // resolves to "signed out". Wait for the public "Sign In" affordance so we
    // assert against the resolved (signed-out) state, not the optimistic one —
    // this is the race the previous "expect Inventory" assertion tripped on.
    const signIn = bottomNav.getByRole("link", { name: "Sign In" });
    await expect(signIn).toBeVisible({ timeout: 15000 });

    // Public links are present; authed-only entities (e.g. Inventory) are not.
    await expect(bottomNav.getByRole("link", { name: "Home" })).toBeVisible();
    await expect(
      bottomNav.getByRole("link", { name: "Inventory" }),
    ).toHaveCount(0);

    // The sign-in link lands on the sign-in page.
    await signIn.click();
    await page.waitForURL(/\/auth\/sign-in/, { timeout: 30000 });
  });
});
