import { faker } from "@faker-js/faker";
import { expect, test } from "@playwright/test";
import { waitForFormHydration } from "./e2e-helpers";

test.describe("Create Ingredient", () => {
  test("can create an ingredient", async ({ page }) => {
    const ingredientName = faker.food.ingredient();

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

    // Create an ingredient
    await page.goto("/ingredients/new");
    await expect(page).toHaveURL(/\/ingredients\/new/);

    // Wait for form hydration
    await waitForFormHydration(page);

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
  });
});
