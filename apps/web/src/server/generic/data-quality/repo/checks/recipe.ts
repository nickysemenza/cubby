import { sql } from "drizzle-orm";

import { recipe } from "~/server/db/schema";

import { defineEntityChecks } from "../registry";

type Recipe = typeof recipe;

// Mirrors `ownRecipeCountForIngredientSql` (repo/recipe/helpers.ts): a recipe
// with no cookbook is the household's own, as opposed to one imported from a
// cookbook's extraction.
const isOwnRecipe = (t: Recipe) => sql`${t.cookbookId} IS NULL`;

// Must agree with the `no-instructions` curated view (view-manifest.ts,
// recipe): Book/Notion recipes carry their text in the source, not here, so
// the check never lights up a book you own or a Notion page you sync.
const expectsInstructions = (t: Recipe) => sql`(${isOwnRecipe(t)}
  AND ${t.sourceType} IS DISTINCT FROM 'Book'
  AND ${t.sourceType} IS DISTINCT FROM 'Notion')`;

// A line only counts while it names a live Ingredient; a line left pointing
// at a deleted one contributes nothing to cooking, nutrition, or cost.
const hasIngredientLines = (t: Recipe) => sql`EXISTS (
  SELECT 1 FROM "RecipeSection" dq_rec_sec
  JOIN "RecipeSectionIngredient" dq_rec_line
    ON dq_rec_line."recipeSectionId" = dq_rec_sec."id"
    AND dq_rec_line."deletedAt" IS NULL
  JOIN "Ingredient" dq_rec_ing
    ON dq_rec_ing."id" = dq_rec_line."ingredientId"
    AND dq_rec_ing."deletedAt" IS NULL
  WHERE dq_rec_sec."recipeId" = ${t.id} AND dq_rec_sec."deletedAt" IS NULL
)`;

// A live section with at least one instruction whose text is not blank: an
// array of empty steps (`[{"text": ""}]`) is not written instructions.
// Sections store `{text}` objects; a bare string element is legacy.
const hasInstructions = (t: Recipe) => sql`EXISTS (
  SELECT 1 FROM "RecipeSection" dq_rec_instr
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(dq_rec_instr."instructions") = 'array'
      THEN dq_rec_instr."instructions" ELSE '[]'::jsonb END
  ) dq_rec_step(step)
  WHERE dq_rec_instr."recipeId" = ${t.id} AND dq_rec_instr."deletedAt" IS NULL
    AND trim(COALESCE(
      CASE WHEN jsonb_typeof(dq_rec_step.step) = 'string' THEN dq_rec_step.step #>> '{}' END,
      dq_rec_step.step ->> 'text',
      ''
    )) <> ''
)`;

export const recipeChecks = defineEntityChecks({
  entity: "recipe",
  table: recipe,
  checks: {
    recipe_deleted_dependency: {
      // includes-deleted: the defect is a live parent still referencing a deleted sub-recipe.
      missing: (
        t: Recipe,
      ) => sql`(${t.totalsComputedAt} IS NOT NULL AND EXISTS (
        SELECT 1 FROM "RecipeSection" rs
        JOIN "RecipeSectionIngredient" rsi ON rsi."recipeSectionId" = rs.id AND rsi."deletedAt" IS NULL
        JOIN "Ingredient" i ON i.id = rsi."ingredientId" AND i."deletedAt" IS NULL
        JOIN "Recipe" sub ON sub.id = i."recipeId" AND sub."deletedAt" IS NOT NULL
        WHERE rs."recipeId" = ${t.id} AND rs."deletedAt" IS NULL
      ))`,
    },
    recipe_ingredients: {
      expected: isOwnRecipe,
      missing: (t) => sql`NOT ${hasIngredientLines(t)}`,
    },
    recipe_instructions: {
      expected: expectsInstructions,
      missing: (t) => sql`NOT ${hasInstructions(t)}`,
    },
    recipe_source: {
      expected: isOwnRecipe,
      // `webProvenance(null)` (recipe/source.ts) stamps a URL-less manual
      // recipe as sourceType 'Other' with no url or label, not a null
      // sourceType — a genuinely untyped legacy row is the other, rarer half.
      missing: (t) =>
        sql`(${t.sourceType} IS NULL OR (${t.sourceType} = 'Other' AND ${t.sourceUrl} IS NULL AND ${t.sourceLabel} IS NULL))`,
    },
  },
});
