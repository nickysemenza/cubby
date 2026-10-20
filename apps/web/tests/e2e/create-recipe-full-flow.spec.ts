import { seedCostedIngredientPrerequisite } from "./fixtures/recipes";
import {
  SHORTCODE,
  fillInput,
  selectComboboxItem,
  uniqueName,
  waitForFormHydration,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

test.describe("Create Recipe - Full Flow", () => {
  test("creates a recipe whose cost comes from the linked product", async ({
    page,
  }, testInfo) => {
    // The ingredient's product pricing is a prerequisite; creating the recipe
    // through the form, and its derived cost and weight, are the behavior.
    const ingredientName = uniqueName(testInfo, "Recipe flow flour");
    const recipeName = uniqueName(testInfo, "Recipe Flow Cookies");
    await seedCostedIngredientPrerequisite(page, ingredientName);

    await page.goto("/recipes/new");
    await waitForFormHydration(page);
    await fillInput(page, "Enter recipe name", recipeName);
    await fillInput(page, "Enter recipe URL", "https://example.com/cookies");

    await page.getByLabel("Yield Value (Optional)").fill("12");
    await page.getByLabel("Yield Unit").fill("cookies");

    // Add ingredient row (the add button is labeled just "Ingredient"). The
    // row combobox has no field label, so its accessible name is the entity's.
    await page.getByRole("button", { name: "Ingredient", exact: true }).click();
    await selectComboboxItem(
      page,
      page.getByRole("combobox", { name: "Ingredient", exact: true }),
      ingredientName,
    );

    const amountValue = page.getByLabel("Amount", { exact: true });
    await expect(amountValue).toBeVisible({ timeout: 5000 });
    await amountValue.fill("2");
    await page.getByLabel("Unit", { exact: true }).fill("cups");

    await page.getByRole("button", { name: /Add Instruction/i }).click();
    const instructionInput = page.getByRole("textbox", { name: "Step" });
    await expect(instructionInput).toBeVisible({ timeout: 5000 });
    await instructionInput.fill(`Whisk the ${ingredientName} until smooth.`);

    await page.getByRole("button", { name: /^Create$/i }).click();
    await expect(page).toHaveURL(new RegExp(`/recipes/RCP-${SHORTCODE}`), {
      timeout: 15000,
    });

    await expect(
      page.getByRole("heading", { name: recipeName, level: 1 }),
    ).toBeVisible({ timeout: 10000 });

    const ingredientsSidebar = page.locator("aside").filter({
      has: page
        .locator(":scope > div > h3")
        .filter({ hasText: /^Ingredients$/ }),
    });
    await expect(ingredientsSidebar).toHaveCount(1);
    const ingredientRow = ingredientsSidebar.getByRole("listitem").filter({
      has: page.getByRole("link", { name: ingredientName, exact: true }),
    });
    await expect(ingredientRow).toBeVisible();

    // Switch to the Data view (table sub-mode) for cost/weight verification.
    // Exact match avoids colliding with the "Data" nav-group dropdown trigger.
    await page
      .getByRole("group", { name: "Recipe view" })
      .getByRole("button", { name: "Data", exact: true })
      .click();

    const ingredientLink = page
      .getByRole("table", { name: "Recipe Ingredients Table" })
      .getByRole("link", {
        name: ingredientName,
        exact: true,
      });
    await expect(ingredientLink).toBeVisible();
    await expect(ingredientLink).toHaveAttribute("href", /\/ingredients\//);

    const summary = page.getByRole("region", { name: "Recipe summary" });
    await expect(
      summary.getByText("Cost: $5.00", { exact: true }),
    ).toBeVisible();
    await expect(
      summary.getByText("Weight: 333 g", { exact: true }),
    ).toBeVisible();

    // Leaving the editor with unsaved edits asks first; there is no undo.
    await page.goto(`${new URL(page.url()).pathname}?edit=true`);
    await waitForFormHydration(page);
    await page.getByLabel("Name", { exact: true }).fill(`${recipeName} draft`);
    const discard = page.getByRole("alertdialog", {
      name: "Discard unsaved edits?",
    });
    await page.getByRole("button", { name: "Cancel" }).first().click();
    await expect(discard).toBeVisible();
    await discard.getByRole("button", { name: "Keep editing" }).click();
    await expect(page).toHaveURL(/edit=true/);
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
      `${recipeName} draft`,
    );
    await page.getByRole("button", { name: "Cancel" }).first().click();
    await discard.getByRole("button", { name: "Discard edits" }).click();
    await expect(page).not.toHaveURL(/edit=true/);
    await expect(
      page.getByRole("heading", { name: recipeName, level: 1 }),
    ).toBeVisible();
  });
});
