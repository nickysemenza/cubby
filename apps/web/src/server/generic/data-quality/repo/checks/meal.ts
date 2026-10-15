import { sql } from "drizzle-orm";

import { meal } from "~/server/db/schema";

import { defineEntityChecks } from "../registry";

type Meal = typeof meal;

// A MealRecipe row still pointing at a deleted Recipe contributes no food.
const hasRecipe = (t: Meal) => sql`EXISTS (
  SELECT 1 FROM "MealRecipe" dq_meal_recipe
  JOIN "Recipe" dq_meal_live_recipe
    ON dq_meal_live_recipe."id" = dq_meal_recipe."recipeId"
    AND dq_meal_live_recipe."deletedAt" IS NULL
  WHERE dq_meal_recipe."mealId" = ${t.id} AND dq_meal_recipe."deletedAt" IS NULL
)`;

const hasFoodEntry = (t: Meal) => sql`EXISTS (
  SELECT 1 FROM "MealFoodEntry" dq_meal_food
  WHERE dq_meal_food."mealId" = ${t.id} AND dq_meal_food."deletedAt" IS NULL
)`;

export const mealChecks = defineEntityChecks({
  entity: "meal",
  table: meal,
  checks: {
    meal_recipe_cost_incomplete: {
      // Unavailable costs count only with recorded contributors; legacy totals
      // lacking coverage stay out until recomputation or repair-on-read.
      missing: (t) => sql`EXISTS (
        SELECT 1 FROM "MealRecipe" dq_meal_cost
        JOIN "Recipe" dq_recipe_cost ON dq_recipe_cost."id" = dq_meal_cost."recipeId"
        WHERE dq_meal_cost."mealId" = ${t.id}
          AND dq_meal_cost."deletedAt" IS NULL AND dq_recipe_cost."deletedAt" IS NULL
          AND (
            dq_recipe_cost."totals" -> 'cost' ->> 'status' = 'partial'
            OR (dq_recipe_cost."totals" -> 'cost' ->> 'status' = 'unavailable'
              AND COALESCE((dq_recipe_cost."totals" #>> '{cost,coverage,total}')::int, 0) > 0)
          )
      )`,
    },
    meal_contents: {
      // `eating_out`/`takeout`/etc. are deliberately content-free placeholders
      // (see the `mealKind` manifest description) — only a cooked meal is
      // expected to carry recipes or food entries.
      expected: (t) => sql`${t.mealKind} = 'cooked'`,
      missing: (t) => sql`NOT (${hasRecipe(t)} OR ${hasFoodEntry(t)})`,
    },
  },
});
