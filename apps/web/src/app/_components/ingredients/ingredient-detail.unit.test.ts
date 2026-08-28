import { productWithMappingsAndFoodOut } from "@cubby/schemas/product";
import { testShortcode } from "@cubby/schemas/testing";
import { foodSummary } from "@cubby/usda-schemas";
import { describe, expect, it } from "vitest";

import { mock } from "~/lib/test/mock-schema";

import { selectNutritionProduct } from "./ingredient-detail";

// `food.nutritionInfo` is a required (non-nullable) field on `foodSummary`, so
// once `food` is non-null it always carries a (possibly empty) nutritionInfo
// object — the truthiness check in selectNutritionProduct is really gated on
// `food` being present at all.
const productWithFood = (shortcode: string, price: number | null) =>
  mock(productWithMappingsAndFoodOut, {
    seed: 1,
    overrides: {
      id: testShortcode("product", shortcode),
      price,
      externalIds: [],
      food: mock(foodSummary, {
        seed: 3,
        overrides: {
          nutritionInfo: { nutrientSummary: [], nutrientsPer100: {} },
        },
      }),
    },
  });

const productWithoutFood = (shortcode: string, price: number | null) =>
  mock(productWithMappingsAndFoodOut, {
    seed: 2,
    overrides: {
      id: testShortcode("product", shortcode),
      price,
      externalIds: [],
      food: null,
    },
  });

describe("selectNutritionProduct", () => {
  it("prefers the product that carries both nutrition and price over one with nutrition but no price", () => {
    // Regression fixture for the pre-existing bug: nutrition came from
    // `ingredient.product.find(p => p.food?.nutritionInfo)` — an arbitrary
    // product not necessarily the one supplying price — so a priced product
    // with no nutrition data could silently pair with an unrelated product's
    // nutrients.
    const noPriceButFood = productWithFood("PRD-AAAA", null);
    const pricedWithFood = productWithFood("PRD-BBBB", 12.5);

    const selected = selectNutritionProduct([noPriceButFood, pricedWithFood]);

    expect(selected?.id).toBe(pricedWithFood.id);
    expect(selected?.price).toBe(12.5);
  });

  it("does not let list order override the price-and-nutrition preference", () => {
    const pricedWithFood = productWithFood("PRD-CCCC", 5);
    const noPriceButFood = productWithFood("PRD-DDDD", null);

    const selected = selectNutritionProduct([noPriceButFood, pricedWithFood]);

    expect(selected?.id).toBe(pricedWithFood.id);
  });

  it("falls back to nutrition-only when no product has both", () => {
    const noPriceButFood = productWithFood("PRD-EEEE", null);
    const pricedNoFood = productWithoutFood("PRD-FFFF", 9.99);

    const selected = selectNutritionProduct([pricedNoFood, noPriceButFood]);

    expect(selected?.id).toBe(noPriceButFood.id);
  });

  it("returns undefined when no product has nutrition data", () => {
    const pricedNoFood = productWithoutFood("PRD-GGGG", 9.99);

    expect(selectNutritionProduct([pricedNoFood])).toBeUndefined();
  });
});
