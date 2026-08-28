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
import { getRecipeByID } from "./recipe";
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
    await upsertImportRecipe(mockRecipe, ctx.db, ctx.actor);

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

    expect(updatedRecipe!.SourceData).toBe(
      "https://example.com/recipe-updated",
    );
    expect(updatedRecipe!.sections).toHaveLength(2);

    const firstSection = updatedRecipe!.sections[0];
    expect(firstSection!.ingredients).toHaveLength(2);

    expect(updatedRecipe!.sections[1]!.ingredients).toHaveLength(1);
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

  // Times arrive from the extractors as a prose string and a minute count that
  // are independently optional, and the two halves are persisted to different
  // places (minutes → real columns for sorting/filtering, strings + prep/cook
  // minutes → the `meta` jsonb). Both `it.each` rows walk the full
  // import → persist → read round trip so a split that drops a half fails here.
  it.each([
    {
      label: "prose and minutes together (ISO-8601 source)",
      times: {
        total: "1 hour 30 minutes",
        total_minutes: 90,
        active: "20 minutes",
        active_minutes: 20,
        prep: "15 minutes",
        prep_minutes: 15,
        cook: "1 hour 15 minutes",
        cook_minutes: 75,
      },
      expectedColumns: { activeMinutes: 20, totalMinutes: 90 },
      expectedTimes: {
        total: "1 hour 30 minutes",
        totalMinutes: 90,
        active: "20 minutes",
        activeMinutes: 20,
        prep: "15 minutes",
        prepMinutes: 15,
        cook: "1 hour 15 minutes",
        cookMinutes: 75,
      },
    },
    {
      // The EPUB extractor refuses to guess a number for a range or an
      // open-ended phrase, so the string is all there is. It must still be
      // stored and rendered — dropping it would lose the only thing the source
      // said — while the sortable columns stay NULL.
      label: "prose present, minutes absent (unparseable printed time)",
      times: {
        total: "1 to 2 hours, plus overnight chilling",
        active: "about 30 minutes",
      },
      expectedColumns: { activeMinutes: null, totalMinutes: null },
      expectedTimes: {
        total: "1 to 2 hours, plus overnight chilling",
        totalMinutes: null,
        active: "about 30 minutes",
        activeMinutes: null,
        prep: null,
        prepMinutes: null,
        cook: null,
        cookMinutes: null,
      },
    },
  ])(
    "round-trips times, equipment, and page — $label",
    async ({ times, expectedColumns, expectedTimes }) => {
      const title = `Timed Recipe ${expectedColumns.totalMinutes ?? "none"}`;
      const { id } = await upsertImportRecipe(
        makeImportRecipe({
          meta: {
            title,
            times,
            equipment: ["stand mixer", "  ", "9-inch cake pan"],
            page: "142",
          },
          sections: [{ instructions: ["Mix"], ingredients: ["2 cups flour"] }],
        }),
        ctx.db,
        ctx.actor,
      );

      const row = await getDb(ctx.db).query.recipe.findFirst({
        where: eq(recipe.id, id),
      });
      expect(row).toMatchObject(expectedColumns);

      const read = await getRecipeByID(ctx.db, id);
      expect(read!.meta?.times).toMatchObject(expectedTimes);
      // Blank equipment lines are dropped on the way in, not on the way out.
      expect(read!.meta?.equipment).toEqual(["stand mixer", "9-inch cake pan"]);
      expect(read!.meta?.page).toBe("142");
    },
  );

  it("re-import clears times the source stopped printing", async () => {
    const withTimes = makeImportRecipe({
      meta: {
        title: "Retimed Recipe",
        times: { total: "45 minutes", total_minutes: 45 },
        page: "7",
      },
      sections: [{ instructions: ["Mix"], ingredients: ["2 cups flour"] }],
    });
    const first = await upsertImportRecipe(withTimes, ctx.db, ctx.actor);

    // Same recipe, source no longer prints a time or a page: like yield/servings,
    // the source owns these, so a re-import must not leave the old values behind.
    const second = await upsertImportRecipe(
      makeImportRecipe({
        meta: { title: "Retimed Recipe" },
        sections: [{ instructions: ["Mix"], ingredients: ["2 cups flour"] }],
      }),
      ctx.db,
      ctx.actor,
    );
    expect(second.id).toBe(first.id);

    const row = await getDb(ctx.db).query.recipe.findFirst({
      where: eq(recipe.id, first.id),
    });
    expect(row!.totalMinutes).toBeNull();
    expect(row!.meta).toBeNull();
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
    expect(ingredientCountAfter).toBe(2);

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
