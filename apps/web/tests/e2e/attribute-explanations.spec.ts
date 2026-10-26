import { createFixtureGraph } from "./fixtures/core";
import {
  gotoAuthenticatedPage,
  inlineExplanation,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

test.setTimeout(60_000);

// The detail must retain a known location alongside the partial-gap caption,
// and nested ownership evidence must remain inspectable.
test("product location detail preserves its partial gap and nested ownership evidence", async ({
  page,
}) => {
  const name = `Synthetic location context ${Date.now()}`;
  const { product, location } = await createFixtureGraph(
    page,
    async (create) => {
      const product = await create("product", {
        name,
        stockTracked: false,
      });
      const location = await create("location", {
        name: `${name} shelf`,
        type: "room",
        parentId: null,
      });
      await create("expense", {
        name: `${name} acquisition`,
        productId: product.id,
        cost: 12,
        productQuantity: 3,
        future: false,
        trade: "other",
        costType: "materials",
      });
      await create("inventory", {
        productId: product.id,
        locationId: location.id,
        amount: { value: 2, unit: "each" },
      });
      return { product, location };
    },
  );
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
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByText("1 expected item unlocated", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Stocked at", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(`a[href="/locations/${location.id}"]:visible`).first(),
  ).toBeVisible();
  const ownerControl = page
    .getByRole("button", { name: "How owner is determined", exact: true })
    .first();
  await ownerControl.click();
  const ownerPanel = await inlineExplanation(page, ownerControl);
  await ownerPanel
    .getByRole("button")
    .filter({ hasText: `${name} shelf` })
    .click();
  await ownerPanel
    .getByText("Inputs and source settings", { exact: true })
    .click();
  const beneficiaries = page.getByRole("button", {
    name: "How beneficiaries is determined",
    exact: true,
  });
  await expect(beneficiaries).toBeVisible();
  await beneficiaries.click();
  const sourceExplanation = await inlineExplanation(page, beneficiaries);
  await expect(
    sourceExplanation.getByRole("heading", {
      name: "Why this value · Beneficiaries",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    sourceExplanation.getByText("Technical details", { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    sourceExplanation.getByRole("button", { name: "Retry explanation" }),
  ).toHaveCount(0);
});
