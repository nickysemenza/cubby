import type { ActorContext } from "@cubby/schemas/context";
import { unsafeIngredientId, unsafeUserId } from "@cubby/schemas/identifiers";
import type { RecipeCreateInput } from "@cubby/schemas/recipe";
import { asc, eq } from "drizzle-orm";
import { buildTestDB } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "~/server/db";
import {
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import { getDb } from "./database-helpers";
import { createIngredient } from "./ingredient";
import { upsertRecipe } from "./recipe";

const TEST_ACTOR: ActorContext = {
  userId: unsafeUserId("test-user-id"),
  source: "ui",
};

describe("upsertRecipe", () => {
  let db: Database;
  let teardown: () => Promise<void>;

  let testIngredients: { id: string; name: string }[] = [];
  beforeEach(async () => {
    ({ db, teardown } = await buildTestDB());

    // Create the required ingredients for the tests and store their IDs
    const ingredient1 = await createIngredient(
      db,
      {
        name: "Test Ingredient 1",
        aliases: [],
      },
      TEST_ACTOR,
    );
    const ingredient2 = await createIngredient(
      db,
      {
        name: "Test Ingredient 2",
        aliases: [],
      },
      TEST_ACTOR,
    );
    const ingredient3 = await createIngredient(
      db,
      {
        name: "Test Ingredient 3",
        aliases: [],
      },
      TEST_ACTOR,
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
    const result = await upsertRecipe(getMockRecipeInput(), db, TEST_ACTOR);

    expect(result.id).toBeDefined();

    // Verify recipe was created
    const foundRecipe = await getDb(db).query.recipe.findFirst({
      where: eq(recipe.name, "Test Recipe Direct"),
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
      TEST_ACTOR,
    );

    // Now update with different data
    const secondResult = await upsertRecipe(
      getMockRecipeUpdated(),
      db,
      TEST_ACTOR,
    );

    // Should return same recipe ID (updated, not created new)
    expect(secondResult.id).toBe(firstResult.id);

    // Verify the recipe was updated
    const updatedRecipe = await getDb(db).query.recipe.findFirst({
      where: eq(recipe.name, "Test Recipe Direct"),
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
    const firstRun = await upsertRecipe(getMockRecipeInput(), db, TEST_ACTOR);
    const secondRun = await upsertRecipe(getMockRecipeInput(), db, TEST_ACTOR); // Same input
    const thirdRun = await upsertRecipe(getMockRecipeInput(), db, TEST_ACTOR); // Same input again

    // All should return the same recipe ID
    expect(secondRun.id).toBe(firstRun.id);
    expect(thirdRun.id).toBe(firstRun.id);

    // Should only be one recipe in the database
    const allRecipes = await getDb(db).query.recipe.findMany({
      where: eq(recipe.name, "Test Recipe Direct"),
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

    await upsertRecipe(recipeNoUrl, db, TEST_ACTOR);

    const foundRecipe = await getDb(db).query.recipe.findFirst({
      where: eq(recipe.name, "Manual Recipe"),
    });

    expect(foundRecipe!.SourceType).toBe("Other");
    expect(foundRecipe!.SourceData).toBeNull();
  });

  it("preserves section order, empty arrays, and ingredient provenance", async () => {
    const input: RecipeCreateInput = {
      name: "Provenance Recipe",
      meta: { url: null },
      sections: [
        {
          name: "Batter",
          instructions: [],
          ingredients: [
            {
              type: "ingredient",
              ingredientId: unsafeIngredientId(testIngredients[0]!.id),
              recipeId: null,
              amounts: [{ value: 2, unit: "cups" }],
              rawLine: "2 cups flour, sifted",
              modifier: "sifted",
            },
          ],
        },
        {
          name: "Bake",
          instructions: [{ instruction: "Bake until set" }],
        },
      ],
    };

    const { id } = await upsertRecipe(input, db, TEST_ACTOR);
    const sections = await getDb(db).query.recipeSection.findMany({
      where: eq(recipeSection.recipeId, id),
      orderBy: [asc(recipeSection.sortOrder)],
      with: { ingredients: true },
    });

    expect(sections.map((s) => s.name)).toEqual(["Batter", "Bake"]);
    expect(sections[0]!.instructions).toEqual([]);
    expect(sections[1]!.instructions).toEqual([{ text: "Bake until set" }]);
    expect(sections[1]!.ingredients).toEqual([]);

    const [row] = await getDb(db)
      .select()
      .from(recipeSectionIngredient)
      .where(eq(recipeSectionIngredient.recipeSectionId, sections[0]!.id));

    expect(row?.rawLine).toBe("2 cups flour, sifted");
    expect(row?.modifier).toBe("sifted");
    expect(row?.sortOrder).toBe(0);
  });
});
