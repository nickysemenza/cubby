import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { totalsPreview } from "@cubby/schemas/nutrition";
import type {
  RawRecipeGraph as RecipeGraphOut,
  RawRecipeList as RecipeListItem,
  RawRecipeSection as RecipeSectionOut,
  RawRecipeTopLevel as RecipeTopLevel,
  RawSectionIngredient as SectionIngredient,
} from "@cubby/schemas/recipe-raw-read";

import { totalsForRead } from "~/lib/nutrition-estimates";
import { mapRelation } from "~/server/db/helpers/transform";
import {
  type recipe,
  type recipeSection,
  type recipeSectionIngredient,
} from "~/server/db/retained-tables";
import { liveAliasSqlText } from "~/server/lib/live-row";

import type {
  RecipeDeepDB,
  RecipeGraphDB,
  SectionIngredientDB,
} from "./internal-types";
import { recipeMetaFromColumns } from "./meta";
import { resolveRecipeServings } from "./servings";
import { recipeSourceFromDb } from "./source";

type RecipeSelect = typeof recipe.$inferSelect;

// Uses cookbookId, not SourceType; ingredientRef must be a trusted SQL expression.
export const ownRecipeCountForIngredientSql = (ingredientRef: string): string =>
  `(SELECT count(DISTINCT rs."recipeId") FROM "RecipeSectionIngredient" rsi ` +
  `JOIN "RecipeSection" rs ON rs."id" = rsi."recipeSectionId" AND ${liveAliasSqlText("rs")} ` +
  `JOIN "Recipe" r ON r."id" = rs."recipeId" AND ${liveAliasSqlText("r")} AND r."cookbookId" IS NULL ` +
  `WHERE rsi."ingredientId" = ${ingredientRef} AND ${liveAliasSqlText("rsi")})`;

// Keep every join's soft-delete guard; ingredientRef is trusted SQL, never input.
export const liveRecipeCountForIngredientSql = (
  ingredientRef: string,
): string =>
  `(SELECT count(DISTINCT rs."recipeId") FROM "RecipeSectionIngredient" rsi ` +
  `JOIN "RecipeSection" rs ON rs."id" = rsi."recipeSectionId" AND ${liveAliasSqlText("rs")} ` +
  `JOIN "Recipe" r ON r."id" = rs."recipeId" AND ${liveAliasSqlText("r")} ` +
  `WHERE rsi."ingredientId" = ${ingredientRef} AND ${liveAliasSqlText("rsi")})`;

// Coalesce to [] so unused ingredients satisfy the API contract.
export const appearsInRecipesRefsForIngredientSql = (
  ingredientRef: string,
): string =>
  `(SELECT coalesce(jsonb_agg(rec ORDER BY rec->>'name'), '[]'::jsonb) FROM (` +
  `SELECT DISTINCT jsonb_build_object('id', r."shortcode", 'name', r."name") AS rec ` +
  `FROM "RecipeSectionIngredient" rsi ` +
  `JOIN "RecipeSection" rs ON rs."id" = rsi."recipeSectionId" AND ${liveAliasSqlText("rs")} ` +
  `JOIN "Recipe" r ON r."id" = rs."recipeId" AND ${liveAliasSqlText("r")} ` +
  `WHERE rsi."ingredientId" = ${ingredientRef} AND ${liveAliasSqlText("rsi")}) sub)`;

export const cookbookOnlyForIngredientSql = (ingredientRef: string): string =>
  `(SELECT count(DISTINCT rs."recipeId") > 0 ` +
  `AND bool_and(r."sourceType" = 'Book' AND (r."cookbookId" IS NOT NULL OR coalesce(r."sourceLabel", '') <> '')) ` +
  `FROM "RecipeSectionIngredient" rsi ` +
  `JOIN "RecipeSection" rs ON rs."id" = rsi."recipeSectionId" AND ${liveAliasSqlText("rs")} ` +
  `JOIN "Recipe" r ON r."id" = rs."recipeId" AND ${liveAliasSqlText("r")} ` +
  `WHERE rsi."ingredientId" = ${ingredientRef} AND ${liveAliasSqlText("rsi")})`;

// Guard both MealRecipe and Meal liveness; recipeRef is trusted SQL, never input.
export const liveSectionCountForRecipeSql = (recipeRef: string): string =>
  `(SELECT count(*) FROM "RecipeSection" rsc ` +
  `WHERE rsc."recipeId" = ${recipeRef} AND ${liveAliasSqlText("rsc")})`;

export const liveMealCountForRecipeSql = (recipeRef: string): string =>
  `(SELECT count(*) FROM "MealRecipe" mr ` +
  `JOIN "Meal" m ON m."id" = mr."mealId" AND ${liveAliasSqlText("m")} ` +
  `WHERE mr."recipeId" = ${recipeRef} AND ${liveAliasSqlText("mr")})`;

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
    recipe: {
      id: parseShortcodeFor("recipe", usage.recipeSection.recipe.shortcode),
      name: usage.recipeSection.recipe.name,
    },
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

type RecipeProvenanceRow = RecipeSelect & {
  cookbook?: { shortcode: string; name?: string } | null;
  forkedFrom?: { shortcode: string; name: string } | null;
  /** Live Notion page identifiers (`RECIPE_SOURCE_RELATIONS`). */
  externalIds?: { externalId: string }[];
};

export const recipeProvenanceFields = (recipeData: RecipeProvenanceRow) => ({
  // A Website recipe's page is `sourceUrl`; the API exposes it as meta.url.
  meta: recipeMetaFromColumns(
    recipeData,
    recipeData.sourceType === "Website" ? recipeData.sourceUrl : null,
  ),
  source: recipeSourceFromDb({
    sourceType: recipeData.sourceType,
    sourceUrl: recipeData.sourceUrl,
    sourceLabel: recipeData.sourceLabel,
    cookbookName: recipeData.cookbook?.name ?? null,
    cookbookShortcode: recipeData.cookbook?.shortcode ?? null,
    notionPageId: recipeData.externalIds?.[0]?.externalId ?? null,
  }),
});

export const dbRecipeToTopLevel = (
  recipeData: RecipeProvenanceRow,
): RecipeTopLevel => {
  return {
    id: parseShortcodeFor("recipe", recipeData.shortcode),
    name: recipeData.name,
    createdAt: recipeData.createdAt,
    updatedAt: recipeData.updatedAt,
    ...recipeProvenanceFields(recipeData),
    yield: recipeData.yield,
    servings: recipeData.servings,
    fieldResolutions: resolveRecipeServings(recipeData),
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
  "meals" | "sectionCount" | "displayImages" | "dataQuality"
>;

export const recipeTotalsFields = (
  recipeData: Pick<RecipeSelect, "totals" | "totalsPublishedAt">,
) => {
  const totals = totalsForRead(recipeData.totals, recipeData.totalsPublishedAt);
  return { totals, ...totalsPreview(totals) };
};

const dbRecipeToAPIShallow: (recipeParam: RecipeSelect) => RecipeShallowOut = (
  recipeData,
) => ({
  ...dbRecipeToTopLevel(recipeData),
  ...recipeTotalsFields(recipeData),
});

export const mapRecipeSections = (
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

export const dbRecipeToAPIGraph = (
  recipeData: RecipeGraphDB,
): Omit<RecipeGraphOut, "displayImage"> => {
  // The graph carries full `totals`; the flattened preview figures are a
  // list/detail projection and are not part of its output schema.
  const {
    cost: _cost,
    calories: _calories,
    protein: _protein,
    carbs: _carbs,
    fat: _fat,
    ...baseRecipe
  } = dbRecipeToAPIShallow(recipeData);
  return {
    ...baseRecipe,
    sections: mapRecipeSections(recipeData.sections),
  };
};
