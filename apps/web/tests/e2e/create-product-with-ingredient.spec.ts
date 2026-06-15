import { faker } from "@faker-js/faker";
import { test } from "@playwright/test";
import {
  createIngredientViaForm,
  createProductWithIngredientMappings,
} from "./e2e-helpers";

test.describe("Create Product with Ingredient", () => {
  test("can create a product with ingredient link and unit mappings", async ({
    page,
  }) => {
    const ingredientName = faker.food.ingredient();

    // Create the ingredient, then a product linked to it with two unit→price
    // conversions. Both helpers assert their id-bearing detail URLs; the
    // product helper also asserts the <h1> name heading.
    await createIngredientViaForm(page, ingredientName);
    await createProductWithIngredientMappings(page, {
      name: `${ingredientName} Brand Product`,
      manufacturer: faker.company.name(),
      ingredientName,
    });
  });
});
