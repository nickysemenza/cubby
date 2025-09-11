import { beforeEach, describe, expect, it } from "vitest";
import { type PrismaClient } from "@prisma/client";
import { buildTestDB } from "tooling/test-setup";
import { productRouter } from "./product";
import { recipeRouter } from "./recipe";
import { ingredientRouter } from "./ingredient";
import { locationRouter } from "./location";
import { createCallerFactory, createTestTRPCContext } from "../trpc";

let prisma: PrismaClient;

describe("API Error Handling", () => {
  beforeEach(async () => {
    const res = await buildTestDB();
    prisma = res.prisma;
    return res.teardown;
  });

  describe("Product Router Error Cases", () => {
    it("should allow creating product with empty name (schema permits it)", async () => {
      const createCaller = createCallerFactory(productRouter);
      const caller = createCaller(
        createTestTRPCContext(prisma, { auth: undefined }),
      );

      // Empty name is actually allowed by the current schema
      const result = await caller.create({
        name: "", // Empty name is permitted
        manufacturer: "Test Manufacturer",
        model: "TEST-123",
        upc: null,
        ndb_number: null,
        ingredientId: null,
        pendingImageIds: [],
      });

      expect(result).toBeDefined();
      expect(result.name).toBe("");
      expect(result.manufacturer).toBe("Test Manufacturer");
    });

    it("should throw error when updating non-existent product", async () => {
      const createCaller = createCallerFactory(productRouter);
      const caller = createCaller(
        createTestTRPCContext(prisma, { auth: undefined }),
      );

      const nonExistentId = "00000000-0000-0000-0000-000000000000";

      await expect(
        caller.update({
          id: nonExistentId,
          data: { name: "Updated Name" },
        }),
      ).rejects.toThrow();
    });

    it("should handle duplicate product constraint violations", async () => {
      const createCaller = createCallerFactory(productRouter);
      const caller = createCaller(
        createTestTRPCContext(prisma, { auth: undefined }),
      );

      const productData = {
        name: "Test Product",
        manufacturer: "Test Manufacturer",
        model: "TEST-123",
        upc: "123456789012",
        ndb_number: null,
        ingredientId: null,
        pendingImageIds: [],
      };

      // Create first product
      await caller.create(productData);

      // Try to create duplicate product with same name and manufacturer
      await expect(caller.create(productData)).rejects.toThrow();
    });

    it("should handle invalid foreign key relationships", async () => {
      const createCaller = createCallerFactory(productRouter);
      const caller = createCaller(
        createTestTRPCContext(prisma, { auth: undefined }),
      );

      // Try to create product with non-existent ingredient ID
      await expect(
        caller.create({
          name: "Test Product",
          manufacturer: "Test Manufacturer",
          model: "TEST-123",
          upc: null,
          ndb_number: null,
          ingredientId: "00000000-0000-0000-0000-000000000000", // Non-existent
          pendingImageIds: [],
        }),
      ).rejects.toThrow();
    });
  });

  describe("Recipe Router Error Cases", () => {
    it("should allow creating recipe with empty name (schema permits it)", async () => {
      const createCaller = createCallerFactory(recipeRouter);
      const caller = createCaller(
        createTestTRPCContext(prisma, { auth: undefined }),
      );

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
      const createCaller = createCallerFactory(recipeRouter);
      const caller = createCaller(
        createTestTRPCContext(prisma, { auth: undefined }),
      );

      const nonExistentId = "00000000-0000-0000-0000-000000000000";

      await expect(
        caller.update({
          id: nonExistentId,
          data: { name: "Updated Recipe" },
        }),
      ).rejects.toThrow();
    });

    it("should handle recipe with invalid ingredient references", async () => {
      const createCaller = createCallerFactory(recipeRouter);
      const caller = createCaller(
        createTestTRPCContext(prisma, { auth: undefined }),
      );

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
                  ingredientId: "00000000-0000-0000-0000-000000000000", // Non-existent
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
      const createCaller = createCallerFactory(recipeRouter);
      const caller = createCaller(
        createTestTRPCContext(prisma, { auth: undefined }),
      );

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
                  recipeId: "00000000-0000-0000-0000-000000000000", // Non-existent
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
      const createCaller = createCallerFactory(ingredientRouter);
      const caller = createCaller(
        createTestTRPCContext(prisma, { auth: undefined }),
      );

      // Empty name is actually allowed by the current schema
      const result = await caller.create({
        name: "", // Empty name is permitted
        aliases: [],
      });

      expect(result).toBeDefined();
      expect(result.name).toBe("");
    });

    it("should handle duplicate ingredient names", async () => {
      const createCaller = createCallerFactory(ingredientRouter);
      const caller = createCaller(
        createTestTRPCContext(prisma, { auth: undefined }),
      );

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
      const createCaller = createCallerFactory(ingredientRouter);
      const caller = createCaller(
        createTestTRPCContext(prisma, { auth: undefined }),
      );

      const nonExistentId = "00000000-0000-0000-0000-000000000000";

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
      const createCaller = createCallerFactory(locationRouter);
      const caller = createCaller(
        createTestTRPCContext(prisma, { auth: undefined }),
      );

      // Empty names are allowed per schema
      const result = await caller.create({
        name: "", // Empty name is allowed
        type: "room",
        parentId: null,
        pendingImageIds: [],
      });

      expect(result.name).toBe("");
      expect(result.type).toBe("room");
    });

    it("should throw error when creating location with invalid parent", async () => {
      const createCaller = createCallerFactory(locationRouter);
      const caller = createCaller(
        createTestTRPCContext(prisma, { auth: undefined }),
      );

      // Try to create location with non-existent parent
      await expect(
        caller.create({
          name: "Child Location",
          type: "shelf",
          parentId: "00000000-0000-0000-0000-000000000000", // Non-existent, using correct field name
          pendingImageIds: [],
        }),
      ).rejects.toThrow();
    });

    it("should throw error when creating circular parent-child relationship", async () => {
      const createCaller = createCallerFactory(locationRouter);
      const caller = createCaller(
        createTestTRPCContext(prisma, { auth: undefined }),
      );

      // Create parent location (using valid location type)
      const parent = await caller.create({
        name: "Parent Location",
        type: "room", // Valid enum value
        parentId: null, // Correct field name
        pendingImageIds: [],
      });

      // Create child location
      const child = await caller.create({
        name: "Child Location",
        type: "shelf", // Valid enum value
        parentId: parent.id, // Correct field name
        pendingImageIds: [],
      });

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
      const createCaller = createCallerFactory(productRouter);
      const caller = createCaller(
        createTestTRPCContext(prisma, { auth: undefined }),
      );

      // Test that negative page size causes database error (Prisma validates skip must be positive)
      await expect(
        caller.list({
          filters: {},
          pagination: { pageSize: 10, pageIndex: -1 }, // -1 * 10 = -10 skip
          sort: { orderBy: "name", direction: "asc" },
        }),
      ).rejects.toThrow(/Invalid value for skip argument/);

      // Test normal pagination works
      const result = await caller.list({
        filters: {},
        pagination: { pageSize: 10, pageIndex: 0 },
        sort: { orderBy: "name", direction: "asc" },
      });
      expect(result).toBeDefined();
      expect(result.meta.pageSize).toBe(10);
      expect(result.meta.pageIndex).toBe(0);
    });

    it("should handle sort parameters gracefully", async () => {
      const createCaller = createCallerFactory(productRouter);
      const caller = createCaller(
        createTestTRPCContext(prisma, { auth: undefined }),
      );

      // Test valid sort parameters work
      const result1 = await caller.list({
        filters: {},
        pagination: { pageSize: 10, pageIndex: 0 },
        sort: { orderBy: "name", direction: "asc" },
      });
      expect(result1).toBeDefined();

      // Test another valid sort field
      const result2 = await caller.list({
        filters: {},
        pagination: { pageSize: 10, pageIndex: 0 },
        sort: { orderBy: "createdAt", direction: "desc" },
      });
      expect(result2).toBeDefined();
    });

    it("should validate UPC format", async () => {
      const createCaller = createCallerFactory(productRouter);
      const caller = createCaller(
        createTestTRPCContext(prisma, { auth: undefined }),
      );

      // Try to create product with invalid UPC format
      await expect(
        caller.create({
          name: "Test Product",
          manufacturer: "Test Manufacturer",
          model: "TEST-123",
          upc: "invalid-upc-format", // Should be numeric
          ndb_number: null,
          ingredientId: null,
        }),
      ).rejects.toThrow();
    });
  });

  describe("Database Constraint Violations", () => {
    it("should handle database transaction failures gracefully", async () => {
      const createCaller = createCallerFactory(recipeRouter);
      const caller = createCaller(
        createTestTRPCContext(prisma, { auth: undefined }),
      );

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
                  ingredientId: "00000000-0000-0000-0000-000000000000",
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
                  ingredientId: "00000000-0000-0000-0000-000000000000",
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
      const recipes = await caller.list({
        filters: {},
        pagination: { pageSize: 10, pageIndex: 0 },
        sort: { orderBy: "name", direction: "asc" },
      });

      expect(recipes.items).toHaveLength(0);
    });
  });
});
