import { eq, inArray, ne } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import {
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import { getDb } from "./database-helpers";
import { upsertImportRecipe } from "./import-recipe-convert";
import { makeImportRecipe } from "./repo.fixtures";

describe("upsertImportRecipe", () => {
  const ctx = withTestDb();

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
    meta: { title: "Test Recipe" },
    url: "https://example.com/recipe-updated",
    sections: [
      {
        instructions: ["Mix ingredients well", "Bake for 35 minutes"],
        ingredients: ["3 cups flour", "0.5 cup butter"],
      },
      {
        instructions: ["Sprinkle on top"],
        ingredients: ["1 tsp cinnamon"],
      },
    ],
  });

  it("creates a new recipe when it doesn't exist", async () => {
    const result = await upsertImportRecipe(mockRecipe, ctx.db, ctx.actor);

    expect(result.id).toBeDefined();

    const foundRecipe = await getDb(ctx.db).query.recipe.findFirst({
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

  it("parses raw lines into amounts + rawLine and resolves servings (create_recipe_from_text path)", async () => {
    // The `create_recipe_from_text` MCP tool builds exactly this ImportRecipe
    // (raw ingredient/instruction lines, top-level servings) and calls
    // recipe.insertImport → upsertImportRecipe. This asserts the effective output.
    const fromText = makeImportRecipe({
      meta: { title: "Test Prep Sheet" },
      servings: 2,
      sections: [
        {
          instructions: ["Cook rice.", "Add aromatics."],
          ingredients: [
            "1 cup jasmine rice",
            "2 scallions, sliced",
            "1 tbsp soy sauce",
          ],
        },
      ],
    });

    const result = await upsertImportRecipe(fromText, ctx.db, ctx.actor);

    const found = await getDb(ctx.db).query.recipe.findFirst({
      where: eq(recipe.id, result.id),
      with: { sections: { with: { ingredients: true } } },
    });

    expect(found!.servings).toBe(2);
    expect(found!.sections).toHaveLength(1);
    const ingredients = found!.sections[0]!.ingredients;
    expect(ingredients).toHaveLength(3);

    const rice = ingredients.find((i) => i.rawLine === "1 cup jasmine rice");
    expect(rice).toBeTruthy();
    expect(rice!.amounts?.[0]).toMatchObject({ value: 1, unit: "cup" });

    const soy = ingredients.find((i) => i.rawLine === "1 tbsp soy sauce");
    expect(soy!.amounts?.[0]).toMatchObject({ value: 1, unit: "tbsp" });

    expect(new Set(ingredients.map((i) => i.ingredientId)).size).toBe(3);
  });

  it("updates an existing recipe when it already exists", async () => {
    const firstResult = await upsertImportRecipe(mockRecipe, ctx.db, ctx.actor);

    const initialRecipe = await getDb(ctx.db).query.recipe.findFirst({
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

    const secondResult = await upsertImportRecipe(
      mockRecipeUpdated,
      ctx.db,
      ctx.actor,
    );

    expect(secondResult.id).toBe(firstResult.id);

    const updatedRecipe = await getDb(ctx.db).query.recipe.findFirst({
      where: eq(recipe.name, "Test Recipe"),
      with: {
        sections: {
          with: {
            ingredients: true,
          },
        },
      },
    });

    expect(updatedRecipe!.id).toBe(firstResult.id);
    expect(updatedRecipe!.SourceData).toBe(
      "https://example.com/recipe-updated",
    );
    expect(updatedRecipe!.sections).toHaveLength(2);

    const firstSection = updatedRecipe!.sections[0];
    expect(firstSection!.ingredients).toHaveLength(2);

    const secondSection = updatedRecipe!.sections[1];
    expect(secondSection).toBeTruthy();
    expect(secondSection!.ingredients).toHaveLength(1);
  });

  it("re-import updates yield/servings and preserves manually-set tags", async () => {
    const first = await upsertImportRecipe(
      makeImportRecipe({
        meta: {
          title: "Yield Recipe",
          recipe_yield: { value: 2, unit: "loaves" },
        },
        servings: 4,
        sections: [{ instructions: ["Mix"], ingredients: ["2 cups flour"] }],
      }),
      ctx.db,
      ctx.actor,
    );

    // Web imports cannot express tags, so a manual tag must survive re-import.
    await getDb(ctx.db)
      .update(recipe)
      .set({ tags: ["dinner"] })
      .where(eq(recipe.id, first.id));

    const second = await upsertImportRecipe(
      makeImportRecipe({
        meta: {
          title: "Yield Recipe",
          recipe_yield: { value: 4, unit: "loaves" },
        },
        servings: 8,
        sections: [{ instructions: ["Mix"], ingredients: ["2 cups flour"] }],
      }),
      ctx.db,
      ctx.actor,
    );
    expect(second.id).toBe(first.id);

    const updated = await getDb(ctx.db).query.recipe.findFirst({
      where: eq(recipe.id, first.id),
    });
    expect(updated!.servings).toBe(8);
    expect(updated!.yield).toEqual({ value: 4, unit: "loaves" });
    expect(updated!.tags).toEqual(["dinner"]);
  });

  it("handles multiple upserts correctly (back-to-back npm run load-data scenario)", async () => {
    const firstRun = await upsertImportRecipe(mockRecipe, ctx.db, ctx.actor);
    const secondRun = await upsertImportRecipe(mockRecipe, ctx.db, ctx.actor);
    const thirdRun = await upsertImportRecipe(mockRecipe, ctx.db, ctx.actor);

    expect(secondRun.id).toBe(firstRun.id);
    expect(thirdRun.id).toBe(firstRun.id);

    const allRecipes = await getDb(ctx.db).query.recipe.findMany({
      where: eq(recipe.name, "Test Recipe"),
    });

    expect(allRecipes).toHaveLength(1);
  });

  it("properly cleans up old sections and ingredients", async () => {
    await upsertImportRecipe(mockRecipeUpdated, ctx.db, ctx.actor);

    const beforeUpdate = await getDb(ctx.db).query.recipe.findFirst({
      where: eq(recipe.name, "Test Recipe"),
      with: { sections: { with: { ingredients: true } } },
    });

    const sectionCountBefore = beforeUpdate!.sections.length;
    const ingredientCountBefore = beforeUpdate!.sections.reduce(
      (total: number, section: { ingredients: unknown[] }) =>
        total + section.ingredients.length,
      0,
    );

    await upsertImportRecipe(mockRecipe, ctx.db, ctx.actor);

    const afterUpdate = await getDb(ctx.db).query.recipe.findFirst({
      where: eq(recipe.name, "Test Recipe"),
      with: { sections: { with: { ingredients: true } } },
    });

    const sectionCountAfter = afterUpdate!.sections.length;
    const ingredientCountAfter = afterUpdate!.sections.reduce(
      (total: number, section: { ingredients: unknown[] }) =>
        total + section.ingredients.length,
      0,
    );

    expect(sectionCountAfter).toBe(1);
    expect(sectionCountAfter).toBeLessThan(sectionCountBefore);
    expect(ingredientCountAfter).toBe(2);
    expect(ingredientCountAfter).toBeLessThan(ingredientCountBefore);

    // Verify no dangling section/ingredient rows remain for this recipe.
    // Section replacement hard-deletes the old rows (matching updateRecipe), so these
    // raw queries — which do NOT filter soft-deletes — must see exactly the new rows,
    // not the union of old + new. This guards against the unbounded dead-row
    // accumulation that soft-deleting old sections used to cause on repeated upserts.
    const allSectionsForRecipe = await getDb(
      ctx.db,
    ).query.recipeSection.findMany({
      where: eq(recipeSection.recipeId, afterUpdate!.id),
    });
    expect(allSectionsForRecipe).toHaveLength(1);

    const allIngredientsForRecipe = await getDb(
      ctx.db,
    ).query.recipeSectionIngredient.findMany({
      where: inArray(
        recipeSectionIngredient.recipeSectionId,
        allSectionsForRecipe.map((s) => s.id),
      ),
    });
    expect(allIngredientsForRecipe).toHaveLength(2);

    const orphanedSections = await getDb(ctx.db).query.recipeSection.findMany({
      where: ne(recipeSection.recipeId, afterUpdate!.id),
    });
    expect(orphanedSections).toHaveLength(0);
  });
});
