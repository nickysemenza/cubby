import { seedInventoryPrerequisites } from "./e2e-fixtures";
import { expectViewportBounded, gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

async function seedProductWithRelationship(
  page: Parameters<typeof seedInventoryPrerequisites>[0],
  locationName: string,
  productName: string,
) {
  const { products } = await seedInventoryPrerequisites(page, {
    locationName,
    products: [
      {
        name: productName,
        quantity: 2,
        unit: "each",
      },
    ],
  });
  const product = products[0];
  if (!product) throw new Error("Visual fixture did not create a product");
  return product;
}

test("Porcelain desktop Products workbench remains visually stable", async ({
  page,
}) => {
  await seedProductWithRelationship(
    page,
    "Porcelain visual desktop shelf",
    "Porcelain visual desktop product",
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoAuthenticatedPage(
    page,
    "/products?name=Porcelain%20visual%20desktop%20product",
  );
  const table = page.getByRole("table", { name: "Products table" });
  await expect(table).toBeVisible({ timeout: 15000 });
  await expectViewportBounded(page);

  await expect(page).toHaveScreenshot(
    "porcelain-products-workbench-desktop.png",
    {
      animations: "disabled",
      caret: "hide",
    },
  );
});

test("Porcelain phone Products roster remains visually stable", async ({
  page,
}) => {
  await seedProductWithRelationship(
    page,
    "Porcelain visual phone roster shelf",
    "Porcelain visual phone roster product",
  );
  await page.setViewportSize({ width: 430, height: 932 });
  await gotoAuthenticatedPage(
    page,
    "/products?name=Porcelain%20visual%20phone%20roster%20product",
  );
  const roster = page.getByRole("list", { name: "Products list" });
  await expect(roster).toBeVisible({ timeout: 15000 });
  await expectViewportBounded(page);

  await expect(page).toHaveScreenshot("porcelain-products-roster-phone.png", {
    animations: "disabled",
    caret: "hide",
  });
});

test("Porcelain phone Product detail keeps its relationship journey visible", async ({
  page,
}) => {
  const product = await seedProductWithRelationship(
    page,
    "Porcelain visual phone detail shelf",
    "Porcelain visual phone detail product",
  );
  await page.setViewportSize({ width: 430, height: 932 });
  await gotoAuthenticatedPage(page, `/products/${product.id}`);
  await expect(
    page.getByRole("heading", { level: 2, name: "Relationships" }),
  ).toBeVisible({ timeout: 15000 });
  await expectViewportBounded(page);

  await expect(page).toHaveScreenshot(
    "porcelain-product-detail-relationships-phone.png",
    {
      animations: "disabled",
      caret: "hide",
      // Shortcodes vary between isolated databases; keep record identifiers
      // out of the committed image while asserting the visible relationship UI.
      mask: [page.getByText(product.id, { exact: true })],
    },
  );
});
