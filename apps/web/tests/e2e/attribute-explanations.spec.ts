import { createEntityFixture } from "./fixtures-core";
import { seedLocationPrerequisite } from "./fixtures-catalog";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

// A partial location must survive its discrepancy caption; list and detail
// explanations use the same recorded policy and quantity evidence.
test("product location context preserves links and explains the same partial gap on detail", async ({
  page,
}) => {
  const name = `Synthetic location context ${Date.now()}`;
  const product = await createEntityFixture(page, "product", {
    name,
    stockTracked: false,
  });
  const location = await seedLocationPrerequisite(page, `${name} shelf`);
  await createEntityFixture(page, "expense", {
    name: `${name} acquisition`,
    productId: product.id,
    cost: 12,
    productQuantity: 3,
    future: false,
    trade: "other",
    costType: "materials",
  });
  await createEntityFixture(page, "inventory", {
    productId: product.id,
    locationId: location.id,
    amount: { value: 2, unit: "each" },
  });
  await gotoAuthenticatedPage(page, `/products?q=${encodeURIComponent(name)}`);
  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row).toContainText("1 expected item unlocated");
  await expect(row).toContainText("Owner unknown");
  await expect(
    row.locator(`a[href="/locations/${location.id}"]`).first(),
  ).toBeVisible();
  await row.hover();
  await row
    .getByRole("button", { name: "How locations is determined", exact: true })
    .click();
  const explanation = page.locator('[data-slot="popover-content"]:visible');
  await expect(explanation).toContainText("Stock not tracked");
  await expect(explanation).toContainText("1 expected item unlocated");
  await page.keyboard.press("Escape");
  await gotoAuthenticatedPage(
    page,
    `/products/${product.id}#stocked-at`,
    page.getByRole("button", {
      name: "How inventory status is determined",
      exact: true,
    }),
  );
  await page
    .getByRole("button", {
      name: "How inventory status is determined",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("Stock not tracked", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("1 expected item unlocated", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Stocked at", exact: true }),
  ).toBeVisible();
});
