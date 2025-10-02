import { beforeEach, describe, expect, it } from "vitest";
import { type Database } from "~/server/db";
import { buildTestDB } from "tooling/test-setup";
import { upsertRecipe } from "./recipe";
import { type RecipeCreateInput } from "~/schemas/recipe";
import { unsafeIngredientId, type ProjectId } from "~/schemas/identifiers";

describe("upsertRecipe", () => {
  let db: Database;
  let projectId: ProjectId;

  let testIngredients: { id: string; name: string }[] = [];
  beforeEach(async () => {
    const { db: dbInstance, projectId: pId, teardown } = await buildTestDB();
    db = dbInstance;
    projectId = pId;

    // Create the required ingredients for the tests and store their IDs
    const ingredient1 = await db.ingredient.create({
      data: {
        projectId,
        name: "Test Ingredient 1",
        aliases: [],
      },
    });
    const ingredient2 = await db.ingredient.create({
      data: {
        projectId,
        name: "Test Ingredient 2",
        aliases: [],
      },
    });
    const ingredient3 = await db.ingredient.create({
      data: {
        projectId,
        name: "Test Ingredient 3",
        aliases: [],
      },
    });

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
    const result = await upsertRecipe(getMockRecipeInput(), db, projectId);

    expect(result.id).toBeDefined();

    // Verify recipe was created
    const recipe = await db.recipe.findUnique({
      where: {
        projectId_name: {
          projectId: projectId,
          name: "Test Recipe Direct",
        },
      },
      include: {
        sections: {
          include: {
            ingredients: true,
          },
        },
      },
    });

    expect(recipe).toBeTruthy();
    expect(recipe!.name).toBe("Test Recipe Direct");
    expect(recipe!.SourceType).toBe("Website");
    expect(recipe!.SourceData).toBe("https://example.com/recipe");
    expect(recipe!.sections).toHaveLength(1);
    expect(recipe!.sections[0]!.ingredients).toHaveLength(2);
  });

  it("updates an existing recipe when it already exists", async () => {
    // First, create the recipe
    const firstResult = await upsertRecipe(getMockRecipeInput(), db, projectId);

    // Now update with different data
    const secondResult = await upsertRecipe(
      getMockRecipeUpdated(),
      db,
      projectId,
    );

    // Should return same recipe ID (updated, not created new)
    expect(secondResult.id).toBe(firstResult.id);

    // Verify the recipe was updated
    const updatedRecipe = await db.recipe.findUnique({
      where: {
        projectId_name: {
          projectId: projectId,
          name: "Test Recipe Direct",
        },
      },
      include: {
        sections: {
          include: {
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
    const firstRun = await upsertRecipe(getMockRecipeInput(), db, projectId);
    const secondRun = await upsertRecipe(getMockRecipeInput(), db, projectId); // Same input
    const thirdRun = await upsertRecipe(getMockRecipeInput(), db, projectId); // Same input again

    // All should return the same recipe ID
    expect(secondRun.id).toBe(firstRun.id);
    expect(thirdRun.id).toBe(firstRun.id);

    // Should only be one recipe in the database
    const allRecipes = await db.recipe.findMany({
      where: {
        projectId: projectId,
        name: "Test Recipe Direct",
      },
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

    await upsertRecipe(recipeNoUrl, db, projectId);

    const recipe = await db.recipe.findUnique({
      where: {
        projectId_name: {
          projectId: projectId,
          name: "Manual Recipe",
        },
      },
    });

    expect(recipe!.SourceType).toBe("Other");
    expect(recipe!.SourceData).toBeNull();
  });
});
