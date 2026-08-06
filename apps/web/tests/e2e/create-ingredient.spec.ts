import { faker } from "@faker-js/faker";
import { expect, test } from "@playwright/test";
import { fillInput, waitForFormHydration } from "./e2e-helpers";

test.describe("Create Ingredient", () => {
  test("can create an ingredient", async ({ page }) => {
    const ingredientName = faker.food.ingredient();

    await page.goto("/ingredients/new");
    await expect(page).toHaveURL(/\/ingredients\/new/);

    await waitForFormHydration(page);

    await fillInput(page, "Enter ingredient name", ingredientName);

    await page.getByRole("button", { name: /^Create$/ }).click();

    await expect(page).toHaveURL(
      /\/ingredients\/ING-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}/,
      {
        timeout: 15000,
      },
    );
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      ingredientName,
      { timeout: 10000 },
    );
  });
});
