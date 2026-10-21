import { chooseListView } from "./support/e2e-helpers";
import {
  seedPlantPrerequisite,
  seedProductCategoryPrerequisite,
  seedProductPrerequisite,
} from "./fixtures/catalog";
import { seedCookbookSourcePrerequisite } from "./fixtures/recipes";
import { gotoAuthenticatedPage } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

test("product category and identifiers stay readable in cards and a plant's related table", async ({
  page,
}) => {
  const suffix = Date.now();
  const productName = `E2E seed packet ${suffix}`;
  const categoryName = `E2E garden supplies ${suffix}`;
  const plant = await seedPlantPrerequisite(page, `E2E crop ${suffix}`);
  const category = await seedProductCategoryPrerequisite(page, {
    name: categoryName,
  });
  await seedProductPrerequisite(page, {
    name: productName,
    categoryId: category.id,
    growsPlantId: plant.id,
    externalIds: [
      {
        source: "example-vendor",
        kind: "retailer_sku",
        externalId: `SEED-${suffix}`,
      },
    ],
  });

  await gotoAuthenticatedPage(
    page,
    `/products?name=${encodeURIComponent(productName)}&view=shelf`,
  );
  const card = page
    .getByRole("link", { name: productName, exact: true })
    .locator("xpath=ancestor::*[@data-entity-card]");
  await expect(card.getByText(categoryName)).toBeVisible();
  await expect(card.locator("pre")).toHaveCount(0);

  await gotoAuthenticatedPage(page, `/plants/${plant.id}#work`);
  const row = page
    .locator("#products")
    .getByRole("link", { name: productName, exact: true })
    .locator("xpath=ancestor::tr");
  await expect(row).toContainText(categoryName);
  await expect(row).toContainText("example-vendor");
  await expect(row).not.toContainText('"externalId"');
  await expect(row.locator("pre")).toHaveCount(0);
  expect((await row.boundingBox())?.height).toBeLessThan(100);
});

test("cookbooks keep server search across card and list presentations", async ({
  page,
}) => {
  const name = `Cookbook cards ${Date.now()}`;
  const first = await seedCookbookSourcePrerequisite(page, `${name} Roasting`);
  const second = await seedCookbookSourcePrerequisite(page, `${name} Baking`);
  // Shared worker data can legitimately fuzzy-match this query. Put an
  // alphabetically earlier neighbor behind the two relevant prefix matches.
  await seedCookbookSourcePrerequisite(
    page,
    `A photo cookbook ${Date.now() - 60_000}`,
  );
  await gotoAuthenticatedPage(
    page,
    `/cookbooks?view=shelf&searchQuery=${encodeURIComponent(name)}`,
  );
  const grid = page.getByTestId("entity-card-grid");
  const cards = grid.locator(":scope > *");
  await expect(cards.nth(0)).toContainText(name);
  await expect(cards.nth(1)).toContainText(name);
  await expect(
    grid.getByRole("link", { name: `${name} Roasting`, exact: true }),
  ).toHaveAttribute("href", `/cookbooks/${first.id}`);
  await expect(
    grid.getByRole("link", { name: `${name} Baking`, exact: true }),
  ).toHaveAttribute("href", `/cookbooks/${second.id}`);
  await expect(
    page.getByRole("textbox", {
      name: "Search cookbooks or shortcode",
      exact: true,
    }),
  ).toHaveValue(name);
  await chooseListView(page, "Compact");
  await page
    .getByRole("textbox", {
      name: "Search cookbooks or shortcode",
      exact: true,
    })
    .fill(`${name} Roasting`);
  // The shared lexical search ranks rather than filters by substring: the
  // near-identical "Baking" title may still match, but below "Roasting".
  await expect(grid).toHaveAttribute("data-compact", "true");
  await expect(
    grid
      .locator(":scope > *")
      .first()
      .getByRole("link", { name: `${name} Roasting`, exact: true }),
  ).toHaveAttribute("href", `/cookbooks/${first.id}`);
  await chooseListView(page, "List");
  await expect(
    page.getByRole("table", { name: "Cookbooks table" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("table", { name: "Cookbooks table" })
      .getByRole("row")
      .nth(1)
      .getByRole("link", { name: `${name} Roasting`, exact: true }),
  ).toBeVisible();
});
