import { productWithMappingsAndFoodOut } from "@cubby/schemas/product";
import { testShortcode } from "@cubby/schemas/testing";
import { foodSummary } from "@cubby/usda";
import { describe, expect, it } from "vitest";

import { mock } from "~/lib/test/mock-schema";

import {
  buildIngredientNutritionProduct,
  selectNutritionProduct,
} from "./nutrition-product";

// `food.nutritionInfo` is required once `food` is non-null, so the selection is
// really gated on `food` being present at all.
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

const productWithLabel = (shortcode: string, price: number | null) =>
  mock(productWithMappingsAndFoodOut, {
    seed: 4,
    overrides: {
      id: testShortcode("product", shortcode),
      price,
      externalIds: [],
      food: null,
      labelNutrition: {
        servingGrams: 44,
        nutrients: { kcal: 120 },
        source: null,
      },
    },
  });

// Failure modes: nutrition paired with a different product's price (cost per
// nutrient silently misattributed), list order deciding the pick, a USDA food
// leading a package label, and a client re-deriving the choice differently.
describe("selectNutritionProduct", () => {
  it("prefers the product that carries both nutrition and price over one with nutrition but no price", () => {
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

  it("prefers a labelled product over a USDA-nutrition product — same precedence as costing", () => {
    const usdaProduct = productWithFood("PRD-HHHH", 5);
    const labelledProduct = productWithLabel("PRD-IIII", null);

    const selected = selectNutritionProduct([usdaProduct, labelledProduct]);

    expect(selected?.id).toBe(labelledProduct.id);
  });

  it("among labelled products, still prefers the one that also carries price", () => {
    const labelNoPrice = productWithLabel("PRD-JJJJ", null);
    const labelWithPrice = productWithLabel("PRD-KKKK", 3.5);

    const selected = selectNutritionProduct([labelNoPrice, labelWithPrice]);

    expect(selected?.id).toBe(labelWithPrice.id);
  });
});

describe("buildIngredientNutritionProduct", () => {
  it("is null when no product carries nutrition", () => {
    expect(
      buildIngredientNutritionProduct([productWithoutFood("PRD-LLLL", 1)]),
    ).toBeNull();
  });

  it("names the chosen product and carries its label display", () => {
    const labelled = productWithLabel("PRD-MMMM", 3.5);

    expect(buildIngredientNutritionProduct([labelled])).toMatchObject({
      productId: labelled.id,
      name: labelled.name,
      manufacturer: labelled.manufacturer,
      display: {
        source: "label",
        basis: "Per serving · 44 g",
        rows: [{ key: "kcal", amount: 120, inferred: false }],
      },
    });
  });
});
