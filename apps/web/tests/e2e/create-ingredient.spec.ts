import { faker } from "@faker-js/faker";
import { expect, test } from "@playwright/test";
import { fillInput, waitForFormHydration } from "./e2e-helpers";

test.describe("Create Ingredient", () => {
  test("can create an ingredient", async ({ page }) => {
    const ingredientName = faker.food.ingredient();

    // Create an ingredient
    await page.goto("/ingredients/new");
    await expect(page).toHaveURL(/\/ingredients\/new/);

    // Wait for form hydration
    await waitForFormHydration(page);

    // Fill in the ingredient form
    await fillInput(page, "Enter ingredient name", ingredientName);

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
  });
});
