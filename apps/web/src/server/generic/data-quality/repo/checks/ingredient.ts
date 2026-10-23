import { and, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { ingredient } from "~/server/db/retained-tables";
import { entityDisplayImagePresenceSql } from "~/server/entity-kernel/repo/entity-display-image";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

export const INGREDIENT_QUALITY_RULES_VERSION = 1;

type IngredientQualityRecord = Awaited<
  ReturnType<typeof loadIngredientQualityRecords>
>[number];
const observed = qualityCheck.observed<IngredientQualityRecord>;
const when = qualityCheck.when<IngredientQualityRecord>;
const ingredientColumn = (column: string) =>
  sql`"Ingredient".${sql.identifier(column)}`;

export const ingredientChecks = defineStoredEntityChecks({
  entity: "ingredient",
  table: ingredient,
  rulesVersion: INGREDIENT_QUALITY_RULES_VERSION,
  load: loadIngredientQualityRecords,
  checks: {
    ingredient_display_image: qualityCheck.hasImage,
    ingredient_product: when(
      (record) => record.recipeId === null && record.usedByOwnRecipe,
      observed((record) => record.hasProduct),
    ),
    ingredient_recipe_deleted: when(
      (record) => record.recipeId !== null,
      observed((record) => record.hasLiveRecipe),
    ),
  },
});

async function loadIngredientQualityRecords(
  db: Database | DrizzleTransaction,
  ids: readonly string[],
) {
  if (!ids.length) return [];
  return unwrapDb(db)
    .select({
      id: ingredient.id,
      shortcode: ingredient.shortcode,
      recipeId: ingredient.recipeId,
      usedByOwnRecipe: sql<boolean>`EXISTS (
        SELECT 1 FROM "RecipeSectionIngredient" dq_ingredient_line
        JOIN "RecipeSection" dq_ingredient_section
          ON dq_ingredient_section."id" = dq_ingredient_line."recipeSectionId"
          AND dq_ingredient_section."deletedAt" IS NULL
        JOIN "Recipe" dq_ingredient_recipe
          ON dq_ingredient_recipe."id" = dq_ingredient_section."recipeId"
          AND dq_ingredient_recipe."deletedAt" IS NULL
          AND dq_ingredient_recipe."cookbookId" IS NULL
        WHERE dq_ingredient_line."ingredientId" = ${ingredientColumn("id")}
          AND dq_ingredient_line."deletedAt" IS NULL
      )`,
      hasProduct: sql<boolean>`EXISTS (
        SELECT 1 FROM "Product" dq_ingredient_product
        WHERE dq_ingredient_product."ingredientId" = ${ingredientColumn("id")}
          AND dq_ingredient_product."deletedAt" IS NULL
      )`,
      hasLiveRecipe: sql<boolean>`EXISTS (
        SELECT 1 FROM "Recipe" dq_ingredient_recipe
        WHERE dq_ingredient_recipe."id" = ${ingredientColumn("recipeId")}
          AND dq_ingredient_recipe."deletedAt" IS NULL
      )`,
      hasDisplayImage: sql<boolean>`${entityDisplayImagePresenceSql(
        "ingredient",
        ingredientColumn("id"),
      )}`,
    })
    .from(ingredient)
    .where(
      and(
        notDeleted(ingredient),
        sql`${ingredient.id} = ANY(${uuidArrayParam(ids)})`,
      ),
    );
}
