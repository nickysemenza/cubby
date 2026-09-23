import { expect, test } from "./e2e-test";
import { gotoAuthenticatedPage } from "./e2e-helpers";

test("phone workspace shell replaces the sidebar with bottom navigation", async ({
  page,
}) => {
  await gotoAuthenticatedPage(page, "/");
  await expect(
    page.getByRole("complementary", { name: "Workspace navigation" }),
  ).toBeHidden();
  const bottomNav = page.getByRole("navigation", { name: "Main navigation" });
  await expect(bottomNav).toBeVisible();
  await expect(
    bottomNav.getByRole("link", { name: "Inventory", exact: true }),
  ).toBeVisible();
});
