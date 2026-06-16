import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { listParams } from "~/server/repo/repo.fixtures";
import { createTestCaller } from "../trpc";
import { ingredientRouter } from "./ingredient";
import { productRouter } from "./product";
import { recipeRouter } from "./recipe";

describe("ingredient deletion", () => {
  const ctx = withTestDb();

  describe("basic deletion", () => {
    it("should soft delete an ingredient successfully", async () => {
      const caller = createTestCaller(ingredientRouter, ctx.db);

      // Create a test ingredient
      const ingredientData = {
        name: "Test Ingredient for Deletion",
        aliases: ["test-alias"],
      };

      const createdIngredient = await caller.create(ingredientData);

      // Delete the ingredient
      await caller.delete({ ids: [createdIngredient.id] });

      // Verify ingredient is not in list
      const ingredients = await caller.list(
        listParams({ filters: { missingProductsOnly: false } }),
      );

      expect(
        ingredients.items.find((i) => i.id === createdIngredient.id),
      ).toBeUndefined();

      // Verify getByID throws error
      await expect(
        caller.getByID({ id: createdIngredient.id }),
      ).rejects.toThrow("Ingredient");
    });

    it("should delete multiple ingredients in bulk", async () => {
      const caller = createTestCaller(ingredientRouter, ctx.db);

      // Create multiple ingredients
      const ingredient1 = await caller.create({
        name: "Bulk Delete Ingredient 1",
        aliases: [],
      });

      const ingredient2 = await caller.create({
        name: "Bulk Delete Ingredient 2",
        aliases: [],
      });

      const ingredient3 = await caller.create({
        name: "Bulk Delete Ingredient 3",
        aliases: [],
      });

      // Delete all three ingredients
      await caller.delete({
        ids: [ingredient1.id, ingredient2.id, ingredient3.id],
      });

      // Verify all ingredients are gone from list
      const ingredients = await caller.list(
        listParams({ filters: { missingProductsOnly: false }, pageSize: 100 }),
      );

      expect(
        ingredients.items.find((i) => i.id === ingredient1.id),
      ).toBeUndefined();
      expect(
        ingredients.items.find((i) => i.id === ingredient2.id),
      ).toBeUndefined();
      expect(
        ingredients.items.find((i) => i.id === ingredient3.id),
      ).toBeUndefined();
    });
  });

  describe("safety checks", () => {
    it("should prevent deletion if ingredient is linked to a product", async () => {
      const ingredientCaller = createTestCaller(ingredientRouter, ctx.db);

      const productCaller = createTestCaller(productRouter, ctx.db);

      // Create an ingredient
      const ingredient = await ingredientCaller.create({
        name: "Ingredient with Product",
        aliases: [],
      });

      // Create a product linked to the ingredient
      await productCaller.create({
        name: "Product Linked to Ingredient",
        manufacturer: "Test Manufacturer",
        model: "ING-TEST-1",
        upc: "444555666777",
        fdc_id: null,
        ingredientId: ingredient.id,
        pendingImageIds: [],
        expectedQuantity: 1,
      });

      // Try to delete the ingredient - should fail
      await expect(
        ingredientCaller.delete({ ids: [ingredient.id] }),
      ).rejects.toThrow("linked products");

      // Verify ingredient still exists
      const retrievedIngredient = await ingredientCaller.getByID({
        id: ingredient.id,
      });
      expect(retrievedIngredient.id).toEqual(ingredient.id);
    });

    it("should prevent deletion if ingredient is used in a recipe", async () => {
      const ingredientCaller = createTestCaller(ingredientRouter, ctx.db);

      const recipeCaller = createTestCaller(recipeRouter, ctx.db);

      // Create an ingredient
      const ingredient = await ingredientCaller.create({
        name: "Ingredient in Recipe",
        aliases: [],
      });

      // Create a recipe using the ingredient
      await recipeCaller.create({
        name: "Recipe with Ingredient",
        sections: [
          {
            name: "Main",
            ingredients: [
              {
                type: "ingredient" as const,
                ingredientId: ingredient.id,
                recipeId: null,
                amounts: [{ value: 1, unit: "cup" }],
              },
            ],
            instructions: [{ instruction: "Mix well" }],
          },
        ],
        yield: null,
        servings: null,
        tags: null,
        meta: null,
        pendingImageIds: [],
      });

      // Try to delete the ingredient - should fail
      await expect(
        ingredientCaller.delete({ ids: [ingredient.id] }),
      ).rejects.toThrow("used in recipes");

      // Verify ingredient still exists
      const retrievedIngredient = await ingredientCaller.getByID({
        id: ingredient.id,
      });
      expect(retrievedIngredient.id).toEqual(ingredient.id);
    });
  });
});
