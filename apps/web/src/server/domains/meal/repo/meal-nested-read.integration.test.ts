import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { buildEntity } from "tooling/factories/build";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { readPublicEntityRows } from "~/server/generic/derived/service/public-read";
import {
  createRecipeFixture,
  makeRecipeInput,
} from "~/server/testing/repo.fixtures";

import { addRecipeToMeal, createMealWithEntityId } from "./crud";

describe("Meal nested Recipe envelopes", () => {
  const ctx = withTestDb();
  it("projects repeated scalar Recipes with authoritative servings and preserves occurrence evidence", async () => {
    const recipe = await createRecipeFixture(
      ctx.db,
      {
        ...makeRecipeInput({ name: "Synthetic nested meal recipe" }),
        servings: 6,
      },
      ctx.actor,
    );
    const meal = await createMealWithEntityId(
      ctx.db,
      buildEntity("meal", {
        date: "2026-10-01",
        name: "Synthetic nested recipe meal",
      }),
      ctx.actor,
    );
    const first = await addRecipeToMeal(
      ctx.db,
      meal.entityId,
      {
        recipeId: recipe.id,
        scale: 2,
        sortOrder: 0,
      },
      ctx.actor,
    );
    const second = await addRecipeToMeal(
      ctx.db,
      meal.entityId,
      {
        recipeId: recipe.id,
        scale: 3,
        sortOrder: 1,
      },
      ctx.actor,
    );
    const raw = second.meal;
    const repeated = await readPublicEntityRows({
      db: ctx.db,
      entity: "meal",
      projection: "list",
      rows: Array.from({ length: 20 }, (_, index) => ({
        ...raw,
        recipes: raw.recipes.map((occurrence) => ({
          ...occurrence,
          recipe: {
            ...occurrence.recipe,
            name: `Synthetic snapshot ${index}`,
            servings: 99,
          },
        })),
      })),
    });
    expect(repeated.map((row) => row.recipes[0]?.recipe.name)).toEqual(
      Array.from({ length: 20 }, (_, index) => `Synthetic snapshot ${index}`),
    );
    for (const row of repeated) {
      expect(
        row.recipes.map((occurrence) => [occurrence.id, occurrence.scale]),
      ).toEqual([
        [first.mealRecipeId, 2],
        [second.mealRecipeId, 3],
      ]);
      for (const [index, occurrence] of row.recipes.entries()) {
        expect(
          occurrence.recipe.fields.servings.current.assignment,
        ).toMatchObject({ kind: "value", value: 6 });
        expect(fieldValueOf(occurrence.recipe.fields.servings)).toBe(6);
        expect(occurrence.recipe.fields.totals).toHaveProperty("result.kind");
        expect(occurrence.recipe).not.toHaveProperty("servings");
        expect(occurrence.recipe).not.toHaveProperty("totals");
        expect(occurrence.recipe).not.toHaveProperty("fieldResolutions");
        expect(occurrence.recipe).not.toHaveProperty("sections");
        expect(occurrence.recipe.yield).toEqual(
          raw.recipes[index]?.recipe.yield,
        );
        expect(occurrence.scaledTotals).toEqual(
          raw.recipes[index]?.scaledTotals,
        );
        expect(occurrence.estimatedYieldGrams).toEqual(
          raw.recipes[index]?.estimatedYieldGrams,
        );
        expect(occurrence.actualYieldGrams).toEqual(
          raw.recipes[index]?.actualYieldGrams,
        );
      }
    }
  });
});
