/**
 * Recipe transformation helpers.
 * Convert database records to API types.
 */

import type {
  RecipeOut,
  RecipeTotals,
  recipeTopLevel,
  SectionIngredient,
} from "@cubby/schemas/recipe";
import type { z } from "zod";
import type {
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import {
  extractImagesFromJoinTable,
  mapRelation,
} from "~/server/repo/database-helpers";

import type { RecipeDeepDB, SectionIngredientDB } from "./internal-types";
import { recipeSourceFromDb } from "./source";

type RecipeSelect = typeof recipe.$inferSelect;

/**
 * Correlated subquery counting the DISTINCT *live* recipes an ingredient appears
 * in. Single source of truth for every "appears in N recipes" surface (ingredient
 * list sort, global search, etc.) so they can't silently diverge.
 *
 * `ingredientRef` is the SQL reference to the ingredient id column in the OUTER
 * query — the alias differs by builder: `"Ingredient"."id"` for the query builder
 * (`.from(ingredient)`), `"ingredient"."id"` for the relational query builder. It
 * is interpolated verbatim into SQL, so it MUST be a trusted, hardcoded column
 * expression — never user input.
 *
 * The subquery filters EVERY join level (`rsi`, `rs`, `r`), so a soft-deleted
 * usage, section, or recipe can never inflate the count — even if the
 * cascade/backfill invariant is ever temporarily violated.
 */
export const liveRecipeCountForIngredientSql = (
  ingredientRef: string,
): string =>
  `(SELECT count(DISTINCT rs."recipeId") FROM "RecipeSectionIngredient" rsi ` +
  `JOIN "RecipeSection" rs ON rs."id" = rsi."recipeSectionId" AND rs."deletedAt" IS NULL ` +
  `JOIN "Recipe" r ON r."id" = rs."recipeId" AND r."deletedAt" IS NULL ` +
  `WHERE rsi."ingredientId" = ${ingredientRef} AND rsi."deletedAt" IS NULL)`;

/**
 * Boolean: the ingredient is used in ≥1 live recipe AND *every* such recipe is
 * book-sourced (an imported cookbook). Mirrors the API-side `isCookbookOnly`
 * (`appearsInRecipes.length > 0 && every source.type === "book"`) but in SQL so
 * the workbench can carry it as a scalar instead of shipping every recipe body
 * to derive it client-side. "Book-sourced" matches {@link recipeSourceFromDb}:
 * `SourceType = 'Book'` with a non-empty `SourceData`. Same `ingredientRef`
 * contract as {@link liveRecipeCountForIngredientSql} (trusted column expr only).
 *
 * `bool_and` over the live usages is empty-set NULL, but `count(...) > 0` is then
 * false, so an unused ingredient correctly returns false.
 */
/**
 * A jsonb array of `{id, name}` for the DISTINCT live recipes an ingredient
 * appears in — the lean replacement for the ingredient list's full
 * `appearsInRecipes: recipeTopLevel[]`. Same `ingredientRef` contract /
 * live-filtering as {@link liveRecipeCountForIngredientSql}. `coalesce` to `[]`
 * so an unused ingredient returns an empty array, not null.
 */
export const appearsInRecipesRefsForIngredientSql = (
  ingredientRef: string,
): string =>
  `(SELECT coalesce(jsonb_agg(rec ORDER BY rec->>'name'), '[]'::jsonb) FROM (` +
  `SELECT DISTINCT jsonb_build_object('id', r."id", 'name', r."name") AS rec ` +
  `FROM "RecipeSectionIngredient" rsi ` +
  `JOIN "RecipeSection" rs ON rs."id" = rsi."recipeSectionId" AND rs."deletedAt" IS NULL ` +
  `JOIN "Recipe" r ON r."id" = rs."recipeId" AND r."deletedAt" IS NULL ` +
  `WHERE rsi."ingredientId" = ${ingredientRef} AND rsi."deletedAt" IS NULL) sub)`;

export const cookbookOnlyForIngredientSql = (ingredientRef: string): string =>
  `(SELECT count(DISTINCT rs."recipeId") > 0 ` +
  `AND bool_and(r."SourceType" = 'Book' AND r."SourceData" IS NOT NULL AND r."SourceData" <> '') ` +
  `FROM "RecipeSectionIngredient" rsi ` +
  `JOIN "RecipeSection" rs ON rs."id" = rsi."recipeSectionId" AND rs."deletedAt" IS NULL ` +
  `JOIN "Recipe" r ON r."id" = rs."recipeId" AND r."deletedAt" IS NULL ` +
  `WHERE rsi."ingredientId" = ${ingredientRef} AND rsi."deletedAt" IS NULL)`;

/**
 * A RecipeSectionIngredient row joined up to its section and recipe — the input
 * shape for {@link computeRecipeUsages}.
 */
type RecipeSectionIngredientWithRecipe =
  typeof recipeSectionIngredient.$inferSelect & {
    recipeSection: typeof recipeSection.$inferSelect & {
      recipe: typeof recipe.$inferSelect;
    };
  };

/**
 * Shared recipe-usage shaping for both the ingredient and product detail views.
 * Given an ingredient's RecipeSectionIngredient rows (each joined to its section
 * and recipe), produces one `recipeUsage` per live usage plus the deduped
 * `appearsInRecipes`.
 *
 * `mapRelation` drops soft-deleted RecipeSectionIngredient rows, but it only
 * inspects the top-level row — a live usage can still point at a soft-deleted
 * section or recipe. Those are excluded here so the displayed recipes stay
 * consistent with the list's recipe-count sort, whose subquery counts live
 * recipes only (see {@link liveRecipeCountForIngredientSql}).
 */
export const computeRecipeUsages = (
  rows: RecipeSectionIngredientWithRecipe[],
) => {
  const liveRecipeUsages = rows.filter(
    (rsi) =>
      rsi.recipeSection.deletedAt === null &&
      rsi.recipeSection.recipe.deletedAt === null,
  );

  const recipeUsages = mapRelation(liveRecipeUsages, (usage) => ({
    id: usage.id,
    recipe: dbRecipeToAPIShallow(usage.recipeSection.recipe),
    sectionName: usage.recipeSection.name,
    amounts: usage.amounts,
    rawLine: usage.rawLine,
    modifier: usage.modifier,
  }));

  const seenRecipeIds = new Set<string>();
  const appearsInRecipes = recipeUsages
    .filter(
      (u) => !seenRecipeIds.has(u.recipe.id) && seenRecipeIds.add(u.recipe.id),
    )
    .map((u) => u.recipe);

  return { recipeUsages, appearsInRecipes };
};

/**
 * Convert a recipe section ingredient DB record to API type.
 * Handles both regular ingredients and recipe references.
 */
const sectionIngredientToAPI = (
  sectionIngredient: SectionIngredientDB,
): SectionIngredient => {
  if (sectionIngredient.ingredient?.recipe) {
    return {
      ...sectionIngredient,
      type: "recipe",
      recipe: dbRecipeToAPIShallow(sectionIngredient.ingredient.recipe),
      ingredient: null,
      amounts: sectionIngredient.amounts,
    };
  } else {
    const ingredient = sectionIngredient.ingredient;
    return {
      ...sectionIngredient,
      type: "ingredient",
      recipe: null,
      ingredient,
      amounts: sectionIngredient.amounts,
    };
  }
};

/**
 * Convert a recipe DB record to shallow API type (without sections).
 * Used for recipe references within ingredients.
 */
export const dbRecipeToAPIShallow: (
  recipeParam: RecipeSelect,
) => z.infer<typeof recipeTopLevel> & { totals: RecipeTotals | null } = (
  recipeData,
) => {
  // cookbookId is the FK, not a top-level API field — pull it out of the row so it
  // isn't spread into the output, but feed it to the source codec so a book
  // recipe's `source` carries its cookbook id (for linking).
  const { SourceType, SourceData, cookbookId, ...restOfRecipe } = recipeData;
  return {
    // The DB stores provenance as SourceType + SourceData; the API exposes a single
    // meta.url. This derivation is deliberately kept (rather than collapsing the two
    // columns into one nullable sourceUrl) to avoid a DB migration + backfill.
    meta: {
      url: SourceType === "Website" ? SourceData : null,
    },
    // Strong provenance union — surfaces the book name + cookbook id for cookbook
    // recipes (meta.url only ever held web URLs).
    source: recipeSourceFromDb({ SourceType, SourceData, cookbookId }),
    ...restOfRecipe,
  };
};

/**
 * Convert a full recipe DB record to API type (with sections).
 */
export const dbRecipeToAPI = (recipeData: RecipeDeepDB): RecipeOut => {
  const {
    sections,
    SourceData,
    SourceType,
    cookbookId,
    images,
    ...restOfRecipe
  } = recipeData;

  return {
    ...restOfRecipe,
    // See dbRecipeToAPIShallow: SourceType/SourceData -> meta.url derivation is kept
    // deliberately to avoid a DB migration.
    meta: {
      url: SourceType === "Website" ? SourceData : null,
    },
    source: recipeSourceFromDb({ SourceType, SourceData, cookbookId }),
    images: extractImagesFromJoinTable(images),
    sections: mapRelation(sections, (section) => {
      const { ingredients, instructions, ...restOfSection } = section;
      return {
        ...restOfSection,
        ingredients: mapRelation(ingredients, sectionIngredientToAPI),
        // The DB stores each instruction as { text }, the API/form use { instruction }.
        // This rename is deliberately kept to avoid a JSONB migration + backfill.
        instructions: Array.isArray(instructions)
          ? instructions.map((instruction: { text: string }) => {
              return { instruction: instruction.text };
            })
          : [],
      };
    }),
  };
};
