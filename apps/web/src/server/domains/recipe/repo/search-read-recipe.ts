import { entitySchema } from "@cubby/schemas/entity";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { sql, and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb, notDeleted } from "~/server/db/helpers";
import { recipe as searchTablerecipe } from "~/server/db/schema";
import {
  ingredient,
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import { buildRecipeEmbeddingText } from "~/server/generic/embedding/repo/semantic/text";
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
      id: recipe.id,
      name: recipe.name,
      tags: recipe.tags,
      notes: recipe.notes,
      ingredientNames: sql<
        string[]
      >`array_remove(array_agg(DISTINCT ${ingredient.name}), NULL)`.as(
        "ingredientNames",
      ),
    })
    .from(recipe)
    .leftJoin(recipeSection, eq(recipeSection.recipeId, recipe.id))
    .leftJoin(
      recipeSectionIngredient,
      eq(recipeSectionIngredient.recipeSectionId, recipeSection.id),
    )
    .leftJoin(
      ingredient,
      eq(ingredient.id, recipeSectionIngredient.ingredientId),
    )
    .where(
      and(
        notDeleted(recipe),
        options.ids?.length
          ? inArray(
              recipe.id,
              options.ids.map((id) => parseEntityId("recipe", id)),
            )
          : undefined,
      ),
    )
    .groupBy(recipe.id);
  const rows =
    options.limit == null ? await query : await query.limit(options.limit);

  return rows.map((row) => ({
    entityKind: "recipe",
    entityId: row.id,
    embeddingText: buildRecipeEmbeddingText(row),
  }));
}
export const recipeSearch = {
  document: ({ types, requested, bounded }) => sql`
      SELECT ${entitySchema.enum.recipe}, r."id"::text, r."shortcode", r."name", NULL, NULL, ARRAY[]::text[], ARRAY[]::text[]
      FROM "Recipe" r WHERE ${notDeleted(alias(searchTablerecipe, "r"))} AND ${entitySchema.enum.recipe} IN (${types}) AND ${requested(sql`r."id"`)} AND ${bounded(sql`r."createdAt"`)}`,
  embedding: loadEmbeddingText,
} satisfies SearchReadPort;
