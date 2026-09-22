import type { DataQuality } from "@cubby/schemas/data-quality";
import type { DisplayImageSummary } from "@cubby/schemas/display-images";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { ImageOut } from "@cubby/schemas/image";
import type {
  RecipeGraphOut,
  RecipeListItem,
  RecipeOut,
  RecipeSectionOut,
  RecipeTopLevel,
  SectionIngredient,
} from "@cubby/schemas/recipe";

import { totalsForRead } from "~/lib/nutrition-estimates";
import type {
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import {
  type MappableImageRecord,
  mapImages,
  mapRelation,
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

// Uses cookbookId, not SourceType; ingredientRef must be a trusted SQL expression.
export const ownRecipeCountForIngredientSql = (ingredientRef: string): string =>
  `(SELECT count(DISTINCT rs."recipeId") FROM "RecipeSectionIngredient" rsi ` +
  `JOIN "RecipeSection" rs ON rs."id" = rsi."recipeSectionId" AND rs."deletedAt" IS NULL ` +
  `JOIN "Recipe" r ON r."id" = rs."recipeId" AND r."deletedAt" IS NULL AND r."cookbookId" IS NULL ` +
  `WHERE rsi."ingredientId" = ${ingredientRef} AND rsi."deletedAt" IS NULL)`;

// Keep every join's soft-delete guard; ingredientRef is trusted SQL, never input.
export const liveRecipeCountForIngredientSql = (
  ingredientRef: string,
): string =>
  `(SELECT count(DISTINCT rs."recipeId") FROM "RecipeSectionIngredient" rsi ` +
  `JOIN "RecipeSection" rs ON rs."id" = rsi."recipeSectionId" AND rs."deletedAt" IS NULL ` +
  `JOIN "Recipe" r ON r."id" = rs."recipeId" AND r."deletedAt" IS NULL ` +
  `WHERE rsi."ingredientId" = ${ingredientRef} AND rsi."deletedAt" IS NULL)`;

// Coalesce to [] so unused ingredients satisfy the API contract.
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

// Guard both MealRecipe and Meal liveness; recipeRef is trusted SQL, never input.
export const liveSectionCountForRecipeSql = (recipeRef: string): string =>
  `(SELECT count(*) FROM "RecipeSection" rsc ` +
  `WHERE rsc."recipeId" = ${recipeRef} AND rsc."deletedAt" IS NULL)`;

export const liveMealCountForRecipeSql = (recipeRef: string): string =>
  `(SELECT count(*) FROM "MealRecipe" mr ` +
  `JOIN "Meal" m ON m."id" = mr."mealId" AND m."deletedAt" IS NULL ` +
  `WHERE mr."recipeId" = ${recipeRef} AND mr."deletedAt" IS NULL)`;

type RecipeSectionIngredientWithRecipe =
  typeof recipeSectionIngredient.$inferSelect & {
    recipeSection: typeof recipeSection.$inferSelect & {
      recipe: typeof recipe.$inferSelect;
    };
  };

// mapRelation only checks the usage row; also guard its section and recipe.
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
    recipe: dbRecipeToTopLevel(usage.recipeSection.recipe),
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

const sectionIngredientToAPI = (
  sectionIngredient: SectionIngredientDB,
): SectionIngredient => {
  if (sectionIngredient.ingredient?.recipe) {
    return {
      id: sectionIngredient.id,
      type: "recipe",
      recipe: dbRecipeToTopLevel(sectionIngredient.ingredient.recipe),
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
        id: parseShortcodeFor("ingredient", ingredient.shortcode),
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

export const dbRecipeToTopLevel = (
  // The cookbook/forkedFrom joins are optional: only the relation-loaded reads
  // carry them, and a recipe read without them just renders unlinked (no
  // source badge, no fork pointer) rather than forcing every caller to join a
  // table it doesn't otherwise need.
  recipeData: RecipeSelect & {
    cookbook?: { shortcode: string } | null;
    forkedFrom?: { shortcode: string; name: string } | null;
  },
): RecipeTopLevel => {
  return {
    id: parseShortcodeFor("recipe", recipeData.shortcode),
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
    forkedFromRecipeId: recipeData.forkedFrom
      ? parseShortcodeFor("recipe", recipeData.forkedFrom.shortcode)
      : null,
    forkedFromRecipeName: recipeData.forkedFrom?.name ?? null,
  };
};

type RecipeShallowOut = Omit<
  RecipeListItem,
  "mealCount" | "sectionCount" | "displayImages" | "dataQuality"
>;

export const dbRecipeToAPIShallow: (
  recipeParam: RecipeSelect,
) => RecipeShallowOut = (recipeData) => ({
  ...dbRecipeToTopLevel(recipeData),
  totals: totalsForRead(recipeData.totals, recipeData.totalsComputedAt),
});

export type RecipeListDB = RecipeSelect & {
  mealCount: number | string;
  sectionCount: number | string;
};

export const dbRecipeToListAPI = (
  recipeData: RecipeListDB,
  displayImages: DisplayImageSummary[],
  dataQuality: DataQuality,
): RecipeListItem => {
  const { mealCount, sectionCount, ...rest } = recipeData;
  return {
    ...dbRecipeToAPIShallow(rest),
    // count() returns bigint (string over the wire), so coerce — mirrors the
    // ingredient list's appearsInRecipes/recipeCount handling.
    mealCount: Number(mealCount),
    sectionCount: Number(sectionCount),
    displayImages,
    dataQuality,
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

export const dbRecipeToAPI = (
  recipeData: RecipeDeepDB,
  dataQuality: DataQuality,
): RecipeOut => {
  const baseRecipe = dbRecipeToAPIShallow(recipeData);
  return {
    ...baseRecipe,
    dataQuality,
    images: mapRecipeImages(recipeData.images),
    sections: mapRecipeSections(recipeData.sections),
  };
};

export const dbRecipeToAPIGraph = (
  recipeData: RecipeGraphDB,
): Omit<RecipeGraphOut, "displayImage"> => {
  const baseRecipe = dbRecipeToAPIShallow(recipeData);
  return {
    ...baseRecipe,
    sections: mapRecipeSections(recipeData.sections),
  };
};
