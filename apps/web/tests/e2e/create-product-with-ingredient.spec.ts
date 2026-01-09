import { faker } from "@faker-js/faker";
import { expect, test } from "@playwright/test";

test.describe("Create Product with Ingredient", () => {
  test("can create a product with ingredient link and unit mappings", async ({
    page,
  }) => {
    const ingredientName = faker.food.ingredient();
    const productName = `${ingredientName} Brand Product`;
    const manufacturerName = faker.company.name();

    // Helper to wait for form hydration
    async function waitForFormHydration() {
      await page.waitForLoadState("networkidle");
      await expect(
        page.getByRole("button", { name: "React Hook Form Logo" }),
      ).toBeVisible({ timeout: 10000 });
      await page.waitForTimeout(500);
    }

    // Helper to fill input with proper React event handling
    async function fillInput(placeholder: string, value: string) {
      const input = page.getByPlaceholder(placeholder);
      await expect(input).toBeVisible();
      await expect(input).toBeEnabled();
      await input.click();
      await input.clear();
      await input.pressSequentially(value, { delay: 10 });
      await input.blur();
    }

    // Step 1: Create an ingredient first
    await page.goto("/ingredients/new");
    await expect(page).toHaveURL(/\/ingredients\/new/);
    await waitForFormHydration();
    await fillInput("Enter ingredient name", ingredientName);
    await page.getByRole("button", { name: /^Create$/ }).click();
    await expect(page).toHaveURL(/\/ingredients\/[a-f0-9-]+/, {
      timeout: 15000,
    });

    // Step 2: Create a product and link it to the ingredient
    await page.goto("/products/new");
    await expect(page).toHaveURL(/\/products\/new/);
    await waitForFormHydration();

    // Fill in the product form
    await fillInput("Enter product name", productName);
    await fillInput("Enter manufacturer", manufacturerName);

    // Link to the ingredient we just created
    await page
      .locator('label:has-text("Ingredient")')
      .locator("..")
      .getByRole("combobox")
      .click();

    const ingredientSearch = page.getByRole("textbox", {
      name: "Search ingredient...",
    });
    await ingredientSearch.fill(ingredientName);
    await expect(
      page.getByRole("button", { name: ingredientName, exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: ingredientName, exact: true })
      .click();

    // Add first unit mapping (1 cup = $2.50)
    await page.getByRole("button", { name: "Add Mapping" }).click();
    await page.waitForSelector('text="Unit Mapping 1"', { timeout: 10000 });
    await page.waitForSelector('input[placeholder="Enter unit"]', {
      timeout: 10000,
    });

    const fromUnitField1 = page
      .getByRole("textbox", { name: "Amount Unit" })
      .first();
    await fromUnitField1.fill("cup");

    const toValueField1 = page
      .getByRole("spinbutton", { name: "Amount Value" })
      .last();
    await toValueField1.fill("2.50");
    const toUnitField1 = page
      .getByRole("textbox", { name: "Amount Unit" })
      .last();
    await toUnitField1.fill("dollar");

    // Add second unit mapping (100 grams = $1.50)
    await page.getByRole("button", { name: "Add Mapping" }).click();
    await page.waitForSelector('h4:text("Unit Mapping 2")');

    const fromValueField2 = page
      .getByRole("spinbutton", { name: "Amount Value" })
      .nth(2);
    await fromValueField2.fill("100");
    const fromUnitField2 = page
      .getByRole("textbox", { name: "Amount Unit" })
      .nth(2);
    await fromUnitField2.fill("grams");

    const toValueField2 = page
      .getByRole("spinbutton", { name: "Amount Value" })
      .nth(3);
    await toValueField2.fill("1.50");
    const toUnitField2 = page
      .getByRole("textbox", { name: "Amount Unit" })
      .nth(3);
    await toUnitField2.fill("dollar");

    // Submit product
    await page.getByRole("button", { name: /^Create$/ }).click();

    // Expect redirect to product detail page
    await expect(page).toHaveURL(/\/products\/[a-f0-9-]+/, { timeout: 15000 });
    await expect(
      page.getByRole("heading", { name: `Product: ${productName}` }),
    ).toBeVisible({ timeout: 10000 });
  });
});
