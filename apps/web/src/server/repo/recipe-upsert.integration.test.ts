import type { RecipeCreateInput } from "@cubby/schemas/recipe";
import { asc, eq } from "drizzle-orm";
import { raceUniqueInsert, withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";

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
  const ctx = withTestDb();

  let testIngredients: { id: string; name: string }[] = [];
  beforeEach(async () => {
    testIngredients = await createIngredients(
      ctx.db,
      ["Test Ingredient 1", "Test Ingredient 2", "Test Ingredient 3"],
      ctx.actor,
    );
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

  it("can be called multiple times without conflicts", async () => {
    const firstRun = await upsertRecipe(
      getMockRecipeInput(),
      ctx.db,
      ctx.actor,
    );
    const secondRun = await upsertRecipe(
      getMockRecipeInput(),
      ctx.db,
      ctx.actor,
    );
    const thirdRun = await upsertRecipe(
      getMockRecipeInput(),
      ctx.db,
      ctx.actor,
    );

    expect(secondRun.id).toBe(firstRun.id);
    expect(thirdRun.id).toBe(firstRun.id);

    const allRecipes = await getDb(ctx.db).query.recipe.findMany({
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

    const { winner: winnerId, loser: result } = await raceUniqueInsert(ctx, {
      winner: ({ releaseSignal, markWinnerReady }) =>
        getDb(ctx.db).transaction(async (tx) => {
          const [row] = await tx
            .insert(recipe)
            .values({
              name,
              shortcode: "RACER1",
              SourceType: "Website",
              SourceData: "https://example.com/winner",
            })
            .returning();
          markWinnerReady();
          await releaseSignal; // hold the txn (and its lock) open
          return row!.id;
        }),
      loser: () =>
        upsertRecipe(
          makeRecipeInput({ name, url: "https://example.com/loser" }),
          ctx.db,
          ctx.actor,
        ),
    });

    // The upsert recovered onto the winner's row — no throw, no duplicate.
    expect(result.id).toBe(winnerId);
    const allRecipes = await getDb(ctx.db).query.recipe.findMany({
      where: eq(recipe.name, name),
    });
    expect(allRecipes).toHaveLength(1);
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

    const { id } = await upsertRecipe(input, ctx.db, ctx.actor);
    const sections = await getDb(ctx.db).query.recipeSection.findMany({
      where: eq(recipeSection.recipeId, id),
      orderBy: [asc(recipeSection.sortOrder)],
      with: { ingredients: true },
    });

    expect(sections.map((s) => s.name)).toEqual(["Batter", "Bake"]);
    expect(sections[0]!.instructions).toEqual([]);
    expect(sections[1]!.instructions).toEqual([{ text: "Bake until set" }]);
    expect(sections[1]!.ingredients).toEqual([]);

    const [row] = await getDb(ctx.db)
      .select()
      .from(recipeSectionIngredient)
      .where(eq(recipeSectionIngredient.recipeSectionId, sections[0]!.id));

    expect(row?.rawLine).toBe("2 cups flour, sifted");
    expect(row?.modifier).toBe("sifted");
    expect(row?.sortOrder).toBe(0);
  });
});
