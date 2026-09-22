import { sql } from "drizzle-orm";

import { meal } from "~/server/db/schema";

import { defineEntityChecks } from "../registry";

type Meal = typeof meal;

const hasRecipe = (t: Meal) => sql`EXISTS (
  SELECT 1 FROM "MealRecipe" dq_meal_recipe
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
    meal_contents: {
      // `eating_out`/`takeout`/etc. are deliberately content-free placeholders
      // (see the `mealKind` manifest description) — only a cooked meal is
      // expected to carry recipes or food entries.
      expected: (t) => sql`${t.mealKind} = 'cooked'`,
      missing: (t) => sql`NOT (${hasRecipe(t)} OR ${hasFoodEntry(t)})`,
    },
  },
});
