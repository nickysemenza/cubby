import { expect, test } from "./e2e-test";
import { waitForAppHydration } from "./e2e-helpers";

test("intent-preloaded navigation does not flash the route skeleton", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForAppHydration(page);
  const locations = page.getByRole("link", { name: "Locations", exact: true });
  await locations.hover();
  await page.waitForTimeout(75);
  await locations.click();
  await expect(page.locator('main [data-slot="skeleton"]')).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Locations" })).toBeVisible();
});
