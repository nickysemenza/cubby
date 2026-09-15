import { describe, expect, it } from "vitest";
import { testShortcode } from "./test-support/identifiers";
import {
  mealFoodAmount,
  mealFoodAmountFromStored,
  saveMealFoodInput,
} from "./meal";

describe("logged meal amounts", () => {
  const common = {
    mealId: testShortcode("meal", "amount-meal"),
    ledgerPartyId: testShortcode("ledgerParty", "amount-eater"),
  };
  it("retains positive scalar amounts, including units without a conversion", () => {
    expect(mealFoodAmount.parse({ value: 0.25, unit: "batch" })).toEqual({
      value: 0.25,
      unit: "batch",
    });
    expect(mealFoodAmount.parse({ value: 1, unit: "bowl" })).toEqual({
      value: 1,
      unit: "bowl",
    });
    for (const input of [
      { value: 0, unit: "g" },
      { value: -1, unit: "g" },
      { value: Infinity, unit: "g" },
      { value: 1, unit: " " },
      { value: 1, unit: "cup", upperValue: 2 },
    ])
      expect(mealFoodAmount.safeParse(input).success).toBe(false);
  });
  it("accepts legacy grams but refuses two competing amounts", () => {
    const product = {
      ...common,
      sourceKind: "product",
      productId: testShortcode("product", "amount-product"),
    };
    const legacy = saveMealFoodInput.parse({ ...product, grams: 125 });
    expect(mealFoodAmountFromStored(legacy)).toEqual({ value: 125, unit: "g" });
    expect(
      saveMealFoodInput.safeParse({
        ...product,
        grams: 125,
        amount: { value: 1, unit: "serving" },
      }).success,
    ).toBe(false);
    expect(saveMealFoodInput.safeParse(product).success).toBe(false);
  });
  it("allows descriptive manual amounts without making them a multiplier", () => {
    const manual = saveMealFoodInput.parse({
      ...common,
      sourceKind: "manual",
      name: "Lunch",
      nutrients: { kcal: 200, fat: 0 },
      amount: { value: 2, unit: "pieces" },
    });
    expect(manual).toMatchObject({
      nutrients: { kcal: 200, fat: 0 },
      amount: { value: 2, unit: "pieces" },
    });
    expect(
      saveMealFoodInput.safeParse({ ...manual, grams: null }).success,
    ).toBe(false);
  });
});
