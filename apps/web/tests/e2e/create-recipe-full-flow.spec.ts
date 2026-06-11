import { faker } from "@faker-js/faker";
import { expect, test } from "@playwright/test";
import {
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
    const manufacturerName = faker.company.name();
    const recipeName = faker.lorem
      .words(3)
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");

    // Step 1: Create ingredient
    await page.goto("/ingredients/new");
    await waitForFormHydration(page);
    await fillInput(page, "Enter ingredient name", ingredientName);
    await page.getByRole("button", { name: /^Create$/ }).click();
    await expect(page).toHaveURL(/\/ingredients\/[a-f0-9-]+/, {
      timeout: 15000,
    });

    // Step 2: Create product with unit mappings
    await page.goto("/products/new");
    await waitForFormHydration(page);
    await fillInput(page, "Enter product name", productName);
    await fillInput(page, "Enter manufacturer", manufacturerName);

    // Link ingredient
    await selectComboboxItem(
      page,
      page.getByRole("combobox", { name: /ingredient/i }),
      // The field label is "Linked ingredient" — the combobox derives its
      // search placeholder from the lowercased label.
      "Search linked ingredient...",
      ingredientName,
    );

    // Add unit conversions (1 cup = $2.50, 100 grams = $1.50). Rows use
    // compact "Qty"/"Unit" labels that repeat per row, so target the stable
    // input ids instead. The "from" value defaults to 1.
    await page.getByRole("button", { name: "Add conversion" }).click();
    const firstFromUnit = page.locator('[id="unitMappings.0.a.unit"]');
    await expect(firstFromUnit).toBeVisible({ timeout: 10000 });
    await firstFromUnit.fill("cup");
    await page.locator('[id="unitMappings.0.b.value"]').fill("2.50");
    await page.locator('[id="unitMappings.0.b.unit"]').fill("dollar");

    await page.getByRole("button", { name: "Add conversion" }).click();
    const secondFromValue = page.locator('[id="unitMappings.1.a.value"]');
    await expect(secondFromValue).toBeVisible({ timeout: 10000 });
    await secondFromValue.fill("100");
    await page.locator('[id="unitMappings.1.a.unit"]').fill("grams");
    await page.locator('[id="unitMappings.1.b.value"]').fill("1.50");
    await page.locator('[id="unitMappings.1.b.unit"]').fill("dollar");

    await page.getByRole("button", { name: /^Create$/ }).click();
    await expect(page).toHaveURL(/\/products\/[a-f0-9-]+/, { timeout: 15000 });

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

    // Switch to Table view for cost/weight verification
    await page.getByRole("button", { name: "Table" }).click();

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
