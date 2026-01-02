import { faker } from "@faker-js/faker";
import { expect, test } from "@playwright/test";

test.describe("Create Recipe", () => {
  test("can create an ingredient, link it to a product, then create a recipe", async ({
    page,
  }) => {
    const ingredientName = faker.food.ingredient();
    const productName = `${ingredientName} Brand Product`; // Product based on ingredient
    const manufacturerName = faker.company.name();
    const recipeName = faker.lorem
      .words(3)
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");

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

    // Wait for form hydration
    await waitForFormHydration();

    // Fill in the ingredient form
    await fillInput("Enter ingredient name", ingredientName);

    // Submit ingredient
    await page.getByRole("button", { name: /^Create$/ }).click();

    // Expect redirect to ingredient detail page
    await expect(page).toHaveURL(/\/ingredients\/[a-f0-9-]+/, {
      timeout: 15000,
    });
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      ingredientName,
      { timeout: 10000 },
    );

    // Step 2: Create a product and link it to the ingredient
    await page.goto("/products/new");
    await expect(page).toHaveURL(/\/products\/new/);

    // Wait for form hydration
    await waitForFormHydration();

    // Fill in the product form
    await fillInput("Enter product name", productName);
    await fillInput("Enter manufacturer", manufacturerName);

    // Link to the ingredient we just created (scope to the Ingredient field's combobox)
    await page
      .locator('label:has-text("Ingredient")')
      .locator("..")
      .getByRole("combobox")
      .click();

    // Search for the ingredient we created
    const ingredientSearch = page.getByRole("textbox", {
      name: "Search ingredient...",
    });
    await ingredientSearch.fill(ingredientName);

    // Wait for search results deterministically and click the ingredient
    await expect(
      page.getByRole("button", { name: ingredientName, exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: ingredientName, exact: true })
      .click();

    // Add first unit mapping for cost calculation (1 cup = $2.50)
    await page.getByRole("button", { name: "Add Mapping" }).click();

    // Wait for the form to appear with more robust selectors
    await page.waitForSelector('text="Unit Mapping 1"', { timeout: 10000 });

    // Wait specifically for the unit input fields to be present and visible
    await page.waitForSelector('input[placeholder="Enter unit"]', {
      timeout: 10000,
    });

    // Fill in From section: 1 cup (first value is already "1" by default)
    const fromUnitField1 = page
      .getByRole("textbox", { name: "Amount Unit" })
      .first();
    await fromUnitField1.fill("cup");

    // Fill in To section: 2.50 dollar
    const toValueField1 = page
      .getByRole("spinbutton", { name: "Amount Value" })
      .last();
    await toValueField1.fill("2.50");
    const toUnitField1 = page
      .getByRole("textbox", { name: "Amount Unit" })
      .last();
    await toUnitField1.fill("dollar");

    // Add second unit mapping for weight-based cost calculation (100 grams = $1.50)
    await page.getByRole("button", { name: "Add Mapping" }).click();

    // Wait for the second mapping form to appear
    await page.waitForSelector('h4:text("Unit Mapping 2")');

    // Fill in From section: 100 grams
    const fromValueField2 = page
      .getByRole("spinbutton", { name: "Amount Value" })
      .nth(2); // Third amount field (0-indexed: 0,1,2)
    await fromValueField2.fill("100");
    const fromUnitField2 = page
      .getByRole("textbox", { name: "Amount Unit" })
      .nth(2); // Third unit field
    await fromUnitField2.fill("grams");

    // Fill in To section: 1.50 dollar
    const toValueField2 = page
      .getByRole("spinbutton", { name: "Amount Value" })
      .nth(3); // Fourth amount field
    await toValueField2.fill("1.50");
    const toUnitField2 = page
      .getByRole("textbox", { name: "Amount Unit" })
      .nth(3); // Fourth unit field
    await toUnitField2.fill("dollar");

    // Submit product
    await page.getByRole("button", { name: /^Create$/ }).click();

    // Expect redirect to product detail page
    await expect(page).toHaveURL(/\/products\/[a-f0-9-]+/, { timeout: 15000 });
    await expect(
      page.getByRole("heading", { name: `Product: ${productName}` }),
    ).toBeVisible({ timeout: 10000 });

    // Step 3: Create a recipe using the linked ingredient
    await page.goto("/recipes/new");
    await expect(page).toHaveURL(/\/recipes\/new/);

    // Wait for form hydration
    await waitForFormHydration();

    // Fill in basic recipe information
    await fillInput("Enter recipe name", recipeName);

    // Fill in recipe metadata
    await fillInput("Enter recipe URL", faker.internet.url());

    // Fill in yield fields (optional but avoids validation issues)
    const yieldInput = page.getByLabel("Yield Value (Optional)");
    await yieldInput.fill("12");
    const yieldUnitInput = page.getByLabel("Yield Unit");
    await yieldUnitInput.fill("cookies");

    // Add an ingredient - click the "Add Ingredient" button
    await page.getByRole("button", { name: /Add Ingredient/i }).click();

    // Wait for the ingredient form to appear and open the Ingredient combobox
    const recipeIngredientCombobox = page
      .locator('label:has-text("Ingredient")')
      .locator("..")
      .getByRole("combobox");
    await recipeIngredientCombobox.click();

    // Search for our existing ingredient (should now be found)
    const recipeSearchBox = page.getByRole("textbox", {
      name: "Search ingredient...",
    });
    await recipeSearchBox.fill(ingredientName);

    // Wait for search results deterministically and select the ingredient
    await expect(
      page.getByRole("button", { name: ingredientName, exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: ingredientName, exact: true })
      .click();

    // Add amount and unit for the ingredient (2 cups)
    const amountInput = page.getByLabel("Amount Value");
    await amountInput.fill("2");
    const unitInput = page.getByRole("textbox", { name: "Amount Unit" });
    await unitInput.fill("cups");

    // Add an instruction
    await page.getByRole("button", { name: /Add Instruction/i }).click();

    // Fill in the instruction
    const instructionInput = page.getByRole("textbox", { name: "Step" });
    const instruction =
      faker.lorem.sentence() +
      ` Make sure to use the ${ingredientName} as the main ingredient.`;
    await instructionInput.fill(instruction);

    // Submit the recipe
    await page.getByRole("button", { name: /^Create$/i }).click();

    // Verify we're redirected to the recipe detail page
    await expect(page).toHaveURL(/\/recipes\/[a-f0-9-]+/, { timeout: 15000 });

    // Check that the recipe name appears as the main heading
    await expect(
      page.getByRole("heading", { name: recipeName, level: 1 }),
    ).toBeVisible({ timeout: 10000 });

    // Verify the ingredient appears in the magazine view ingredients sidebar
    const ingredientsSidebar = page
      .locator("aside")
      .filter({ has: page.getByText("Ingredients") });
    await expect(ingredientsSidebar.getByText(ingredientName)).toBeVisible();

    // Verify the instruction appears in the magazine view (step shown as number circle)
    const instructionsSection = page
      .locator("main")
      .filter({ has: page.getByText("Instructions") });
    await expect(
      instructionsSection.getByText(new RegExp(ingredientName)).first(),
    ).toBeVisible();

    // Switch to Table view to check detailed links and cost/weight calculations
    await page.getByRole("button", { name: "Table" }).click();

    // Verify that we have proper entity relationships by checking the ingredient link
    const ingredientLink = page
      .getByRole("link", { name: new RegExp(ingredientName) })
      .first();
    await expect(ingredientLink).toBeVisible();
    await expect(ingredientLink).toHaveAttribute("href", /\/ingredients\//);

    // Additional verification: Check that the recipe shows correct calculated cost and weight
    // With 2 cups at $2.50/cup, we should see $5.00 total cost
    await expect(page.getByText("Total Cost", { exact: true })).toBeVisible();
    await expect(page.getByText("$5.00")).toBeVisible();

    // With 2 cups converting to 333g total weight (via chained conversion through price mappings)
    await expect(page.getByText("Total Weight", { exact: true })).toBeVisible();
    await expect(page.getByText("333g")).toBeVisible();
  });
});
