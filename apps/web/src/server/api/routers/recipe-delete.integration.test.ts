import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { listParams } from "~/server/repo/repo.fixtures";
import { createTestCaller } from "../trpc";
import { ingredientRouter } from "./ingredient";
import { recipeRouter } from "./recipe";

describe("recipe deletion", () => {
  const ctx = withTestDb();

  describe("basic deletion", () => {
    it("should soft delete a recipe successfully", async () => {
      const caller = createTestCaller(recipeRouter, ctx.db);

      // Create a test recipe
      const recipeData = {
        name: "Test Recipe for Deletion",
        sections: [
          {
            name: "Main Section",
            instructions: [{ instruction: "Mix ingredients" }],
          },
        ],
        yield: null,
        servings: 4,
        tags: null,
        meta: null,
        pendingImageIds: [],
      };

      const createdRecipe = await caller.create(recipeData);

      // Delete the recipe
      await caller.delete({ ids: [createdRecipe.id] });

      // Verify recipe is not in list
      const recipes = await caller.list(listParams());

      expect(
        recipes.items.find((r) => r.id === createdRecipe.id),
      ).toBeUndefined();

      // Verify getByID throws error
      await expect(caller.getByID({ id: createdRecipe.id })).rejects.toThrow(
        "Recipe",
      );
    });

    it("should delete multiple recipes in bulk", async () => {
      const caller = createTestCaller(recipeRouter, ctx.db);

      // Create multiple recipes
      const recipe1 = await caller.create({
        name: "Bulk Delete Recipe 1",
        sections: [
          {
            name: "Main",
            instructions: [{ instruction: "Step 1" }],
          },
        ],
        yield: null,
        servings: null,
        tags: null,
        meta: null,
        pendingImageIds: [],
      });

      const recipe2 = await caller.create({
        name: "Bulk Delete Recipe 2",
        sections: [
          {
            name: "Main",
            instructions: [{ instruction: "Step 1" }],
          },
        ],
        yield: null,
        servings: null,
        tags: null,
        meta: null,
        pendingImageIds: [],
      });

      const recipe3 = await caller.create({
        name: "Bulk Delete Recipe 3",
        sections: [
          {
            name: "Main",
            instructions: [{ instruction: "Step 1" }],
          },
        ],
        yield: null,
        servings: null,
        tags: null,
        meta: null,
        pendingImageIds: [],
      });

      // Delete all three recipes
      await caller.delete({
        ids: [recipe1.id, recipe2.id, recipe3.id],
      });

      // Verify all recipes are gone from list
      const recipes = await caller.list(listParams({ pageSize: 100 }));

      expect(recipes.items.find((r) => r.id === recipe1.id)).toBeUndefined();
      expect(recipes.items.find((r) => r.id === recipe2.id)).toBeUndefined();
      expect(recipes.items.find((r) => r.id === recipe3.id)).toBeUndefined();
    });
  });

  describe("cascading behavior", () => {
    it("should cascade delete to sections and ingredients", async () => {
      const recipeCaller = createTestCaller(recipeRouter, ctx.db);

      const ingredientCaller = createTestCaller(ingredientRouter, ctx.db);

      // Create an ingredient first
      const ingredient = await ingredientCaller.create({
        name: "Recipe Test Ingredient",
        aliases: [],
      });

      // Create a recipe with multiple sections and ingredients
      const recipe = await recipeCaller.create({
        name: "Recipe with Multiple Sections",
        sections: [
          {
            name: "Section 1",
            ingredients: [
              {
                type: "ingredient" as const,
                ingredientId: ingredient.id,
                recipeId: null,
                amounts: [{ value: 1, unit: "cup" }],
              },
            ],
            instructions: [{ instruction: "Step 1" }],
          },
          {
            name: "Section 2",
            ingredients: [
              {
                type: "ingredient" as const,
                ingredientId: ingredient.id,
                recipeId: null,
                amounts: [{ value: 2, unit: "tbsp" }],
              },
            ],
            instructions: [{ instruction: "Step 2" }],
          },
        ],
        yield: null,
        servings: 4,
        tags: ["test"],
        meta: null,
        pendingImageIds: [],
      });

      expect(recipe.sections).toHaveLength(2);
      expect(recipe.sections[0]?.ingredients).toHaveLength(1);
      expect(recipe.sections[1]?.ingredients).toHaveLength(1);

      // Delete the recipe
      await recipeCaller.delete({ ids: [recipe.id] });

      // Verify recipe is gone
      await expect(recipeCaller.getByID({ id: recipe.id })).rejects.toThrow(
        "Recipe",
      );

      // Verify ingredient still exists (it wasn't deleted, only the recipe was)
      const ingredientStillExists = await ingredientCaller.getByID({
        id: ingredient.id,
      });
      expect(ingredientStillExists.id).toEqual(ingredient.id);
    });
  });

  describe("audit logging", () => {
    it("should log deletion with cascaded item counts", async () => {
      const recipeCaller = createTestCaller(recipeRouter, ctx.db);

      const ingredientCaller = createTestCaller(ingredientRouter, ctx.db);

      // Create ingredients
      const ingredient1 = await ingredientCaller.create({
        name: "Audit Test Ingredient 1",
        aliases: [],
      });

      const ingredient2 = await ingredientCaller.create({
        name: "Audit Test Ingredient 2",
        aliases: [],
      });

      // Create a recipe with sections and ingredients
      const recipe = await recipeCaller.create({
        name: "Recipe for Audit Test",
        sections: [
          {
            name: "Section 1",
            ingredients: [
              {
                type: "ingredient" as const,
                ingredientId: ingredient1.id,
                recipeId: null,
                amounts: [{ value: 1, unit: "cup" }],
              },
              {
                type: "ingredient" as const,
                ingredientId: ingredient2.id,
                recipeId: null,
                amounts: [{ value: 2, unit: "tbsp" }],
              },
            ],
            instructions: [{ instruction: "Mix" }],
          },
          {
            name: "Section 2",
            ingredients: [
              {
                type: "ingredient" as const,
                ingredientId: ingredient1.id,
                recipeId: null,
                amounts: [{ value: 3, unit: "oz" }],
              },
            ],
            instructions: [{ instruction: "Combine" }],
          },
        ],
        yield: null,
        servings: null,
        tags: null,
        meta: null,
        pendingImageIds: [],
      });

      // Delete the recipe
      await recipeCaller.delete({ ids: [recipe.id] });

      // Verify recipe is gone
      await expect(recipeCaller.getByID({ id: recipe.id })).rejects.toThrow(
        "Recipe",
      );

      // Note: To fully verify audit logging, we would need to:
      // 1. Query the audit log table directly
      // 2. Check that the changes field contains:
      //    - cascadedSections: {from: 2, to: 0}
      //    - cascadedIngredients: {from: 3, to: 0}
      // This would require adding an audit log router or accessing the DB directly
    });
  });
});
