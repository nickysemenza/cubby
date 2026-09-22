import { seedConcurrently, seedProductPrerequisite } from "./e2e-fixtures";
import { expectViewportBounded, gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("phone cards and compact tiles remain navigable within the viewport", async ({
  page,
}, testInfo) => {
  const name = `Phone cards ${Date.now()}`;
  // A long name proves a compact tile wraps instead of widening the page.
  const longName = `${name} 0 Long handled precision workshop tool with an unusually descriptive name`;
  await seedConcurrently([longName, `${name} 1`, `${name} 2`], (productName) =>
    seedProductPrerequisite(page, { name: productName }),
  );
  await gotoAuthenticatedPage(
    page,
    `/products?view=shelf&name=${encodeURIComponent(name)}`,
  );
  const grid = page.getByTestId("entity-card-grid");
  await expect(grid.locator(":scope > *")).toHaveCount(3);
  await expectViewportBounded(page);
  await page.screenshot({ path: testInfo.outputPath("phone-cards.png") });
  await page
    .getByRole("button", { name: "Products view: Cards", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Compact", exact: true }).click();
  await expect(grid).toHaveAttribute("data-compact", "true");
  await expectViewportBounded(page);
  await page.screenshot({
    path: testInfo.outputPath("phone-compact.png"),
    animations: "disabled",
  });
  await grid.getByRole("link", { name: longName, exact: true }).click();
  await expect(page).toHaveURL(/\/products\/PRD-/);
  await expect(
    page.getByRole("heading", { name: longName, exact: true }),
  ).toBeVisible();
});
