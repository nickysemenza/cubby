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
  AND ${t.SourceType} IS DISTINCT FROM 'Book'
  AND ${t.SourceType} IS DISTINCT FROM 'Notion')`;

const hasIngredientLines = (t: Recipe) => sql`EXISTS (
  SELECT 1 FROM "RecipeSection" dq_rec_sec
  JOIN "RecipeSectionIngredient" dq_rec_line
    ON dq_rec_line."recipeSectionId" = dq_rec_sec."id"
    AND dq_rec_line."deletedAt" IS NULL
  WHERE dq_rec_sec."recipeId" = ${t.id} AND dq_rec_sec."deletedAt" IS NULL
)`;

// Matches `recipeIdsWithInstructions` (repo/recipe/crud.ts): a live section
// whose instructions array is non-empty.
const hasInstructions = (t: Recipe) => sql`EXISTS (
  SELECT 1 FROM "RecipeSection" dq_rec_instr
  WHERE dq_rec_instr."recipeId" = ${t.id} AND dq_rec_instr."deletedAt" IS NULL
    AND jsonb_array_length(dq_rec_instr."instructions") > 0
)`;

export const recipeChecks = defineEntityChecks({
  entity: "recipe",
  table: recipe,
  checks: {
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
      // `webProvenance(null)` (source/source.ts) stamps a URL-less manual
      // recipe as SourceType 'Other' with a null SourceData, not a null
      // SourceType — a genuinely untyped legacy row is the other, rarer half.
      missing: (t) =>
        sql`(${t.SourceType} IS NULL OR (${t.SourceType} = 'Other' AND ${t.SourceData} IS NULL))`,
    },
  },
});
