import { and, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { recipe } from "~/server/db/retained-tables";
import { entityDisplayImagePresenceSql } from "~/server/entity-kernel/repo/entity-display-image";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

const RECIPE_QUALITY_RULES_VERSION = 1;

type RecipeQualityRecord = Awaited<
  ReturnType<typeof loadRecipeQualityRecords>
>[number];
const observed = qualityCheck.observed<RecipeQualityRecord>;
const when = qualityCheck.when<RecipeQualityRecord>;
const recipeColumn = (column: string) =>
  sql`"Recipe".${sql.identifier(column)}`;

export const recipeChecks = defineStoredEntityChecks({
  entity: "recipe",
  table: recipe,
  rulesVersion: RECIPE_QUALITY_RULES_VERSION,
  load: loadRecipeQualityRecords,
  checks: {
    recipe_display_image: qualityCheck.hasImage,
    recipe_ingredients: when(
      (record) => record.cookbookId === null,
      observed((record) => record.hasIngredientLines),
    ),
    recipe_instructions: when(
      (record) =>
        record.cookbookId === null &&
        record.sourceType !== "Book" &&
        record.sourceType !== "Notion",
      observed((record) => record.hasInstructions),
    ),
    recipe_source: when(
      (record) => record.cookbookId === null,
      observed(
        (record) =>
          record.sourceType !== null &&
          !(
            record.sourceType === "Other" &&
            record.sourceUrl === null &&
            record.sourceLabel === null
          ),
      ),
    ),
  },
});

async function loadRecipeQualityRecords(
  db: Database | DrizzleTransaction,
  ids: readonly string[],
) {
  if (!ids.length) return [];
  return unwrapDb(db)
    .select({
      id: recipe.id,
      shortcode: recipe.shortcode,
      cookbookId: recipe.cookbookId,
      sourceType: recipe.sourceType,
      sourceUrl: recipe.sourceUrl,
      sourceLabel: recipe.sourceLabel,
      hasIngredientLines: sql<boolean>`EXISTS (
        SELECT 1 FROM "RecipeSection" dq_recipe_section
        JOIN "RecipeSectionIngredient" dq_recipe_line
          ON dq_recipe_line."recipeSectionId" = dq_recipe_section."id"
          AND dq_recipe_line."deletedAt" IS NULL
        JOIN "Ingredient" dq_recipe_ingredient
          ON dq_recipe_ingredient."id" = dq_recipe_line."ingredientId"
          AND dq_recipe_ingredient."deletedAt" IS NULL
        WHERE dq_recipe_section."recipeId" = ${recipeColumn("id")}
          AND dq_recipe_section."deletedAt" IS NULL
      )`,
      hasInstructions: sql<boolean>`EXISTS (
        SELECT 1 FROM "RecipeSection" dq_recipe_instructions
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(dq_recipe_instructions."instructions") = 'array'
            THEN dq_recipe_instructions."instructions" ELSE '[]'::jsonb END
        ) dq_recipe_step(step)
        WHERE dq_recipe_instructions."recipeId" = ${recipeColumn("id")}
          AND dq_recipe_instructions."deletedAt" IS NULL
          AND trim(COALESCE(
            CASE WHEN jsonb_typeof(dq_recipe_step.step) = 'string'
              THEN dq_recipe_step.step #>> '{}' END,
            dq_recipe_step.step ->> 'text',
            ''
          )) <> ''
      )`,
      hasDisplayImage: sql<boolean>`${entityDisplayImagePresenceSql(
        "recipe",
        recipeColumn("id"),
      )}`,
    })
    .from(recipe)
    .where(
      and(notDeleted(recipe), sql`${recipe.id} = ANY(${uuidArrayParam(ids)})`),
    );
}
