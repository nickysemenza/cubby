import { and, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { meal } from "~/server/db/retained-tables";
import { entityDisplayImagePresenceSql } from "~/server/entity-kernel/repo/entity-display-image";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

const MEAL_QUALITY_RULES_VERSION = 1;

type MealQualityRecord = Awaited<
  ReturnType<typeof loadMealQualityRecords>
>[number];
const observed = qualityCheck.observed<MealQualityRecord>;
const when = qualityCheck.when<MealQualityRecord>;
const mealColumn = (column: string) => sql`"Meal".${sql.identifier(column)}`;

export const mealChecks = defineStoredEntityChecks({
  entity: "meal",
  table: meal,
  rulesVersion: MEAL_QUALITY_RULES_VERSION,
  load: loadMealQualityRecords,
  checks: {
    meal_display_image: qualityCheck.hasImage,
    meal_recipe_cost_incomplete: observed(
      (record) => !record.hasIncompleteRecipeCost,
    ),
    meal_contents: when(
      (record) => record.mealKind === "cooked",
      observed((record) => record.hasRecipe || record.hasFoodEntry),
    ),
  },
});

async function loadMealQualityRecords(
  db: Database | DrizzleTransaction,
  ids: readonly string[],
) {
  if (!ids.length) return [];
  return unwrapDb(db)
    .select({
      id: meal.id,
      shortcode: meal.shortcode,
      mealKind: meal.mealKind,
      hasRecipe: sql<boolean>`EXISTS (
        SELECT 1 FROM "MealRecipe" dq_meal_recipe
        JOIN "Recipe" dq_meal_live_recipe
          ON dq_meal_live_recipe."id" = dq_meal_recipe."recipeId"
          AND dq_meal_live_recipe."deletedAt" IS NULL
        WHERE dq_meal_recipe."mealId" = ${mealColumn("id")}
          AND dq_meal_recipe."deletedAt" IS NULL
      )`,
      hasFoodEntry: sql<boolean>`EXISTS (
        SELECT 1 FROM "MealFoodEntry" dq_meal_food
        WHERE dq_meal_food."mealId" = ${mealColumn("id")}
          AND dq_meal_food."deletedAt" IS NULL
      )`,
      hasIncompleteRecipeCost: sql<boolean>`EXISTS (
        SELECT 1 FROM "MealRecipe" dq_meal_cost
        JOIN "Recipe" dq_recipe_cost
          ON dq_recipe_cost."id" = dq_meal_cost."recipeId"
        WHERE dq_meal_cost."mealId" = ${mealColumn("id")}
          AND dq_meal_cost."deletedAt" IS NULL
          AND dq_recipe_cost."deletedAt" IS NULL
          AND (
            dq_recipe_cost."totals" -> 'cost' ->> 'status' = 'partial'
            OR (
              dq_recipe_cost."totals" -> 'cost' ->> 'status' = 'unavailable'
              AND COALESCE((dq_recipe_cost."totals" #>> '{cost,coverage,total}')::int, 0) > 0
            )
          )
      )`,
      hasDisplayImage: sql<boolean>`${entityDisplayImagePresenceSql(
        "meal",
        mealColumn("id"),
      )}`,
    })
    .from(meal)
    .where(
      and(notDeleted(meal), sql`${meal.id} = ANY(${uuidArrayParam(ids)})`),
    );
}
