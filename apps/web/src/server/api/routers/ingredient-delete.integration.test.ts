import { buildTestDB } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import { unsafeUserId } from "~/schemas/identifiers";
import type { Database } from "~/server/db";
import { createCallerFactory, createTestTRPCContext } from "../trpc";
import { ingredientRouter } from "./ingredient";
import { productRouter } from "./product";
import { recipeRouter } from "./recipe";

const TEST_USER_ID = unsafeUserId("test-user-id");

describe("ingredient deletion", () => {
  let db: Database;
  let teardown: () => Promise<void>;
  beforeEach(async () => {
    ({ db, teardown } = await buildTestDB());

    return teardown;
  });

  describe("basic deletion", () => {
    it("should soft delete an ingredient successfully", async () => {
      const createCaller = createCallerFactory(ingredientRouter);
      const caller = createCaller(
        createTestTRPCContext(db, {
          auth: { userId: TEST_USER_ID },
        }),
      );

      // Create a test ingredient
      const ingredientData = {
        name: "Test Ingredient for Deletion",
        aliases: ["test-alias"],
      };

      const createdIngredient = await caller.create(ingredientData);

      // Delete the ingredient
      await caller.delete({ ids: [createdIngredient.id] });

      // Verify ingredient is not in list
      const ingredients = await caller.list({
        filters: { missingProductsOnly: false },
        sort: { orderBy: "name", direction: "asc" },
        pagination: { pageSize: 10, pageIndex: 0 },
      });

      expect(
        ingredients.items.find((i) => i.id === createdIngredient.id),
      ).toBeUndefined();

      // Verify getByID throws error
      await expect(
        caller.getByID({ id: createdIngredient.id }),
      ).rejects.toThrow("Ingredient");
    });

    it("should delete multiple ingredients in bulk", async () => {
      const createCaller = createCallerFactory(ingredientRouter);
      const caller = createCaller(
        createTestTRPCContext(db, {
          auth: { userId: TEST_USER_ID },
        }),
      );

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
      const ingredients = await caller.list({
        filters: { missingProductsOnly: false },
        sort: { orderBy: "name", direction: "asc" },
        pagination: { pageSize: 100, pageIndex: 0 },
      });

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
      const createIngredientCaller = createCallerFactory(ingredientRouter);
      const ingredientCaller = createIngredientCaller(
        createTestTRPCContext(db, {
          auth: { userId: TEST_USER_ID },
        }),
      );

      const createProductCaller = createCallerFactory(productRouter);
      const productCaller = createProductCaller(
        createTestTRPCContext(db, {
          auth: { userId: TEST_USER_ID },
        }),
      );

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
        ndb_number: null,
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
      const createIngredientCaller = createCallerFactory(ingredientRouter);
      const ingredientCaller = createIngredientCaller(
        createTestTRPCContext(db, {
          auth: { userId: TEST_USER_ID },
        }),
      );

      const createRecipeCaller = createCallerFactory(recipeRouter);
      const recipeCaller = createRecipeCaller(
        createTestTRPCContext(db, {
          auth: { userId: TEST_USER_ID },
        }),
      );

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
