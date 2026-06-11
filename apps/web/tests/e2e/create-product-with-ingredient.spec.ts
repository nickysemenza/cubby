import { faker } from "@faker-js/faker";
import { expect, test } from "@playwright/test";
import {
  fillInput,
  selectComboboxItem,
  waitForFormHydration,
} from "./e2e-helpers";

test.describe("Create Product with Ingredient", () => {
  test("can create a product with ingredient link and unit mappings", async ({
    page,
  }) => {
    const ingredientName = faker.food.ingredient();
    const productName = `${ingredientName} Brand Product`;
    const manufacturerName = faker.company.name();

    // Step 1: Create an ingredient first
    await page.goto("/ingredients/new");
    await expect(page).toHaveURL(/\/ingredients\/new/);
    await waitForFormHydration(page);
    await fillInput(page, "Enter ingredient name", ingredientName);
    await page.getByRole("button", { name: /^Create$/ }).click();
    await expect(page).toHaveURL(/\/ingredients\/[a-f0-9-]+/, {
      timeout: 15000,
    });

    // Step 2: Create a product and link it to the ingredient
    await page.goto("/products/new");
    await expect(page).toHaveURL(/\/products\/new/);
    await waitForFormHydration(page);

    // Fill in the product form
    await fillInput(page, "Enter product name", productName);
    await fillInput(page, "Enter manufacturer", manufacturerName);

    // Link to the ingredient we just created
    await selectComboboxItem(
      page,
      page.getByRole("combobox", { name: /ingredient/i }),
      // The field label is "Linked ingredient" — the combobox derives its
      // search placeholder from the lowercased label.
      "Search linked ingredient...",
      ingredientName,
    );

    // Add first unit conversion (1 cup = $2.50). Rows use compact "Qty"/"Unit"
    // labels that repeat per row, so target the stable input ids instead.
    // The "from" value defaults to 1.
    await page.getByRole("button", { name: "Add conversion" }).click();
    const firstFromUnit = page.locator('[id="unitMappings.0.a.unit"]');
    await expect(firstFromUnit).toBeVisible({ timeout: 10000 });
    await firstFromUnit.fill("cup");
    await page.locator('[id="unitMappings.0.b.value"]').fill("2.50");
    await page.locator('[id="unitMappings.0.b.unit"]').fill("dollar");

    // Add second unit conversion (100 grams = $1.50)
    await page.getByRole("button", { name: "Add conversion" }).click();
    const secondFromValue = page.locator('[id="unitMappings.1.a.value"]');
    await expect(secondFromValue).toBeVisible({ timeout: 10000 });
    await secondFromValue.fill("100");
    await page.locator('[id="unitMappings.1.a.unit"]').fill("grams");
    await page.locator('[id="unitMappings.1.b.value"]').fill("1.50");
    await page.locator('[id="unitMappings.1.b.unit"]').fill("dollar");

    // Submit product
    await page.getByRole("button", { name: /^Create$/ }).click();

    // Expect redirect to product detail page
    await expect(page).toHaveURL(/\/products\/[a-f0-9-]+/, { timeout: 15000 });
    // PageHero renders the entity label ("Product") as an eyebrow above the
    // <h1>, which is the bare product name.
    await expect(
      page.getByRole("heading", { level: 1, name: productName }),
    ).toBeVisible({ timeout: 10000 });
  });
});
