import { entitySchema } from "@cubby/schemas/entity";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { sql, and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb, notDeleted } from "~/server/db/helpers";
import { meal as searchTablemeal } from "~/server/db/schema";
import { meal, mealRecipe, recipe } from "~/server/db/schema";
import { buildMealEmbeddingText } from "~/server/generic/embedding/repo/semantic/text";
import type {
  EmbeddingLoadOptions,
  SearchableEntityText,
  SearchReadPort,
} from "~/server/generic/search/repo/search-read-port";

async function loadEmbeddingText(
  db: Database | DrizzleTransaction,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const query = unwrapDb(db)
    .select({
      id: meal.id,
      name: meal.name,
      date: meal.date,
      mealType: meal.mealType,
      mealKind: meal.mealKind,
      recipeNames: sql<
        string[]
      >`array_remove(array_agg(DISTINCT ${recipe.name}), NULL)`.as(
        "recipeNames",
      ),
    })
    .from(meal)
    .leftJoin(
      mealRecipe,
      and(eq(mealRecipe.mealId, meal.id), notDeleted(mealRecipe)),
    )
    .leftJoin(
      recipe,
      and(eq(recipe.id, mealRecipe.recipeId), notDeleted(recipe)),
    )
    .where(
      and(
        notDeleted(meal),
        options.ids?.length
          ? inArray(
              meal.id,
              options.ids.map((id) => parseEntityId("meal", id)),
            )
          : undefined,
      ),
    )
    .groupBy(meal.id);
  const rows =
    options.limit == null ? await query : await query.limit(options.limit);

  return rows.map((row) => ({
    entityKind: "meal",
    entityId: row.id,
    embeddingText: buildMealEmbeddingText(row),
  }));
}
export const mealSearch = {
  document: ({ types, requested, bounded }) => sql`
      SELECT ${entitySchema.enum.meal}, m."id"::text, m."shortcode", COALESCE(NULLIF(m."name", ''), m."date"::text), m."date"::text, NULL, ARRAY[]::text[], ARRAY[m."date"::text]::text[]
      FROM "Meal" m WHERE ${notDeleted(alias(searchTablemeal, "m"))} AND ${entitySchema.enum.meal} IN (${types}) AND ${requested(sql`m."id"`)} AND ${bounded(sql`m."createdAt"`)}`,
  embedding: loadEmbeddingText,
} satisfies SearchReadPort;
