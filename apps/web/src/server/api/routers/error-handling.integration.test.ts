import {
  unsafeIngredientId,
  unsafeLocationId,
} from "@cubby/schemas/identifiers";
import { NONEXISTENT_UUID, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import {
  listParams,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { createTestCaller } from "../trpc";
import { ingredientRouter } from "./ingredient";
import { locationRouter } from "./location";
import { productRouter } from "./product";
import { recipeRouter } from "./recipe";

describe("API Error Handling", () => {
  const ctx = withTestDb();

  describe("Product Router Error Cases", () => {
    it("should allow creating product with empty name (schema permits it)", async () => {
      const caller = createTestCaller(productRouter, ctx.db);

      // Empty name is actually allowed by the current schema
      const result = await caller.create(
        makeProductInput({
          name: "", // Empty name is permitted
          pendingImageIds: [],
          expectedQuantity: 1,
        }),
      );

      expect(result).toBeDefined();
      expect(result.name).toBe("");
      expect(result.manufacturer).toBe("Test Manufacturer");
    });

    it("should throw error when updating non-existent product", async () => {
      const caller = createTestCaller(productRouter, ctx.db);

      const nonExistentId = NONEXISTENT_UUID;

      await expect(
        caller.update({
          id: nonExistentId,
          data: { name: "Updated Name" },
        }),
      ).rejects.toThrow();
    });

    it("should handle duplicate product constraint violations", async () => {
      const caller = createTestCaller(productRouter, ctx.db);

      const productData = makeProductInput({
        upc: "123456789012",
        pendingImageIds: [],
        expectedQuantity: 1,
      });

      // Create first product
      await caller.create(productData);

      // Try to create duplicate product with same name and manufacturer
      await expect(caller.create(productData)).rejects.toThrow();
    });

    it("should handle invalid foreign key relationships", async () => {
      const caller = createTestCaller(productRouter, ctx.db);

      // Try to create product with non-existent ingredient ID
      await expect(
        caller.create(
          makeProductInput({
            ingredientId: unsafeIngredientId(NONEXISTENT_UUID), // Non-existent
            pendingImageIds: [],
            expectedQuantity: 1,
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe("Recipe Router Error Cases", () => {
    it("should allow creating recipe with empty name (schema permits it)", async () => {
      const caller = createTestCaller(recipeRouter, ctx.db);

      // Empty name is actually allowed by the current schema
      const result = await caller.create({
        name: "", // Empty name is permitted
        sections: [],
        meta: null,
        pendingImageIds: [],
      });

      expect(result).toBeDefined();
      expect(result.id).toBeDefined();
    });

    it("should throw error when updating non-existent recipe", async () => {
      const caller = createTestCaller(recipeRouter, ctx.db);

      const nonExistentId = NONEXISTENT_UUID;

      await expect(
        caller.update({
          id: nonExistentId,
          data: { name: "Updated Recipe" },
        }),
      ).rejects.toThrow();
    });

    it("should handle recipe with invalid ingredient references", async () => {
      const caller = createTestCaller(recipeRouter, ctx.db);

      // Try to create recipe with non-existent ingredient
      await expect(
        caller.create({
          name: "Test Recipe",
          sections: [
            {
              name: "Ingredients",
              ingredients: [
                {
                  type: "ingredient" as const,
                  recipeId: null,
                  ingredientId: NONEXISTENT_UUID, // Non-existent
                  amounts: [{ value: 1, unit: "cup" }],
                },
              ],
              instructions: [{ instruction: "Mix ingredients" }],
            },
          ],
          meta: null,
          pendingImageIds: [],
        }),
      ).rejects.toThrow();
    });

    it("should handle recipe with invalid recipe references", async () => {
      const caller = createTestCaller(recipeRouter, ctx.db);

      // Try to create recipe referencing non-existent sub-recipe
      await expect(
        caller.create({
          name: "Test Recipe",
          sections: [
            {
              name: "Sub-recipes",
              ingredients: [
                {
                  type: "recipe" as const,
                  recipeId: NONEXISTENT_UUID, // Non-existent
                  ingredientId: null,
                  amounts: [{ value: 1, unit: "serving" }],
                },
              ],
              instructions: [{ instruction: "Prepare sub-recipe" }],
            },
          ],
          meta: null,
          pendingImageIds: [],
        }),
      ).rejects.toThrow();
    });
  });

  describe("Ingredient Router Error Cases", () => {
    it("should allow creating ingredient with empty name (schema permits it)", async () => {
      const caller = createTestCaller(ingredientRouter, ctx.db);

      // Empty name is actually allowed by the current schema
      const result = await caller.create({
        name: "", // Empty name is permitted
        aliases: [],
      });

      expect(result).toBeDefined();
      expect(result.name).toBe("");
    });

    it("should handle duplicate ingredient names", async () => {
      const caller = createTestCaller(ingredientRouter, ctx.db);

      const ingredientData = {
        name: "Flour",
        aliases: [],
      };

      // Create first ingredient
      await caller.create(ingredientData);

      // Try to create duplicate ingredient with same name
      await expect(caller.create(ingredientData)).rejects.toThrow();
    });

    it("should throw error when updating non-existent ingredient", async () => {
      const caller = createTestCaller(ingredientRouter, ctx.db);

      const nonExistentId = NONEXISTENT_UUID;

      await expect(
        caller.update({
          id: nonExistentId,
          data: { name: "Updated Ingredient" },
        }),
      ).rejects.toThrow();
    });
  });

  describe("Location Router Error Cases", () => {
    it("should allow creating location with empty name (schema permits it)", async () => {
      const caller = createTestCaller(locationRouter, ctx.db);

      // Empty names are allowed per schema
      const result = await caller.create(makeLocationInput({ name: "" }));

      expect(result.name).toBe("");
      expect(result.type).toBe("room");
    });

    it("should create location with non-existent parent (no FK constraint)", async () => {
      const caller = createTestCaller(locationRouter, ctx.db);

      // Location with non-existent parent is created (no FK constraint on parentId)
      const result = await caller.create(
        makeLocationInput({
          name: "Child Location",
          type: "shelf",
          parentId: unsafeLocationId(NONEXISTENT_UUID), // Non-existent parent
        }),
      );

      // Location is created but parent is undefined since it doesn't exist
      expect(result.name).toBe("Child Location");
      expect(result.parent).toBeUndefined();
    });

    it("should throw error when creating circular parent-child relationship", async () => {
      const caller = createTestCaller(locationRouter, ctx.db);

      // Create parent location (using valid location type)
      const parent = await caller.create(
        makeLocationInput({ name: "Parent Location" }),
      );

      // Create child location
      const child = await caller.create(
        makeLocationInput({
          name: "Child Location",
          type: "shelf",
          parentId: parent.id,
        }),
      );

      // Try to make parent a child of its own child (circular reference)
      await expect(
        caller.update({
          id: parent.id,
          data: { parentId: child.id }, // Correct field name
        }),
      ).rejects.toThrow();
    });
  });

  describe("Input Validation Error Cases", () => {
    it("should validate pagination parameters at database level", async () => {
      const caller = createTestCaller(productRouter, ctx.db);

      // Test that negative pageIndex is caught by validation
      await expect(
        // negative pageIndex should be rejected by validation
        caller.list(listParams({ pageIndex: -1 })),
      ).rejects.toThrow(/too_small/);

      // Test normal pagination works
      const result = await caller.list(listParams());
      expect(result).toBeDefined();
      expect(result.meta.pageSize).toBe(10);
      expect(result.meta.pageIndex).toBe(0);
    });

    it("should handle sort parameters gracefully", async () => {
      const caller = createTestCaller(productRouter, ctx.db);

      // Test valid sort parameters work
      const result1 = await caller.list(listParams());
      expect(result1).toBeDefined();

      // Test another valid sort field
      const result2 = await caller.list(
        listParams({ orderBy: "createdAt", direction: "desc" }),
      );
      expect(result2).toBeDefined();
    });

    it("should validate UPC format", async () => {
      const caller = createTestCaller(productRouter, ctx.db);

      // Try to create product with invalid UPC format
      await expect(
        caller.create(
          makeProductInput({
            upc: "invalid-upc-format", // Should be numeric
            pendingImageIds: [],
            expectedQuantity: 1,
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe("Database Constraint Violations", () => {
    it("should handle database transaction failures gracefully", async () => {
      const caller = createTestCaller(recipeRouter, ctx.db);

      // Create a recipe that should cause a database constraint violation
      // by trying to create multiple sections with ingredients that reference
      // the same non-existent ingredient (which will fail during transaction)
      await expect(
        caller.create({
          name: "Test Recipe",
          sections: [
            {
              name: "Section 1",
              ingredients: [
                {
                  type: "ingredient" as const,
                  recipeId: null,
                  ingredientId: NONEXISTENT_UUID,
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
                  recipeId: null,
                  ingredientId: NONEXISTENT_UUID,
                  amounts: [{ value: 2, unit: "tbsp" }],
                },
              ],
              instructions: [{ instruction: "Step 2" }],
            },
          ],
          meta: null,
          pendingImageIds: [],
        }),
      ).rejects.toThrow();

      // Verify that no partial data was created (transaction rolled back)
      const recipes = await caller.list(listParams());

      expect(recipes.items).toHaveLength(0);
    });
  });
});
