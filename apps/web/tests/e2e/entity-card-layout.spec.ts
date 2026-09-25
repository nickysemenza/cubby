import {
  seedConcurrently,
  seedCookbookSourcePrerequisite,
  seedPlantPrerequisite,
  seedProductCategoryPrerequisite,
  seedProductPrerequisite,
} from "./e2e-fixtures";
import { expectViewportBounded, gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

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

  await gotoAuthenticatedPage(page, `/plants/${plant.id}`);
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

test("card density adapts to the work surface and stays temporary through filtering", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const name = `Card layout ${Date.now()}`;
  await seedConcurrently(
    Array.from({ length: 12 }, (_, index) => index),
    (index) =>
      seedProductPrerequisite(page, {
        name: `${name} ${index === 0 ? "Long handled precision workshop tool with an unusually descriptive name" : index}`,
        manufacturer: "Example maker",
      }),
  );
  await gotoAuthenticatedPage(
    page,
    `/products?name=${encodeURIComponent(name)}`,
  );
  await page.getByRole("button", { name: "Cards view", exact: true }).click();
  const grid = page.getByTestId("entity-card-grid");
  await expect(grid).toHaveAttribute("data-compact", "false");
  await expect(grid.locator(":scope > *")).toHaveCount(12);
  const standardWidth = await grid
    .locator(":scope > *")
    .first()
    .evaluate((el) => el.getBoundingClientRect().width);
  await page.screenshot({ path: testInfo.outputPath("desktop-cards.png") });

  await page.getByRole("button", { name: "Compact view", exact: true }).click();
  await expect(grid).toHaveAttribute("data-compact", "true");
  const compactWidth = await grid
    .locator(":scope > *")
    .first()
    .evaluate((el) => el.getBoundingClientRect().width);
  expect(compactWidth).toBeLessThan(standardWidth * 0.7);
  expect(new URL(page.url()).searchParams.get("view")).toBe("shelf");
  expect(new URL(page.url()).searchParams.has("density")).toBe(false);
  const firstCard = grid.getByRole("link", {
    name: `${name} Long handled precision workshop tool with an unusually descriptive name`,
    exact: true,
  });
  await firstCard.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("complementary", { name: "Product inspector" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("complementary", { name: "Product inspector" })
      .getByRole("heading", {
        name: `${name} Long handled precision workshop tool with an unusually descriptive name`,
        exact: true,
      }),
  ).toBeVisible();
  await expectViewportBounded(page);
  await page.screenshot({
    path: testInfo.outputPath("desktop-compact-inspector.png"),
  });
  await page
    .getByRole("button", { name: "Close inspector", exact: true })
    .first()
    .click();
  await page
    .getByRole("textbox", { name: "Search products or shortcode", exact: true })
    // The shared fixture prefix is deliberately fuzzy-matchable across the
    // roster. Search distinctive words to prove the server narrows the cards.
    .fill("precision workshop tool");
  await expect(grid.locator(":scope > *")).toHaveCount(1);
  await expect(grid).toHaveAttribute("data-compact", "true");
  await expectViewportBounded(page);
  await page.screenshot({ path: testInfo.outputPath("desktop-compact.png") });

  await page.reload();
  await expect(grid).toHaveAttribute("data-compact", "false");
});

test("complete-list cookbooks keep local search across card and list presentations", async ({
  page,
}) => {
  const name = `Cookbook cards ${Date.now()}`;
  const first = await seedCookbookSourcePrerequisite(page, `${name} Roasting`);
  await seedCookbookSourcePrerequisite(page, `${name} Baking`);
  await gotoAuthenticatedPage(
    page,
    `/cookbooks?view=shelf&searchQuery=${encodeURIComponent(name)}`,
  );
  const grid = page.getByTestId("entity-card-grid");
  await expect(grid.locator(":scope > *")).toHaveCount(2);
  await page.getByRole("button", { name: "Compact view", exact: true }).click();
  await page
    .getByRole("textbox", {
      name: "Search cookbooks or shortcode",
      exact: true,
    })
    .fill(`${name} Roasting`);
  await expect(grid.locator(":scope > *")).toHaveCount(1);
  await expect(grid).toHaveAttribute("data-compact", "true");
  await expect(
    grid.getByRole("link", { name: `${name} Roasting`, exact: true }),
  ).toHaveAttribute("href", `/cookbooks/${first.id}`);
  await page.getByRole("button", { name: "List view", exact: true }).click();
  await expect(
    page.getByRole("table", { name: "Cookbooks table" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: `${name} Baking`, exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: `${name} Roasting`, exact: true }),
  ).toBeVisible();
});
