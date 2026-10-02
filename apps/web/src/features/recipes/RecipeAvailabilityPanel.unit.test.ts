import type { IngredientAvailability } from "@cubby/schemas/availability";
import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import { recipeAvailabilityPresentation } from "./RecipeAvailabilityPanel";

const ingredient = (
  overrides: Partial<IngredientAvailability> = {},
): IngredientAvailability => ({
  ingredientId: testShortcode("ingredient", "ING-FLOUR"),
  name: "Flour",
  need: { value: 2, unit: "cup" },
  basisUnit: "cup",
  needValue: 2,
  haveValue: null,
  status: "missing",
  usuallyOnHand: false,
  covered: false,
  availabilitySource: null,
  quantityIssues: [],
  via: [],
  blockedReason: null,
  ...overrides,
});

describe("recipeAvailabilityPresentation", () => {
  it("counts a staple as covered while keeping the recorded-stock shortfall separate", () => {
    const presentation = recipeAvailabilityPresentation(
      [
        ingredient({
          usuallyOnHand: true,
          covered: true,
          availabilitySource: "assumed",
        }),
      ],
      0,
    );

    expect(presentation.assumedNames).toEqual(["Flour"]);
    expect(presentation.shortfalls).toEqual([]);
    expect(presentation.ready).toBe(true);
  });

  it("never calls a fully covered recipe ready when its quantity is unresolved", () => {
    const presentation = recipeAvailabilityPresentation(
      [
        ingredient({
          need: null,
          needValue: null,
          usuallyOnHand: true,
          covered: true,
          availabilitySource: "assumed",
          quantityIssues: ["missingAmount"],
        }),
      ],
      0,
    );

    expect(presentation.shortfalls).toEqual([]);
    expect(presentation.hasQuantityIssues).toBe(true);
    expect(presentation.ready).toBe(false);
  });

  it("never calls a fully covered recipe ready when a sub-recipe is blocked", () => {
    expect(
      recipeAvailabilityPresentation([ingredient({ covered: true })], 1).ready,
    ).toBe(false);
  });
});
