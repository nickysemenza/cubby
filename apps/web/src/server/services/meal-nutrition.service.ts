import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  mealNutritionFood,
  mealNutritionOut,
  nutritionMeal,
  type MealNutritionInput,
  type MealNutritionPerson,
} from "@cubby/schemas/meal";

import { calculateFoodAmount } from "~/lib/meal-food-nutrition";
import { aggregateTotals } from "~/lib/nutrition-estimates";
import type { Database } from "~/server/db";
import { getMealNutritionRows } from "~/server/repo/meal/food";
import { batchTotalsFor, yieldBasisFor } from "~/server/repo/meal/portions";
import {
  foodLookupParamFromProduct,
  getProductsByShortcodes,
} from "~/server/repo/product";
import { resolveAllOrThrow } from "~/server/repo/shortcode-resolver";

import { getIngredientsByIDs } from "./ingredient.service";
import type { RecipeCostingService } from "./recipe-costing.service";
import { repairStaleRecipesForRead } from "./repair-stale-recipes-for-read";
import { batchEnrichWithFood, type UsdaFoodBatchPort } from "./usda-helpers";

export async function getMealNutrition(
  db: Database,
  input: MealNutritionInput,
  usdaClient: UsdaFoodBatchPort,
  recipeCosting?: RecipeCostingService,
) {
  let rows = await getMealNutritionRows(db, input);
  if (recipeCosting) {
    const recipeIds = await resolveAllOrThrow(
      recipeCosting.database,
      "recipe",
      [...new Set(rows.portions.map((row) => row.recipeId))],
    );
    const repaired = await repairStaleRecipesForRead(
      recipeCosting,
      recipeIds,
      "meal.getNutrition",
    );
    if (repaired) {
      rows = await getMealNutritionRows(recipeCosting.database, input);
      db = recipeCosting.database;
    }
  }
  const meals = new Map(
    rows.meals.map((m) => [
      m.id,
      nutritionMeal.parse({ ...m, id: m.shortcode }),
    ]),
  );
  const codes = [
    ...new Set(
      rows.foods.flatMap((row) =>
        row.productId && row.productDeletedAt == null ? [row.productId] : [],
      ),
    ),
  ];
  const products = await batchEnrichWithFood(
    await getProductsByShortcodes(db, codes),
    foodLookupParamFromProduct,
    usdaClient,
  );
  const productById = new Map(products.map((p) => [p.id, p]));
  const ingredients = await getIngredientsByIDs(db, usdaClient, [
    ...new Set(
      rows.foods.flatMap((row) =>
        row.entry.ingredientId && row.ingredientDeletedAt == null
          ? [row.entry.ingredientId]
          : [],
      ),
    ),
  ]);
  const ingredientById = new Map(ingredients.map((i) => [i.id, i]));
  const people = new Map<string, MealNutritionPerson>();
  const append = (
    eaterId: string,
    eaterName: string,
    food: typeof mealNutritionFood._output,
  ) => {
    let person = people.get(eaterId);
    if (!person) {
      person = {
        eater: {
          id: parseShortcodeFor("ledgerParty", eaterId),
          name: eaterName,
        },
        totals: aggregateTotals([]),
        meals: [],
        foods: [],
      };
      people.set(eaterId, person);
    }
    person.foods.push(food);
  };
  for (const p of rows.portions) {
    const amount = p.amount;
    const result = calculateFoodAmount(amount, {
      kind: "recipe",
      batch: batchTotalsFor(p.recipeTotals, p.totalsComputedAt, p.scale),
      yieldBasis: yieldBasisFor(
        p.actualYieldGrams,
        p.estimatedYieldGrams,
        p.recipeYield,
        p.scale,
      ),
      recipeYield: p.recipeYield,
      servings: p.recipeServings,
      scale: p.scale,
    });
    append(
      p.eaterId,
      p.eaterName,
      mealNutritionFood.parse({
        sourceKind: "recipe",
        meal: meals.get(p.mealId),
        name: p.name,
        amount,
        mealRecipeId: p.mealRecipeId,
        recipeId: p.recipeId,
        sourceMealId: p.sourceMealId,
        ...result,
      }),
    );
  }
  for (const row of rows.foods) {
    const e = row.entry;
    const amount = e.amount;
    const common = { id: e.id, meal: meals.get(e.mealId), amount };
    if (e.sourceKind === "product" && row.productId && row.productName) {
      const source =
        row.productDeletedAt == null
          ? productById.get(parseShortcodeFor("product", row.productId))
          : undefined;
      append(
        row.eaterId,
        row.eaterName,
        mealNutritionFood.parse({
          ...common,
          sourceKind: "product",
          productId: row.productId,
          name: row.productName,
          ...calculateFoodAmount(
            amount,
            source
              ? { kind: "product", product: source }
              : { kind: "unavailable" },
          ),
        }),
      );
    } else if (
      e.sourceKind === "ingredient" &&
      row.ingredientId &&
      row.ingredientName
    ) {
      const source =
        row.ingredientDeletedAt == null
          ? ingredientById.get(
              parseShortcodeFor("ingredient", row.ingredientId),
            )
          : undefined;
      append(
        row.eaterId,
        row.eaterName,
        mealNutritionFood.parse({
          ...common,
          sourceKind: "ingredient",
          ingredientId: row.ingredientId,
          name: row.ingredientName,
          ...calculateFoodAmount(
            amount,
            source
              ? { kind: "ingredient", ingredient: source }
              : { kind: "unavailable" },
          ),
        }),
      );
    } else if (e.sourceKind === "manual" && e.nutrients && e.name) {
      append(
        row.eaterId,
        row.eaterName,
        mealNutritionFood.parse({
          ...common,
          sourceKind: "manual",
          name: e.name,
          nutrients: e.nutrients,
          ...calculateFoodAmount(amount, {
            kind: "manual",
            nutrients: e.nutrients,
          }),
        }),
      );
    }
  }
  for (const person of people.values()) {
    person.foods.sort(
      (a, b) =>
        rows.meals.findIndex((m) => meals.get(m.id)?.id === a.meal.id) -
        rows.meals.findIndex((m) => meals.get(m.id)?.id === b.meal.id),
    );
    person.totals = aggregateTotals(person.foods.map((food) => food.totals));
    person.meals = [...meals.values()].flatMap((meal) => {
      const foods = person.foods.filter((food) => food.meal.id === meal.id);
      return foods.length
        ? [{ meal, totals: aggregateTotals(foods.map((food) => food.totals)) }]
        : [];
    });
  }
  return mealNutritionOut.parse({
    meals: [...meals.values()],
    people: [...people.values()].sort((a, b) =>
      a.eater.name.localeCompare(b.eater.name),
    ),
  });
}
