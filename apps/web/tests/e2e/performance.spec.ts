import { expect, test } from "./e2e-test";
import { gotoAuthenticatedPage } from "./e2e-helpers";

test("intent-preloaded navigation does not flash the route skeleton", async ({
  page,
}) => {
  await gotoAuthenticatedPage(page, "/");
  const locations = page
    .getByRole("region", { name: "Pantry", exact: true })
    .getByRole("link", { name: /^Locations(?: [\d,]+ records)?$/ });
  await locations.hover();
  await page.waitForTimeout(75);
  await locations.click();
  await expect(page.locator('main [data-slot="skeleton"]')).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Locations" })).toBeVisible();
});
