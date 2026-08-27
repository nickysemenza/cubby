import type { Page } from "@playwright/test";
import { seedInventoryPrerequisites } from "./e2e-fixtures";
import { expectViewportBounded, gotoAuthenticatedPage } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

// Goldens must describe one deterministic first attempt. A retry would collide
// with the fixed fixture names and could bless a duplicate-row state.
test.describe.configure({ retries: 0 });

async function seedProductWithRelationship(
  page: Parameters<typeof seedInventoryPrerequisites>[0],
  locationName: string,
  productName: string,
) {
  const { products } = await seedInventoryPrerequisites(page, {
    locationName,
    products: [{ name: productName, quantity: 2, unit: "each" }],
  });
  const product = products[0];
  if (!product) throw new Error("Visual fixture did not create a product");
  return product;
}

async function expectCleanVisualState(page: Page) {
  const relationshipError = page.getByRole("region", {
    name: "Relationship route error",
  });
  if (await relationshipError.isVisible().catch(() => false)) {
    // The hermetic PGlite socket can reject one request while the detail
    // page's independent reads settle. Exercise the shipped recovery control
    // once, then still require the visual state to be genuinely clean.
    await relationshipError.getByRole("button", { name: "Retry" }).click();
    await expect(relationshipError).toHaveCount(0);
  }
  await expect(
    page.getByText("The operation could not be completed", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Other relationships could not be loaded.", { exact: true }),
  ).toHaveCount(0);
}

function nondeterministicMasks(page: Page) {
  return [
    page.getByTestId("problems-badge"),
    page.getByTestId("build-metadata"),
  ];
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
  await page.waitForLoadState("networkidle");
  await expectCleanVisualState(page);

  await expect(page).toHaveScreenshot(
    "porcelain-products-workbench-desktop.png",
    {
      animations: "disabled",
      caret: "hide",
      mask: nondeterministicMasks(page),
      maskColor: "#e7ebf1",
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
  await page.waitForLoadState("networkidle");
  await expectCleanVisualState(page);

  await expect(page).toHaveScreenshot("porcelain-products-roster-phone.png", {
    animations: "disabled",
    caret: "hide",
    mask: nondeterministicMasks(page),
    maskColor: "#e7ebf1",
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
  await page.getByRole("tab", { name: "Relations", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 2, name: "Relationships" }),
  ).toBeVisible({ timeout: 15000 });
  await expectViewportBounded(page);
  await expect(
    page.getByRole("button", { name: "Stock 1", exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await expect(
    page.getByRole("link", {
      name: "Direct Stock: Porcelain visual phone detail shelf",
      exact: true,
    }),
  ).toBeVisible({ timeout: 15000 });
  await page.waitForLoadState("networkidle");
  await expectCleanVisualState(page);

  await expect(page).toHaveScreenshot(
    "porcelain-product-detail-relationships-phone.png",
    {
      animations: "disabled",
      caret: "hide",
      // Shortcodes vary between isolated databases; keep the generated record
      // identifier out of the committed image while preserving relationship UI.
      mask: [
        ...nondeterministicMasks(page),
        page.getByText(product.id, { exact: true }),
        page.getByText(/^Added /),
      ],
      maskColor: "#e7ebf1",
    },
  );
});
