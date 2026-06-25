import { faker } from "@faker-js/faker";
import { expect, test } from "@playwright/test";
import {
  createIngredientViaForm,
  createProductWithIngredientMappings,
  fillInput,
  selectComboboxItem,
  waitForFormHydration,
} from "./e2e-helpers";

test.describe("Create Recipe - Full Flow", () => {
  test("can create ingredient, product, and recipe with cost calculations", async ({
    page,
  }) => {
    const ingredientName = faker.food.ingredient();
    const productName = `${ingredientName} Brand Product`;
    const recipeName = faker.lorem
      .words(3)
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");

    // Steps 1-2: Create the ingredient, then a product linked to it with the
    // standard 1 cup = $2.50 / 100 g = $1.50 conversions (the Step 3 cost/weight
    // assertions below depend on these exact values).
    await createIngredientViaForm(page, ingredientName);
    await createProductWithIngredientMappings(page, {
      name: productName,
      manufacturer: faker.company.name(),
      ingredientName,
    });

    // Step 3: Create recipe
    await page.goto("/recipes/new");
    await waitForFormHydration(page);
    await fillInput(page, "Enter recipe name", recipeName);
    await fillInput(page, "Enter recipe URL", faker.internet.url());

    // Fill yield
    await page.getByLabel("Yield Value (Optional)").fill("12");
    await page.getByLabel("Yield Unit").fill("cookies");

    // Add ingredient row (the add button is labeled just "Ingredient"). The
    // row combobox has no field label, so its aria-label and search
    // placeholder fall back to the generic "item".
    await page.getByRole("button", { name: "Ingredient", exact: true }).click();
    await selectComboboxItem(
      page,
      page.getByRole("combobox", { name: "item" }),
      "Search item...",
      ingredientName,
    );

    // Add amount (2 cups) — row inputs are labeled "Amount" / "Unit"
    const amountValue = page.getByLabel("Amount", { exact: true });
    await expect(amountValue).toBeVisible({ timeout: 5000 });
    await amountValue.fill("2");
    await page.getByLabel("Unit", { exact: true }).fill("cups");

    // Add instruction
    await page.getByRole("button", { name: /Add Instruction/i }).click();
    const instructionInput = page.getByRole("textbox", { name: "Step" });
    await expect(instructionInput).toBeVisible({ timeout: 5000 });
    const instruction =
      faker.lorem.sentence() +
      ` Make sure to use the ${ingredientName} as the main ingredient.`;
    await instructionInput.fill(instruction);

    // Submit recipe
    await page.getByRole("button", { name: /^Create$/i }).click();
    await expect(page).toHaveURL(/\/recipes\/[a-f0-9-]+/, { timeout: 15000 });

    // Verify recipe created
    await expect(
      page.getByRole("heading", { name: recipeName, level: 1 }),
    ).toBeVisible({ timeout: 10000 });

    // Verify ingredient appears in sidebar
    const ingredientsSidebar = page
      .locator("aside")
      .filter({ has: page.getByText("Ingredients") });
    await expect(ingredientsSidebar.getByText(ingredientName)).toBeVisible();

    // Switch to the Data view (table sub-mode) for cost/weight verification
    await page.getByRole("button", { name: "Data" }).click();

    // Verify ingredient link
    const ingredientLink = page
      .getByRole("link", { name: new RegExp(ingredientName) })
      .first();
    await expect(ingredientLink).toBeVisible();
    await expect(ingredientLink).toHaveAttribute("href", /\/ingredients\//);

    // Verify cost calculation (2 cups at $2.50/cup = $5.00)
    await expect(page.getByText("Total Cost", { exact: true })).toBeVisible();
    await expect(page.getByText("$5.00")).toBeVisible();

    // Verify weight calculation (2 cups → 333g via chained conversion)
    await expect(page.getByText("Total Weight", { exact: true })).toBeVisible();
    await expect(page.getByText("333g")).toBeVisible();
  });
});
