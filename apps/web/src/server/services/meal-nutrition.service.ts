import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  mealNutritionFood,
  mealNutritionOut,
  nutritionMeal,
  type MealNutritionInput,
  type MealNutritionPerson,
} from "@cubby/schemas/meal";
import { buildNutrition, type NutritionTotals } from "@cubby/schemas/nutrition";

import { manualFoodTotals, productFoodTotals } from "~/lib/meal-food-nutrition";
import { aggregateTotals, scaleTotals } from "~/lib/nutrition-estimates";
import type { Database } from "~/server/db";
import { getMealNutritionRows } from "~/server/repo/meal/food";
import {
  batchTotalsFor,
  portionTotalsFor,
  yieldBasisFor,
} from "~/server/repo/meal/portions";
import {
  foodLookupParamFromProduct,
  getProductsByShortcodes,
} from "~/server/repo/product";

import { batchEnrichWithFood, type UsdaFoodBatchPort } from "./usda-helpers";

export async function getMealNutrition(
  db: Database,
  input: MealNutritionInput,
  usdaClient: UsdaFoodBatchPort,
) {
  const rows = await getMealNutritionRows(db, input);
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
    (p) => (p.labelNutrition ? null : foodLookupParamFromProduct(p)),
    usdaClient,
  );
  const productTotals = new Map(
    products.map((p) => [p.id, productFoodTotals(p, 100)]),
  );
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
  for (const p of rows.portions)
    append(
      p.eaterId,
      p.eaterName,
      mealNutritionFood.parse({
        sourceKind: "recipe",
        meal: meals.get(p.mealId),
        name: p.name,
        grams: p.grams,
        mealRecipeId: p.mealRecipeId,
        recipeId: p.recipeId,
        sourceMealId: p.sourceMealId,
        totals: portionTotalsFor(
          batchTotalsFor(p.recipeTotals, p.totalsComputedAt, p.scale),
          yieldBasisFor(
            p.actualYieldGrams,
            p.estimatedYieldGrams,
            p.recipeYield,
            p.scale,
          ),
          p.grams,
        ),
      }),
    );
  for (const row of rows.foods) {
    const e = row.entry;
    if (e.sourceKind === "product") {
      const totals =
        (row.productId && row.productDeletedAt == null
          ? productTotals.get(parseShortcodeFor("product", row.productId))
          : null) ?? unavailableSourceTotals;
      if (!row.productId || !row.productName || e.grams == null) continue;
      append(
        row.eaterId,
        row.eaterName,
        mealNutritionFood.parse({
          sourceKind: "product",
          id: e.id,
          productId: row.productId,
          meal: meals.get(e.mealId),
          name: row.productName,
          grams: e.grams,
          totals: scaleTotals(totals, e.grams / 100),
        }),
      );
    } else if (e.nutrients && e.name)
      append(
        row.eaterId,
        row.eaterName,
        mealNutritionFood.parse({
          sourceKind: "manual",
          id: e.id,
          meal: meals.get(e.mealId),
          name: e.name,
          grams: e.grams,
          nutrients: e.nutrients,
          totals: manualFoodTotals(e.nutrients),
        }),
      );
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

const unavailableEstimate = {
  status: "unavailable" as const,
  reason: "no_data" as const,
};
const unavailableSourceTotals: NutritionTotals = {
  cost: unavailableEstimate,
  nutrition: buildNutrition(() => unavailableEstimate),
};
