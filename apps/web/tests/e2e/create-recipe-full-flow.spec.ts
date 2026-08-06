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

    // The later cost and weight assertions depend on the helper's exact mappings.
    await createIngredientViaForm(page, ingredientName);
    await createProductWithIngredientMappings(page, {
      name: productName,
      manufacturer: faker.company.name(),
      ingredientName,
    });

    await page.goto("/recipes/new");
    await waitForFormHydration(page);
    await fillInput(page, "Enter recipe name", recipeName);
    await fillInput(page, "Enter recipe URL", faker.internet.url());

    await page.getByLabel("Yield Value (Optional)").fill("12");
    await page.getByLabel("Yield Unit").fill("cookies");

    // Add ingredient row (the add button is labeled just "Ingredient"). The
    // row combobox has no field label, so its aria-label falls back to the
    // generic "item".
    await page.getByRole("button", { name: "Ingredient", exact: true }).click();
    await selectComboboxItem(
      page,
      page.getByRole("combobox", { name: "item" }),
      ingredientName,
    );

    const amountValue = page.getByLabel("Amount", { exact: true });
    await expect(amountValue).toBeVisible({ timeout: 5000 });
    await amountValue.fill("2");
    await page.getByLabel("Unit", { exact: true }).fill("cups");

    await page.getByRole("button", { name: /Add Instruction/i }).click();
    const instructionInput = page.getByRole("textbox", { name: "Step" });
    await expect(instructionInput).toBeVisible({ timeout: 5000 });
    const instruction =
      faker.lorem.sentence() +
      ` Make sure to use the ${ingredientName} as the main ingredient.`;
    await instructionInput.fill(instruction);

    await page.getByRole("button", { name: /^Create$/i }).click();
    await expect(page).toHaveURL(
      /\/recipes\/RCP-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}/,
      { timeout: 15000 },
    );

    await expect(
      page.getByRole("heading", { name: recipeName, level: 1 }),
    ).toBeVisible({ timeout: 10000 });

    const ingredientsSidebar = page
      .locator("aside")
      .filter({ has: page.getByText("Ingredients") });
    await expect(ingredientsSidebar.getByText(ingredientName)).toBeVisible();

    // Switch to the Data view (table sub-mode) for cost/weight verification.
    // Exact match avoids colliding with the "Data" nav-group dropdown trigger.
    await page.getByRole("button", { name: "Data view", exact: true }).click();

    const ingredientLink = page
      .getByRole("link", { name: new RegExp(ingredientName) })
      .first();
    await expect(ingredientLink).toBeVisible();
    await expect(ingredientLink).toHaveAttribute("href", /\/ingredients\//);

    // $5.00 now appears twice — the summary card (rendered first) and the
    // ingredient table's Totals footer row — so scope to the first (the card).
    await expect(page.getByText("Total Cost", { exact: true })).toBeVisible();
    await expect(page.getByText("$5.00").first()).toBeVisible();

    await expect(page.getByText("Total Weight", { exact: true })).toBeVisible();
    await expect(page.getByText("333g")).toBeVisible();
  });
});
