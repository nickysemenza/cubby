import { sql } from "drizzle-orm";

import { ingredient } from "~/server/db/schema";

import { defineEntityChecks } from "../registry";

type Ingredient = typeof ingredient;

// A sub-recipe-as-ingredient (Ingredient.recipeId set) is never a pantry
// ingredient a Product can back — only a base ingredient is in scope, and
// only once it is actually used by one of the household's own recipes
// (mirrors `ownRecipeCountForIngredientSql`, repo/recipe/helpers.ts).
const isUsedByOwnRecipe = (t: Ingredient) => sql`EXISTS (
  SELECT 1 FROM "RecipeSectionIngredient" dq_ing_line
  JOIN "RecipeSection" dq_ing_sec
    ON dq_ing_sec."id" = dq_ing_line."recipeSectionId"
    AND dq_ing_sec."deletedAt" IS NULL
  JOIN "Recipe" dq_ing_recipe
    ON dq_ing_recipe."id" = dq_ing_sec."recipeId"
    AND dq_ing_recipe."deletedAt" IS NULL
    AND dq_ing_recipe."cookbookId" IS NULL
  WHERE dq_ing_line."ingredientId" = ${t.id} AND dq_ing_line."deletedAt" IS NULL
)`;

const hasProduct = (t: Ingredient) => sql`EXISTS (
  SELECT 1 FROM "Product" dq_ing_prod
  WHERE dq_ing_prod."ingredientId" = ${t.id} AND dq_ing_prod."deletedAt" IS NULL
)`;

export const ingredientChecks = defineEntityChecks({
  entity: "ingredient",
  table: ingredient,
  checks: {
    ingredient_product: {
      expected: (t) => sql`${t.recipeId} IS NULL AND ${isUsedByOwnRecipe(t)}`,
      missing: (t) => sql`NOT ${hasProduct(t)}`,
    },
  },
});
