import type { Amount } from "@cubby/schemas/codec";
import type { IngredientWithFoodOut } from "@cubby/schemas/ingredient";
import type { ProductLabelNutrition } from "@cubby/schemas/nutrition";
import type { RecipeOut, SectionIngredientOut } from "@cubby/schemas/recipe";
import { testShortcode } from "@cubby/schemas/testing";

import {
  type CostingRow,
  computeRecipeCosting,
  type RecipeCosting,
} from "~/lib/recipe-costing";

// Shared fixture builders for the recipe-costing test suites
// (recipe-costing.unit.test.ts and recipe-totals-gaps.unit.test.ts).
//
// Almost every field on IngredientWithFoodOut / SectionIngredientOut / RecipeOut
// is irrelevant scaffolding for these tests. These builders state the defaults
// once so each test shows only the values its assertions actually depend on
// (mapping amounts, nutrient codes, names, yields). The `.fixtures.ts` suffix
// keeps this file out of the `*.unit.test.ts` glob so vitest won't collect it.

const TS = new Date();
const dates = { createdAt: TS, updatedAt: TS };

export type Product = IngredientWithFoodOut["product"][number];

export const getName = (i: SectionIngredientOut): string =>
  i.type === "ingredient" ? i.ingredient.name : "sub-recipe";

// ─── Amount factories ────────────────────────────────────────────────────────
export const g = (value: number): Amount => ({ value, unit: "g" });
export const each = (value: number): Amount => ({ value, unit: "each" });
export const cups = (value: number): Amount => ({ value, unit: "cup" });
export const lb = (value: number): Amount => ({ value, unit: "lb" });

// ─── Product / ingredient builders ───────────────────────────────────────────
export const makeProduct = (
  idStr: string,
  opts: {
    price?: number | null;
    fdc?: number | null;
    upc?: string | null;
    food?: Product["food"];
    // Attach USDA food data from per-100g nutrient codes (shorthand for `food`).
    nutrientsPer100?: Record<string, number>;
    mappings?: { a: Amount; b: Amount }[];
    labelNutrition?: ProductLabelNutrition | null;
  } = {},
): Product => ({
  id: testShortcode("product", "PRD-TEST"),
  name: idStr,
  aliases: [],
  tags: [],
  primaryGtin: opts.upc ?? null,
  fdc_id: opts.fdc ?? null,
  growsIngredientId: null,
  manufacturer: "",
  category: null,
  categoryId: null,
  classificationEvidence: "",
  itemImageCount: 0,
  labelImageCount: 0,
  labelImages: [],
  model: null,
  notes: null,
  expectedQuantity: null,
  price: opts.price ?? null,
  pricing: {
    derivedPrice: null,
    effectivePrice: opts.price ?? null,
    source: opts.price != null ? "explicit" : "none",
    knownExpenseCount: 0,
    unknownExpenseCount: 0,
    knownUnitCount: 0,
    partial: false,
  },
  usdaUnavailable: null,
  stockTracked: null,
  labelNutrition: opts.labelNutrition ?? null,
  images: [],
  coverImageUrl: null,
  externalIds: [],
  dataQuality: {
    status: "complete",
    score: 100,
    facets: [
      { name: "identity", status: "complete", gaps: [] },
      { name: "provenance", status: "complete", gaps: [] },
      { name: "integrity", status: "complete", gaps: [] },
    ],
    gaps: [],
    exceptions: [],
    relatedGaps: [],
    relatedExceptions: [],
  },
  food:
    opts.food ??
    (opts.nutrientsPer100
      ? {
          legacyFoodInfo: null,
          nutritionInfo: {
            nutrientsPer100: opts.nutrientsPer100,
            nutrientSummary: [],
          },
          fdc_id: 0,
          brandedFoodInfo: null,
          foodInfo: { data_type: "branded_food", description: "" },
          portionInfoRaw: [],
        }
      : null),
  unitMappings: (opts.mappings ?? []).map(({ a, b }, i) => ({
    id: `${idStr}-m${i}`,
    a,
    b,
    source: "test",
    sourceMetadata: { type: "manual" as const },
    ...dates,
  })),
  ...dates,
});

// Wrap pre-built products into an ingredient.
export const ingredientWith = (
  idStr: string,
  name: string,
  product: IngredientWithFoodOut["product"],
): IngredientWithFoodOut => ({
  id: testShortcode("ingredient", idStr),
  name,
  recipe: null,
  recipeUsages: [],
  appearsInRecipes: [],
  aliases: [],
  naKinds: [],
  usuallyOnHand: false,
  gardenGuideKey: null,
  guideSowWindow: null,
  guideTransplantWindow: null,
  ...dates,
  product,
});

// An ingredient backed by one product carrying `mappings`. Pass `nutrientsPer100`
// to attach USDA food data; omit it for a product with no nutrition.
export const ingredientFromMappings = (
  idStr: string,
  name: string,
  mappings: { a: Amount; b: Amount }[],
  nutrientsPer100?: Record<string, number>,
): IngredientWithFoodOut =>
  ingredientWith(idStr, name, [
    makeProduct(idStr, { mappings, nutrientsPer100 }),
  ]);

// An ingredient with no product at all (forces missing price/weight/nutrients).
export const emptyIngredient = (
  idStr: string,
  name: string,
): IngredientWithFoodOut => ingredientWith(idStr, name, []);

// ─── Section rows ────────────────────────────────────────────────────────────
// A section row referencing a plain ingredient (optionally with a modifier
// and/or a section name — both feed the usage classifier).
export const makeEntry = (
  idStr: string,
  name: string,
  amounts: Amount[],
  modifier?: string,
  sectionName?: string,
): CostingRow => ({
  id: idStr,
  type: "ingredient",
  ...dates,
  ingredient: {
    id: testShortcode("ingredient", idStr),
    name,
    ...dates,
  },
  recipe: null,
  amounts,
  modifier: modifier ?? null,
  sectionName: sectionName ?? null,
});

// A section row referencing a sub-recipe (recipe-as-ingredient).
export const makeSubRecipeEntry = (
  sub: RecipeOut,
  amounts: Amount[],
): CostingRow => ({
  id: `link-${sub.id}`,
  type: "recipe",
  ...dates,
  ingredient: null,
  recipe: sub,
  amounts,
  sectionName: null,
});

export const makeSubRecipe = (
  idStr: string,
  name: string,
  yieldValue: RecipeOut["yield"],
  ingredients: SectionIngredientOut[],
): RecipeOut => ({
  id: testShortcode("recipe", idStr),
  name,
  ...dates,
  meta: null,
  yield: yieldValue,
  images: [],
  forkedFromRecipeId: null,
  forkedFromRecipeName: null,
  sections: [
    { id: `${idStr}-sec`, name: null, instructions: [], ingredients, ...dates },
  ],
});

// ─── Root recipe + costing ───────────────────────────────────────────────────
// Wrap loose costing rows in a root recipe (one section per row, preserving
// each row's sectionName) and run the unified engine.
export const makeRootRecipe = (rows: CostingRow[]): RecipeOut => ({
  id: testShortcode("recipe", "root"),
  name: "root",
  ...dates,
  meta: null,
  yield: null,
  images: [],
  forkedFromRecipeId: null,
  forkedFromRecipeName: null,
  sections: rows.map((row, i) => {
    const { sectionName, ...ingredient } = row;
    return {
      id: `root-sec-${i}`,
      name: sectionName,
      instructions: [],
      ingredients: [ingredient],
      ...dates,
    };
  }),
});

export const costRecipe = (
  rows: CostingRow[],
  ingMap: Record<string, IngredientWithFoodOut>,
  recipeMap: Record<string, RecipeOut> = {},
): RecipeCosting => {
  const root = makeRootRecipe(rows);
  // Fixture callers use readable keys ("flour", "sauce"), while the rows
  // carry schema-valid deterministic shortcodes. Keep the readable aliases,
  // but also index each value by its actual branded id so the engine can join
  // rows to their entities exactly as production data does.
  const ingredientsById = normalizeIngredientMap(ingMap);
  const recipesById = Object.fromEntries(
    Object.values(recipeMap).map((recipe) => [recipe.id, recipe]),
  );
  const costing = computeRecipeCosting(
    [root],
    { ...ingMap, ...ingredientsById },
    getName,
    { ...recipeMap, ...recipesById },
  ).get(root.id);
  if (!costing) throw new Error("engine returned no costing for the root");
  return costing;
};

/** Index fixture ingredients by their schema-valid ids for downstream passes. */
export const normalizeIngredientMap = (
  ingMap: Record<string, IngredientWithFoodOut>,
): Record<string, IngredientWithFoodOut> =>
  Object.fromEntries(
    Object.values(ingMap).map((ingredient) => [ingredient.id, ingredient]),
  );

export const calculateTotals = (
  rows: CostingRow[],
  ingMap: Record<string, IngredientWithFoodOut>,
  recipeMap: Record<string, RecipeOut> = {},
) => costRecipe(rows, ingMap, recipeMap).totals;
