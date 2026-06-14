import type { ActorContext } from "@cubby/schemas/context";
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
import { upsertRecipe } from "./recipe";
import {
  createIngredients,
  ingredientRef,
  makeRecipeInput,
} from "./repo.fixtures";

describe("upsertRecipe", () => {
  let db: Database;
  let actor: ActorContext;
  let teardown: () => Promise<void>;

  let testIngredients: { id: string; name: string }[] = [];
  beforeEach(async () => {
    ({ db, actor, teardown } = await buildTestDB());

    // Create the required ingredients for the tests and store their IDs
    testIngredients = await createIngredients(
      db,
      ["Test Ingredient 1", "Test Ingredient 2", "Test Ingredient 3"],
      actor,
    );

    return teardown;
  });

  const getMockRecipeInput = (): RecipeCreateInput =>
    makeRecipeInput({
      name: "Test Recipe Direct",
      url: "https://example.com/recipe",
      sections: [
        {
          instructions: [
            { instruction: "Mix ingredients" },
            { instruction: "Bake for 30 minutes" },
          ],
          ingredients: [
            ingredientRef(testIngredients[0]!.id, {
              amounts: [{ value: 2, unit: "cups" }],
            }),
            ingredientRef(testIngredients[1]!.id, {
              amounts: [{ value: 1, unit: "cup" }],
            }),
          ],
        },
      ],
    });

  const getMockRecipeUpdated = (): RecipeCreateInput =>
    makeRecipeInput({
      name: "Test Recipe Direct", // Same name
      url: "https://example.com/recipe-updated",
      sections: [
        {
          instructions: [
            { instruction: "Mix ingredients well" },
            { instruction: "Bake for 35 minutes" },
          ],
          ingredients: [
            ingredientRef(testIngredients[0]!.id, {
              amounts: [{ value: 3, unit: "cups" }], // Same ingredient, different amount
            }),
          ],
        },
        {
          instructions: [{ instruction: "Add topping" }],
          ingredients: [
            ingredientRef(testIngredients[2]!.id, {
              amounts: [{ value: 1, unit: "tsp" }], // New ingredient
            }),
          ],
        },
      ],
    });

  it("creates a new recipe when it doesn't exist", async () => {
    const result = await upsertRecipe(getMockRecipeInput(), db, actor);

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
    const firstResult = await upsertRecipe(getMockRecipeInput(), db, actor);

    // Now update with different data
    const secondResult = await upsertRecipe(getMockRecipeUpdated(), db, actor);

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
    const firstRun = await upsertRecipe(getMockRecipeInput(), db, actor);
    const secondRun = await upsertRecipe(getMockRecipeInput(), db, actor); // Same input
    const thirdRun = await upsertRecipe(getMockRecipeInput(), db, actor); // Same input again

    // All should return the same recipe ID
    expect(secondRun.id).toBe(firstRun.id);
    expect(thirdRun.id).toBe(firstRun.id);

    // Should only be one recipe in the database
    const allRecipes = await getDb(db).query.recipe.findMany({
      where: eq(recipe.name, "Test Recipe Direct"),
    });

    expect(allRecipes).toHaveLength(1);
  });

  it("recovers from a concurrent create race instead of 500ing", async () => {
    // Cross-request race, deterministically forced (the createRecipe arm of
    // runWithConflictRecovery): a "winner" txn inserts the same-named recipe and
    // holds its lock open while our upsert runs. Our upsert's SELECT misses
    // (winner uncommitted), createRecipe's INSERT blocks on the lock; once the
    // winner commits, that INSERT raises a unique violation that aborts
    // createRecipe's own txn. runWithConflictRecovery must then re-SELECT the
    // committed winner and update it, not 500.
    const name = "Race Recipe";

    let releaseWinner!: () => void;
    const winnerCommitted = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });

    let winnerId = "";
    const winner = getDb(db).transaction(async (tx) => {
      const [row] = await tx
        .insert(recipe)
        .values({
          name,
          shortcode: "RACER1",
          SourceType: "Website",
          SourceData: "https://example.com/winner",
        })
        .returning();
      winnerId = row!.id;
      await winnerCommitted; // hold the txn (and its lock) open
    });

    // Let the winner reach (and hold) its uncommitted INSERT.
    await new Promise((r) => setTimeout(r, 100));

    const loser = upsertRecipe(
      makeRecipeInput({ name, url: "https://example.com/loser" }),
      db,
      actor,
    );

    // Give the upsert time to reach its blocked INSERT, then commit the winner.
    await new Promise((r) => setTimeout(r, 100));
    releaseWinner();

    const [, result] = await Promise.all([winner, loser]);

    // The upsert recovered onto the winner's row — no throw, no duplicate.
    expect(result.id).toBe(winnerId);
    const allRecipes = await getDb(db).query.recipe.findMany({
      where: eq(recipe.name, name),
    });
    expect(allRecipes).toHaveLength(1);
  });

  it("works with recipes that have no URL (Other source type)", async () => {
    const recipeNoUrl = makeRecipeInput({
      name: "Manual Recipe",
      sections: [
        {
          instructions: [{ instruction: "Do something" }],
          ingredients: [],
        },
      ],
    });

    await upsertRecipe(recipeNoUrl, db, actor);

    const foundRecipe = await getDb(db).query.recipe.findFirst({
      where: eq(recipe.name, "Manual Recipe"),
    });

    expect(foundRecipe!.SourceType).toBe("Other");
    expect(foundRecipe!.SourceData).toBeNull();
  });

  it("preserves section order, empty arrays, and ingredient provenance", async () => {
    const input = makeRecipeInput({
      name: "Provenance Recipe",
      sections: [
        {
          name: "Batter",
          instructions: [],
          ingredients: [
            ingredientRef(testIngredients[0]!.id, {
              amounts: [{ value: 2, unit: "cups" }],
              rawLine: "2 cups flour, sifted",
              modifier: "sifted",
            }),
          ],
        },
        {
          name: "Bake",
          instructions: [{ instruction: "Bake until set" }],
        },
      ],
    });

    const { id } = await upsertRecipe(input, db, actor);
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
