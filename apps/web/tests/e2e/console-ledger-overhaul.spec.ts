import { expect, test } from "./e2e-test";
import { gotoAuthenticatedPage } from "./e2e-helpers";

test("desktop workspace sidebar marks the current page and collapses", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoAuthenticatedPage(page, "/");

  const sidebar = page.getByRole("complementary", {
    name: "Workspace navigation",
  });
  await expect(sidebar).toBeVisible();
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(176);
  await expect(
    page.getByRole("link", { name: "Home", exact: true }),
  ).toHaveAttribute("aria-current", "page");

  // A folded domain section hides its routes and stays folded across reloads.
  const cook = sidebar.getByRole("button", { name: "Cook", exact: true });
  await expect(cook).toHaveAttribute("aria-expanded", "true");
  const recipes = sidebar.getByRole("link", { name: /^Recipes\b/ });
  await expect(recipes).toBeVisible();
  await cook.click();
  await expect(cook).toHaveAttribute("aria-expanded", "false");
  await expect(recipes).toBeHidden();
  await page.reload();
  await expect(
    sidebar.getByRole("button", { name: "Cook", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  await sidebar.getByRole("button", { name: "Cook", exact: true }).click();
  await expect(recipes).toBeVisible();

  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(40);
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toBeHidden();
});
