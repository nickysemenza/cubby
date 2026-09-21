import { seedProductPrerequisite } from "./e2e-fixtures";
import { expectViewportBounded, gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

test("phone cards and compact tiles remain navigable within the viewport", async ({
  page,
}, testInfo) => {
  const name = `Phone cards ${Date.now()}`;
  for (let index = 0; index < 3; index++) {
    await seedProductPrerequisite(page, { name: `${name} ${index}` });
  }
  await gotoAuthenticatedPage(
    page,
    `/products?view=shelf&name=${encodeURIComponent(name)}`,
  );
  const grid = page.getByTestId("entity-card-grid");
  await expect(grid.locator(":scope > *")).toHaveCount(3);
  await expectViewportBounded(page);
  await page.screenshot({ path: testInfo.outputPath("webkit-cards.png") });
  await page
    .getByRole("button", { name: "Products view: Cards", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Compact", exact: true }).click();
  await expect(grid).toHaveAttribute("data-compact", "true");
  await expectViewportBounded(page);
  await page.screenshot({
    path: testInfo.outputPath("webkit-compact.png"),
    animations: "disabled",
  });
  await grid.getByRole("link", { name: `${name} 0`, exact: true }).click();
  await expect(page).toHaveURL(/\/products\/PRD-/);
  await expect(
    page.getByRole("heading", { name: `${name} 0`, exact: true }),
  ).toBeVisible();
});
