import { faker } from "@faker-js/faker";
import { expect, test } from "@playwright/test";

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

    // Helper to wait for form hydration
    async function waitForFormHydration() {
      await page.waitForLoadState("networkidle");
      await expect(
        page.getByRole("button", { name: "React Hook Form Logo" }),
      ).toBeVisible({ timeout: 10000 });
      await page.waitForTimeout(500);
    }

    // Helper to fill input
    async function fillInput(placeholder: string, value: string) {
      const input = page.getByPlaceholder(placeholder);
      await expect(input).toBeVisible();
      await expect(input).toBeEnabled();
      await input.click();
      await input.clear();
      await input.pressSequentially(value, { delay: 10 });
      await input.blur();
    }

    // Step 1: Create ingredient
    await page.goto("/ingredients/new");
    await waitForFormHydration();
    await fillInput("Enter ingredient name", ingredientName);
    await page.getByRole("button", { name: /^Create$/ }).click();
    await expect(page).toHaveURL(/\/ingredients\/[a-f0-9-]+/, {
      timeout: 15000,
    });

    // Step 2: Create product with unit mappings
    await page.goto("/products/new");
    await waitForFormHydration();
    await fillInput("Enter product name", productName);
    await fillInput("Enter manufacturer", manufacturerName);

    // Link ingredient (aria-label is lowercase)
    const ingredientCombobox = page.getByRole("combobox", {
      name: /ingredient/i,
    });
    await expect(ingredientCombobox).toBeVisible({ timeout: 10000 });
    await ingredientCombobox.click();
    const ingredientSearch = page.getByPlaceholder("Search ingredient...");
    await expect(ingredientSearch).toBeVisible({ timeout: 5000 });
    await ingredientSearch.fill(ingredientName);
    await expect(
      page.getByRole("button", { name: ingredientName, exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: ingredientName, exact: true })
      .click();

    // Add unit mappings (1 cup = $2.50, 100 grams = $1.50)
    await page.getByRole("button", { name: "Add Mapping" }).click();
    await page.waitForSelector('text="Unit Mapping 1"');
    await page
      .getByRole("textbox", { name: "Amount Unit" })
      .first()
      .fill("cup");
    await page
      .getByRole("spinbutton", { name: "Amount Value" })
      .last()
      .fill("2.50");
    await page
      .getByRole("textbox", { name: "Amount Unit" })
      .last()
      .fill("dollar");

    await page.getByRole("button", { name: "Add Mapping" }).click();
    await page.waitForSelector('h4:text("Unit Mapping 2")');
    await page
      .getByRole("spinbutton", { name: "Amount Value" })
      .nth(2)
      .fill("100");
    await page
      .getByRole("textbox", { name: "Amount Unit" })
      .nth(2)
      .fill("grams");
    await page
      .getByRole("spinbutton", { name: "Amount Value" })
      .nth(3)
      .fill("1.50");
    await page
      .getByRole("textbox", { name: "Amount Unit" })
      .nth(3)
      .fill("dollar");

    await page.getByRole("button", { name: /^Create$/ }).click();
    await expect(page).toHaveURL(/\/products\/[a-f0-9-]+/, { timeout: 15000 });

    // Step 3: Create recipe
    await page.goto("/recipes/new");
    await waitForFormHydration();
    await fillInput("Enter recipe name", recipeName);
    await fillInput("Enter recipe URL", faker.internet.url());

    // Fill yield
    await page.getByLabel("Yield Value (Optional)").fill("12");
    await page.getByLabel("Yield Unit").fill("cookies");

    // Add ingredient (aria-label is lowercase)
    await page.getByRole("button", { name: /Add Ingredient/i }).click();
    const recipeIngredientCombobox = page.getByRole("combobox", {
      name: /ingredient/i,
    });
    await expect(recipeIngredientCombobox).toBeVisible({ timeout: 10000 });
    await recipeIngredientCombobox.click();

    const recipeSearchBox = page.getByPlaceholder("Search ingredient...");
    await expect(recipeSearchBox).toBeVisible({ timeout: 5000 });
    await recipeSearchBox.fill(ingredientName);
    await expect(
      page.getByRole("button", { name: ingredientName, exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: ingredientName, exact: true })
      .click();

    // Add amount (2 cups)
    await page.getByLabel("Amount Value").fill("2");
    await page.getByRole("textbox", { name: "Amount Unit" }).fill("cups");

    // Add instruction
    await page.getByRole("button", { name: /Add Instruction/i }).click();
    const instructionInput = page.getByRole("textbox", { name: "Step" });
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
