import type { Amount } from "@cubby/schemas/codec";
import {
  unsafeIngredientId,
  unsafeProductId,
  unsafeProductShortcode,
  unsafeRecipeId,
} from "@cubby/schemas/identifiers";
import type { RecipeOut, SectionIngredientOut } from "@cubby/schemas/recipe";
import {
  type CostingRow,
  computeRecipeCosting,
  type RecipeCosting,
} from "~/lib/recipe-costing";
import type { IngredientWithFoodOut } from "~/server/services/ingredient.service";

// Shared fixture builders for the recipe-costing test suites
// (recipe-costing.unit.test.ts and recipe-costing-gaps.unit.test.ts).
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
  } = {},
): Product => ({
  id: unsafeProductId(`prod-${idStr}`),
  shortcode: unsafeProductShortcode("P-TEST"),
  name: idStr,
  upc: opts.upc ?? null,
  fdc_id: opts.fdc ?? null,
  manufacturer: "",
  category: null,
  model: null,
  expectedQuantity: null,
  price: opts.price ?? null,
  usdaUnavailable: null,
  images: [],
  externalIds: [],
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
  id: unsafeIngredientId(idStr),
  name,
  recipe: null,
  recipeUsages: [],
  appearsInRecipes: [],
  aliases: [],
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
  ingredient: { id: unsafeIngredientId(idStr), name, ...dates },
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
  id: unsafeRecipeId(idStr),
  name,
  ...dates,
  meta: null,
  yield: yieldValue,
  images: [],
  sections: [
    { id: `${idStr}-sec`, name: null, instructions: [], ingredients, ...dates },
  ],
});

// ─── Root recipe + costing ───────────────────────────────────────────────────
// Wrap loose costing rows in a root recipe (one section per row, preserving
// each row's sectionName) and run the unified engine.
export const makeRootRecipe = (rows: CostingRow[]): RecipeOut => ({
  id: unsafeRecipeId("root"),
  name: "root",
  ...dates,
  meta: null,
  yield: null,
  images: [],
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
  const costing = computeRecipeCosting([root], ingMap, getName, recipeMap).get(
    root.id,
  );
  if (!costing) throw new Error("engine returned no costing for the root");
  return costing;
};

export const calculateTotals = (
  rows: CostingRow[],
  ingMap: Record<string, IngredientWithFoodOut>,
  recipeMap: Record<string, RecipeOut> = {},
) => costRecipe(rows, ingMap, recipeMap).totals;
