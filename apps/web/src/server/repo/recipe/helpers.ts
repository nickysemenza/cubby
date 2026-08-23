/**
 * Recipe transformation helpers.
 * Convert database records to API types.
 */

import {
  unsafeIngredientShortcode,
  unsafeRecipeShortcode,
} from "@cubby/schemas/identifiers";
import type { ImageOut } from "@cubby/schemas/image";
import type {
  RecipeGraphOut,
  RecipeListItem,
  RecipeOut,
  RecipeSectionOut,
  RecipeTopLevel,
  SectionIngredient,
} from "@cubby/schemas/recipe";
import type {
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import { recipeImage } from "~/server/db/schema";
import {
  imageOrder,
  type MappableImageRecord,
  mapImages,
  mapRelation,
  notDeleted,
} from "~/server/repo/database-helpers";

import type {
  RecipeDeepDB,
  RecipeGraphDB,
  SectionIngredientDB,
} from "./internal-types";
import { recipeMetaFromColumns } from "./meta";
import { recipeSourceFromDb } from "./source";

type RecipeSelect = typeof recipe.$inferSelect;
type RecipeImageRow = {
  image: MappableImageRecord;
  deletedAt?: Date | null;
};

const mapRecipeImages = (images: RecipeImageRow[] | undefined): ImageOut[] =>
  mapImages(images);

/**
 * Distinct live NON-COOKBOOK recipes using this ingredient — "how many of my
 * own recipes need this".
 *
 * A separate helper rather than a parameter on
 * {@link liveRecipeCountForIngredientSql}: that one has three callers (the
 * enrichment workbench's `recipeCount > 0` gate and two sorts) which all mean
 * every live recipe, and the `appearsInRecipes` cell beside them counts the
 * same way. Scoping it in place would make the ingredient list disagree with
 * its own column.
 *
 * Keys on `cookbookId IS NULL` — the FK — not on `SourceType = 'Book'`. Those
 * are different predicates; see {@link cookbookOnlyForIngredientSql}, which
 * deliberately uses the other one.
 *
 * Same `ingredientRef` contract as its sibling: a trusted SQL expression, never
 * user input.
 */
export const ownRecipeCountForIngredientSql = (ingredientRef: string): string =>
  `(SELECT count(DISTINCT rs."recipeId") FROM "RecipeSectionIngredient" rsi ` +
  `JOIN "RecipeSection" rs ON rs."id" = rsi."recipeSectionId" AND rs."deletedAt" IS NULL ` +
  `JOIN "Recipe" r ON r."id" = rs."recipeId" AND r."deletedAt" IS NULL AND r."cookbookId" IS NULL ` +
  `WHERE rsi."ingredientId" = ${ingredientRef} AND rsi."deletedAt" IS NULL)`;

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
  `SELECT DISTINCT jsonb_build_object('id', r."shortcode", 'name', r."name") AS rec ` +
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
 * Correlated subquery counting a recipe's live meal plans: a MealRecipe row
 * that is itself not soft-deleted AND whose parent Meal is not soft-deleted —
 * a live MealRecipe under a soft-deleted Meal is not a plan. Mirrors the
 * join-guarded shape `recipeList`'s `recipeIdsInLiveMeals` presence filter
 * uses (crud.ts), so the list's "Meals" count and the "has meals" filter can
 * never disagree about what counts as planned.
 *
 * `recipeRef` is the SQL reference to the recipe id column in the OUTER
 * query — interpolated verbatim, so it MUST be a trusted, hardcoded column
 * expression (e.g. `"recipe"."id"` for the relational query builder's root
 * alias), never user input. See {@link liveRecipeCountForIngredientSql} for
 * the same contract on the ingredient side.
 */
export const liveSectionCountForRecipeSql = (recipeRef: string): string =>
  `(SELECT count(*) FROM "RecipeSection" rsc ` +
  `WHERE rsc."recipeId" = ${recipeRef} AND rsc."deletedAt" IS NULL)`;

export const liveMealCountForRecipeSql = (recipeRef: string): string =>
  `(SELECT count(*) FROM "MealRecipe" mr ` +
  `JOIN "Meal" m ON m."id" = mr."mealId" AND m."deletedAt" IS NULL ` +
  `WHERE mr."recipeId" = ${recipeRef} AND mr."deletedAt" IS NULL)`;

/**
 * A single (sortOrder-first, i.e. cover) live image relation config for the
 * recipe list — `limit: 1` so the list pays for one thumbnail per row
 * instead of the full gallery. Meant to be spread as `with: { images:
 * recipeListCoverImageRelation }` into the list's `query.recipe.findMany`
 * call, alongside a `mealCount` extra built from
 * {@link liveMealCountForRecipeSql}. Same ordering as the detail page's
 * gallery (`imageOrder`: explicit sortOrder, then createdAt/id tie-break), so
 * "first" here matches "first" there.
 */
export const recipeListCoverImageRelation = {
  where: notDeleted(recipeImage),
  orderBy: imageOrder,
  limit: 1,
  with: {
    image: true,
  },
} as const;

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
    recipe: dbRecipeToTopLevelShape(usage.recipeSection.recipe),
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
      id: sectionIngredient.id,
      type: "recipe",
      recipe: dbRecipeToTopLevelShape(sectionIngredient.ingredient.recipe),
      ingredient: null,
      amounts: sectionIngredient.amounts,
      rawLine: sectionIngredient.rawLine,
      modifier: sectionIngredient.modifier,
      createdAt: sectionIngredient.createdAt,
      updatedAt: sectionIngredient.updatedAt,
    };
  } else {
    const ingredient = sectionIngredient.ingredient;
    return {
      id: sectionIngredient.id,
      type: "ingredient",
      recipe: null,
      ingredient: {
        id: unsafeIngredientShortcode(ingredient.shortcode),
        name: ingredient.name,
        aliases: ingredient.aliases,
        createdAt: ingredient.createdAt,
        updatedAt: ingredient.updatedAt,
      },
      amounts: sectionIngredient.amounts,
      rawLine: sectionIngredient.rawLine,
      modifier: sectionIngredient.modifier,
      createdAt: sectionIngredient.createdAt,
      updatedAt: sectionIngredient.updatedAt,
    };
  }
};

/**
 * Convert a recipe DB record to a top-level API shape without sections/images.
 * This is the shared, unvalidated field mapper for recipe list rows and recipe
 * references.
 */
export const dbRecipeToTopLevelShape = (
  // The cookbook join is optional: only the relation-loaded reads carry it, and
  // a recipe read without it just renders its source badge unlinked rather than
  // forcing every caller to join a table it doesn't otherwise need.
  recipeData: RecipeSelect & { cookbook?: { shortcode: string } | null },
): RecipeTopLevel => {
  // cookbookId is the FK, not a top-level API field — pull it out of the row so it
  // isn't spread into the output, but feed it to the source codec so a book
  // recipe's `source` carries its cookbook id (for linking).
  return {
    id: unsafeRecipeShortcode(recipeData.shortcode),
    name: recipeData.name,
    createdAt: recipeData.createdAt,
    updatedAt: recipeData.updatedAt,
    // The DB stores provenance as SourceType + SourceData; the API exposes it as
    // meta.url. This derivation is deliberately kept (rather than collapsing the two
    // columns into one nullable sourceUrl) to avoid a DB migration + backfill —
    // the `meta` jsonb column added for times/equipment/page holds no url.
    meta: recipeMetaFromColumns(
      recipeData,
      recipeData.SourceType === "Website" ? recipeData.SourceData : null,
    ),
    // Strong provenance union — surfaces the book name + cookbook id for cookbook
    // recipes (meta.url only ever held web URLs).
    source: recipeSourceFromDb({
      SourceType: recipeData.SourceType,
      SourceData: recipeData.SourceData,
      cookbookId: recipeData.cookbookId,
      cookbookShortcode: recipeData.cookbook?.shortcode ?? null,
    }),
    yield: recipeData.yield,
    servings: recipeData.servings,
    tags: recipeData.tags,
    notes: recipeData.notes,
  };
};

/**
 * The shared base shape under `RecipeOut`/`RecipeGraphOut`/`RecipeListItem`:
 * top-level fields + persisted totals, no sections, no images, no list-only
 * extras (`mealCount`). Each of those three output types layers its own
 * remaining fields on top via spread — see {@link dbRecipeToAPI},
 * {@link dbRecipeToAPIGraph}, {@link dbRecipeToListAPI}.
 */
type RecipeShallowOut = Omit<
  RecipeListItem,
  "mealCount" | "sectionCount" | "images"
>;

/**
 * Convert a recipe DB record to a list item API type (without sections/images).
 */
export const dbRecipeToAPIShallow: (
  recipeParam: RecipeSelect,
) => RecipeShallowOut = (recipeData) => ({
  ...dbRecipeToTopLevelShape(recipeData),
  totals: recipeData.totals,
});

/** A recipe list row: the plain columns plus the list query's `mealCount`
 * extra and a single-element (cover-only) `images` relation. See
 * {@link liveMealCountForRecipeSql} and {@link recipeListCoverImageRelation}. */
export type RecipeListDB = RecipeSelect & {
  mealCount: number | string;
  sectionCount: number | string;
  images?: RecipeImageRow[] | null;
};

/**
 * Convert a recipe list-query DB row to the recipe list's API shape —
 * `dbRecipeToAPIShallow` plus the list-only `mealCount` scalar and cover
 * image.
 */
export const dbRecipeToListAPI = (recipeData: RecipeListDB): RecipeListItem => {
  const { mealCount, sectionCount, images, ...rest } = recipeData;
  return {
    ...dbRecipeToAPIShallow(rest),
    // count() returns bigint (string over the wire), so coerce — mirrors the
    // ingredient list's appearsInRecipes/recipeCount handling.
    mealCount: Number(mealCount),
    sectionCount: Number(sectionCount),
    images: mapRecipeImages(images ?? undefined),
  };
};

const mapRecipeSections = (
  sections: RecipeDeepDB["sections"] | RecipeGraphDB["sections"],
): RecipeSectionOut[] =>
  mapRelation(sections, (section) => {
    const { ingredients, instructions } = section;
    return {
      id: section.id,
      name: section.name,
      createdAt: section.createdAt,
      updatedAt: section.updatedAt,
      ingredients: mapRelation(ingredients, sectionIngredientToAPI),
      // The DB stores each instruction as { text }, the API/form use { instruction }.
      // This rename is deliberately kept to avoid a JSONB migration + backfill.
      instructions: Array.isArray(instructions)
        ? instructions.map((instruction: { text: string }) => {
            return { instruction: instruction.text };
          })
        : [],
    };
  });

/**
 * Convert a full recipe DB record to API type (with sections).
 */
export const dbRecipeToAPI = (recipeData: RecipeDeepDB): RecipeOut => {
  const baseRecipe = dbRecipeToAPIShallow(recipeData);
  return {
    ...baseRecipe,
    images: mapRecipeImages(recipeData.images),
    sections: mapRecipeSections(recipeData.sections),
  };
};

/**
 * Convert a full recipe graph without media. Used by costing/sub-recipe closure
 * fetches that need sections but deliberately do not load recipe images.
 */
export const dbRecipeToAPIGraph = (
  recipeData: RecipeGraphDB,
): Omit<RecipeGraphOut, "displayImage"> => {
  const baseRecipe = dbRecipeToAPIShallow(recipeData);
  return {
    ...baseRecipe,
    sections: mapRecipeSections(recipeData.sections),
  };
};
