import { expectViewportBounded, gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("display settings stay operable inside the phone viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await gotoAuthenticatedPage(page, "/products");
  await page.getByRole("button", { name: "Display" }).click();

  const settings = page.getByRole("dialog", { name: "Display settings" });
  await expect(settings).toBeInViewport();
  const priceRow = settings.locator('[data-column-id="price"]');
  await priceRow.scrollIntoViewIfNeeded();
  await priceRow.getByRole("button", { name: "Actions for Price" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Hide Price" }),
  ).toBeInViewport();
  await expectViewportBounded(page);
});
