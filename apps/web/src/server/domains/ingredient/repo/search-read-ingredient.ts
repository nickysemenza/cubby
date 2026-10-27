import { entitySchema } from "@cubby/schemas/entity";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { isNull, sql, and, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb, notDeleted } from "~/server/db/helpers";
import { ingredient as searchTableingredient } from "~/server/db/schema";
import { ingredient } from "~/server/db/schema";
import { withOptionalLimit } from "~/server/generic/embedding/repo/embedding-load-options";
import { buildIngredientEmbeddingText } from "~/server/generic/embedding/repo/semantic/text";
import type {
  EmbeddingLoadOptions,
  SearchableEntityText,
  SearchReadPort,
} from "~/server/generic/search/repo/search-read-port";

async function loadEmbeddingText(
  db: Database | DrizzleTransaction,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const queryConfig = withOptionalLimit(
    {
      where: and(
        notDeleted(ingredient),
        isNull(ingredient.recipeId),
        options.ids?.length
          ? inArray(
              ingredient.id,
              options.ids.map((id) => parseEntityId("ingredient", id)),
            )
          : undefined,
      ),
      columns: {
        id: true,
        name: true,
        aliases: true,
      },
    },
    options.limit,
  );
  const rows = await unwrapDb(db).query.ingredient.findMany(queryConfig);
  return rows.map((row) => ({
    entityKind: "ingredient",
    entityId: row.id,
    embeddingText: buildIngredientEmbeddingText(row),
  }));
}
export const ingredientSearch = {
  document: ({ types, requested, bounded }) => sql`
      SELECT ${entitySchema.enum.ingredient}, i."id"::text, i."shortcode", i."name", NULL, NULL, i."aliases", ARRAY[]::text[]
      FROM "Ingredient" i WHERE ${notDeleted(alias(searchTableingredient, "i"))} AND i."recipeId" IS NULL AND ${entitySchema.enum.ingredient} IN (${types}) AND ${requested(sql`i."id"`)} AND ${bounded(sql`i."createdAt"`)}`,
  embedding: loadEmbeddingText,
} satisfies SearchReadPort;
