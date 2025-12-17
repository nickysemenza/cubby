import { beforeEach, describe, expect, it } from "vitest";
import { type Database } from "~/server/db";
import { buildTestDB } from "tooling/test-setup";
import { upsertRecipe } from "./recipe";
import { createIngredient } from "./ingredient";
import { type RecipeCreateInput } from "~/schemas/recipe";
import {
  unsafeIngredientId,
  type OrganizationId,
  unsafeUserId,
} from "~/schemas/identifiers";
import { getDb } from "./database-helpers";
import { recipe } from "~/server/db/schema";
import { eq, and } from "drizzle-orm";

// Test user ID for audit logging
const TEST_USER_ID = unsafeUserId("test-user-id");

describe("upsertRecipe", () => {
  let db: Database;
  let organizationId: OrganizationId;
  let teardown: () => Promise<void>;

  let testIngredients: { id: string; name: string }[] = [];
  beforeEach(async () => {
    ({ db, organizationId, teardown } = await buildTestDB());

    // Create the required ingredients for the tests and store their IDs
    const ingredient1 = await createIngredient(
      db,
      {
        name: "Test Ingredient 1",
        aliases: [],
      },
      organizationId,
      TEST_USER_ID,
    );
    const ingredient2 = await createIngredient(
      db,
      {
        name: "Test Ingredient 2",
        aliases: [],
      },
      organizationId,
      TEST_USER_ID,
    );
    const ingredient3 = await createIngredient(
      db,
      {
        name: "Test Ingredient 3",
        aliases: [],
      },
      organizationId,
      TEST_USER_ID,
    );

    testIngredients = [ingredient1, ingredient2, ingredient3];

    return teardown;
  });

  const getMockRecipeInput = (): RecipeCreateInput => ({
    name: "Test Recipe Direct",
    meta: {
      url: "https://example.com/recipe",
    },
    sections: [
      {
        instructions: [
          { instruction: "Mix ingredients" },
          { instruction: "Bake for 30 minutes" },
        ],
        ingredients: [
          {
            type: "ingredient" as const,
            ingredientId: unsafeIngredientId(testIngredients[0]!.id),
            recipeId: null,
            amounts: [{ value: 2, unit: "cups" }],
          },
          {
            type: "ingredient" as const,
            ingredientId: unsafeIngredientId(testIngredients[1]!.id),
            recipeId: null,
            amounts: [{ value: 1, unit: "cup" }],
          },
        ],
      },
    ],
  });

  const getMockRecipeUpdated = (): RecipeCreateInput => ({
    name: "Test Recipe Direct", // Same name
    meta: {
      url: "https://example.com/recipe-updated",
    },
    sections: [
      {
        instructions: [
          { instruction: "Mix ingredients well" },
          { instruction: "Bake for 35 minutes" },
        ],
        ingredients: [
          {
            type: "ingredient" as const,
            ingredientId: unsafeIngredientId(testIngredients[0]!.id), // Same ingredient
            recipeId: null,
            amounts: [{ value: 3, unit: "cups" }], // Different amount
          },
        ],
      },
      {
        instructions: [{ instruction: "Add topping" }],
        ingredients: [
          {
            type: "ingredient" as const,
            ingredientId: unsafeIngredientId(testIngredients[2]!.id), // New ingredient
            recipeId: null,
            amounts: [{ value: 1, unit: "tsp" }],
          },
        ],
      },
    ],
  });

  it("creates a new recipe when it doesn't exist", async () => {
    const result = await upsertRecipe(
      getMockRecipeInput(),
      db,
      organizationId,
      TEST_USER_ID,
    );

    expect(result.id).toBeDefined();

    // Verify recipe was created
    const foundRecipe = await getDb(db).query.recipe.findFirst({
      where: and(
        eq(recipe.organizationId, organizationId),
        eq(recipe.name, "Test Recipe Direct"),
      ),
      with: {
        sections: {
          with: {
            ingredients: true,
          },
        },
      },
    });

    expect(foundRecipe).toBeTruthy();
    expect(foundRecipe!.name).toBe("Test Recipe Direct");
    expect(foundRecipe!.SourceType).toBe("Website");
    expect(foundRecipe!.SourceData).toBe("https://example.com/recipe");
    expect(foundRecipe!.sections).toHaveLength(1);
    expect(foundRecipe!.sections[0]!.ingredients).toHaveLength(2);
  });

  it("updates an existing recipe when it already exists", async () => {
    // First, create the recipe
    const firstResult = await upsertRecipe(
      getMockRecipeInput(),
      db,
      organizationId,
      TEST_USER_ID,
    );

    // Now update with different data
    const secondResult = await upsertRecipe(
      getMockRecipeUpdated(),
      db,
      organizationId,
      TEST_USER_ID,
    );

    // Should return same recipe ID (updated, not created new)
    expect(secondResult.id).toBe(firstResult.id);

    // Verify the recipe was updated
    const updatedRecipe = await getDb(db).query.recipe.findFirst({
      where: and(
        eq(recipe.organizationId, organizationId),
        eq(recipe.name, "Test Recipe Direct"),
      ),
      with: {
        sections: {
          with: {
            ingredients: true,
          },
        },
      },
    });

    expect(updatedRecipe!.id).toBe(firstResult.id); // Same recipe
    expect(updatedRecipe!.SourceData).toBe(
      "https://example.com/recipe-updated",
    ); // Updated URL
    expect(updatedRecipe!.sections).toHaveLength(2); // Now has 2 sections

    // Check first section was updated
    const firstSection = updatedRecipe!.sections[0];
    expect(firstSection!.ingredients).toHaveLength(1); // Now only 1 ingredient

    // Check new section was added
    const secondSection = updatedRecipe!.sections[1];
    expect(secondSection).toBeTruthy();
    expect(secondSection!.ingredients).toHaveLength(1); // New ingredient
  });

  it("can be called multiple times without conflicts", async () => {
    // This tests that the function is idempotent
    const firstRun = await upsertRecipe(
      getMockRecipeInput(),
      db,
      organizationId,
      TEST_USER_ID,
    );
    const secondRun = await upsertRecipe(
      getMockRecipeInput(),
      db,
      organizationId,
      TEST_USER_ID,
    ); // Same input
    const thirdRun = await upsertRecipe(
      getMockRecipeInput(),
      db,
      organizationId,
      TEST_USER_ID,
    ); // Same input again

    // All should return the same recipe ID
    expect(secondRun.id).toBe(firstRun.id);
    expect(thirdRun.id).toBe(firstRun.id);

    // Should only be one recipe in the database
    const allRecipes = await getDb(db).query.recipe.findMany({
      where: and(
        eq(recipe.organizationId, organizationId),
        eq(recipe.name, "Test Recipe Direct"),
      ),
    });

    expect(allRecipes).toHaveLength(1);
  });

  it("works with recipes that have no URL (Other source type)", async () => {
    const recipeNoUrl: RecipeCreateInput = {
      name: "Manual Recipe",
      meta: {
        url: null,
      },
      sections: [
        {
          instructions: [{ instruction: "Do something" }],
          ingredients: [],
        },
      ],
    };

    await upsertRecipe(recipeNoUrl, db, organizationId, TEST_USER_ID);

    const foundRecipe = await getDb(db).query.recipe.findFirst({
      where: and(
        eq(recipe.organizationId, organizationId),
        eq(recipe.name, "Manual Recipe"),
      ),
    });

    expect(foundRecipe!.SourceType).toBe("Other");
    expect(foundRecipe!.SourceData).toBeNull();
  });
});
