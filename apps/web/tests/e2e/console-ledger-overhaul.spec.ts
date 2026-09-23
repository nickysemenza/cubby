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
  await expect(
    page.getByRole("link", { name: "Home", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(56);
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toBeHidden();
});
