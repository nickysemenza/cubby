import type { ActorContext } from "@cubby/schemas/context";
import { eq, inArray, ne } from "drizzle-orm";
import { buildTestDB } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "~/server/db";
import {
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import { getDb } from "./database-helpers";
import { upsertImportRecipe } from "./import-recipe-convert";
import { makeImportRecipe } from "./repo.fixtures";

describe("upsertImportRecipe", () => {
  let db: Database;
  let actor: ActorContext;
  let teardown: () => Promise<void>;
  beforeEach(async () => {
    ({ db, actor, teardown } = await buildTestDB());
    return teardown;
  });

  const mockRecipe = makeImportRecipe({
    meta: { title: "Test Recipe" },
    url: "https://example.com/recipe",
    sections: [
      {
        instructions: ["Mix ingredients", "Bake for 30 minutes"],
        ingredients: ["2 cups flour", "1 cup sugar"],
      },
    ],
  });

  const mockRecipeUpdated = makeImportRecipe({
    meta: { title: "Test Recipe" }, // Same name
    url: "https://example.com/recipe-updated",
    sections: [
      {
        // Updated instructions
        instructions: ["Mix ingredients well", "Bake for 35 minutes"],
        // Updated amount, different second ingredient (sugar → butter)
        ingredients: ["3 cups flour", "0.5 cup butter"],
      },
      {
        instructions: ["Sprinkle on top"],
        ingredients: ["1 tsp cinnamon"],
      },
    ],
  });

  it("creates a new recipe when it doesn't exist", async () => {
    const result = await upsertImportRecipe(mockRecipe, db, actor);

    expect(result.id).toBeDefined();

    // Verify recipe was created
    const foundRecipe = await getDb(db).query.recipe.findFirst({
      where: eq(recipe.name, "Test Recipe"),
      with: {
        sections: {
          with: {
            ingredients: true,
          },
        },
      },
    });

    expect(foundRecipe).toBeTruthy();
    expect(foundRecipe!.name).toBe("Test Recipe");
    expect(foundRecipe!.SourceType).toBe("Website");
    expect(foundRecipe!.SourceData).toBe("https://example.com/recipe");
    expect(foundRecipe!.sections).toHaveLength(1);
    expect(foundRecipe!.sections[0]!.ingredients).toHaveLength(2);
  });

  it("updates an existing recipe when it already exists", async () => {
    // First, create the recipe
    const firstResult = await upsertImportRecipe(mockRecipe, db, actor);

    // Verify initial state
    const initialRecipe = await getDb(db).query.recipe.findFirst({
      where: eq(recipe.name, "Test Recipe"),
      with: {
        sections: {
          with: {
            ingredients: true,
          },
        },
      },
    });

    expect(initialRecipe!.sections).toHaveLength(1);
    expect(initialRecipe!.sections[0]!.ingredients).toHaveLength(2);

    // Now update with different data
    const secondResult = await upsertImportRecipe(mockRecipeUpdated, db, actor);

    // Should return same recipe ID (updated, not created new)
    expect(secondResult.id).toBe(firstResult.id);

    // Verify the recipe was updated
    const updatedRecipe = await getDb(db).query.recipe.findFirst({
      where: eq(recipe.name, "Test Recipe"),
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

    // Check first section was updated (sections should be in order)
    const firstSection = updatedRecipe!.sections[0];
    expect(firstSection!.ingredients).toHaveLength(2); // flour + butter (sugar removed)

    // Check new section was added
    const secondSection = updatedRecipe!.sections[1];
    expect(secondSection).toBeTruthy();
    expect(secondSection!.ingredients).toHaveLength(1); // cinnamon
  });

  it("handles multiple upserts correctly (back-to-back npm run load-data scenario)", async () => {
    // This tests the exact scenario mentioned - running load-data multiple times
    const firstRun = await upsertImportRecipe(mockRecipe, db, actor);
    const secondRun = await upsertImportRecipe(mockRecipe, db, actor); // Same recipe
    const thirdRun = await upsertImportRecipe(mockRecipe, db, actor); // Same recipe again

    // All should return the same recipe ID
    expect(secondRun.id).toBe(firstRun.id);
    expect(thirdRun.id).toBe(firstRun.id);

    // Should only be one recipe in the database
    const allRecipes = await getDb(db).query.recipe.findMany({
      where: eq(recipe.name, "Test Recipe"),
    });

    expect(allRecipes).toHaveLength(1);
  });

  it("properly cleans up old sections and ingredients", async () => {
    // Create recipe with 2 sections
    await upsertImportRecipe(mockRecipeUpdated, db, actor);

    const beforeUpdate = await getDb(db).query.recipe.findFirst({
      where: eq(recipe.name, "Test Recipe"),
      with: { sections: { with: { ingredients: true } } },
    });

    const sectionCountBefore = beforeUpdate!.sections.length;
    const ingredientCountBefore = beforeUpdate!.sections.reduce(
      (total: number, section: { ingredients: unknown[] }) =>
        total + section.ingredients.length,
      0,
    );

    // Update to recipe with 1 section
    await upsertImportRecipe(mockRecipe, db, actor);

    const afterUpdate = await getDb(db).query.recipe.findFirst({
      where: eq(recipe.name, "Test Recipe"),
      with: { sections: { with: { ingredients: true } } },
    });

    const sectionCountAfter = afterUpdate!.sections.length;
    const ingredientCountAfter = afterUpdate!.sections.reduce(
      (total: number, section: { ingredients: unknown[] }) =>
        total + section.ingredients.length,
      0,
    );

    // Verify data was properly cleaned up and replaced
    expect(sectionCountAfter).toBe(1);
    expect(sectionCountAfter).toBeLessThan(sectionCountBefore);
    expect(ingredientCountAfter).toBe(2);
    expect(ingredientCountAfter).toBeLessThan(ingredientCountBefore);

    // Verify no dangling section/ingredient rows remain for this recipe.
    // Section replacement hard-deletes the old rows (matching updateRecipe), so these
    // raw queries — which do NOT filter soft-deletes — must see exactly the new rows,
    // not the union of old + new. This guards against the unbounded dead-row
    // accumulation that soft-deleting old sections used to cause on repeated upserts.
    const allSectionsForRecipe = await getDb(db).query.recipeSection.findMany({
      where: eq(recipeSection.recipeId, afterUpdate!.id),
    });
    expect(allSectionsForRecipe).toHaveLength(1);

    const allIngredientsForRecipe = await getDb(
      db,
    ).query.recipeSectionIngredient.findMany({
      where: inArray(
        recipeSectionIngredient.recipeSectionId,
        allSectionsForRecipe.map((s) => s.id),
      ),
    });
    expect(allIngredientsForRecipe).toHaveLength(2);

    // Verify no orphaned records exist for any other recipe either
    const orphanedSections = await getDb(db).query.recipeSection.findMany({
      where: ne(recipeSection.recipeId, afterUpdate!.id),
    });
    expect(orphanedSections).toHaveLength(0);
  });
});
