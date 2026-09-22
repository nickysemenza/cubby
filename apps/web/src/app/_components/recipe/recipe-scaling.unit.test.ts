import type { Amount } from "@cubby/schemas/codec";
import { type RecipeOut, recipeOut } from "@cubby/schemas/recipe";
import {
  testCompleteDataQuality,
  testEntityId,
  testShortcode,
} from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import { scaleRecipe } from "./recipe-scaling";

const row = (id: string, amounts: Amount[]) =>
  ({
    id: testEntityId("recipe", `row-${id}`),
    type: "ingredient",
    amounts,
    modifier: null,
    rawLine: null,
    recipe: null,
    ingredient: {
      id: testShortcode("ingredient", `ING-${id}`),
      name: id,
      aliases: [],
      naKinds: [],
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  }) as const;

const recipe = (
  ingredients: ReadonlyArray<ReturnType<typeof row>>,
  extra: Partial<Pick<RecipeOut, "yield" | "servings">> = {},
): RecipeOut =>
  recipeOut.parse({
    id: testShortcode("recipe", "RCP-SCALE"),
    name: "R",
    meta: null,
    yield: null,
    servings: null,
    notes: null,
    forkedFromRecipeId: null,
    forkedFromRecipeName: null,
    images: [],
    tags: [],
    sections: [
      {
        id: testEntityId("recipe", "section"),
        name: null,
        instructions: [],
        ingredients,
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-01"),
      },
    ],
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    dataQuality: testCompleteDataQuality(),
    ...extra,
  });

const amountsOf = (r: RecipeOut, i = 0) =>
  r.sections[0]!.ingredients[i]!.amounts;

describe("scaleRecipe", () => {
  it("scales weight and volume amounts", () => {
    const scaled = scaleRecipe(
      recipe([row("flour", [{ value: 100, unit: "g" }])]),
      2.5,
    );
    expect(amountsOf(scaled)[0]).toMatchObject({ value: 250, unit: "g" });
  });

  // The bug this file exists for: every amount used to be multiplied, so
  // doubling a recipe produced an 18-inch pie crust, a 700°F oven and a
  // 40-minute rest. Dimension/time/temperature are amounts, but not quantities.
  it.each([
    ["inch", 9],
    ["minute", 20],
    ["°F", 350],
  ])("does not scale a %s amount", (unit, value) => {
    const scaled = scaleRecipe(recipe([row("pan", [{ value, unit }])]), 2);
    expect(amountsOf(scaled)[0]).toMatchObject({ value, unit });
  });

  it("scales a countable amount on the same row as an unscalable one", () => {
    const scaled = scaleRecipe(
      recipe([
        row("crust", [
          { value: 1, unit: "whole" },
          { value: 9, unit: "inch" },
        ]),
      ]),
      2,
    );
    expect(amountsOf(scaled)[0]).toMatchObject({ value: 2, unit: "whole" });
    expect(amountsOf(scaled)[1]).toMatchObject({ value: 9, unit: "inch" });
  });

  it("scales both ends of a range", () => {
    const scaled = scaleRecipe(
      recipe([row("stock", [{ value: 2, unit: "cup", upperValue: 3 }])]),
      2,
    );
    expect(amountsOf(scaled)[0]).toMatchObject({ value: 4, upperValue: 6 });
  });

  // A scaled recipe that re-spelled its units would read differently from the
  // same recipe at 1×, which returns the input untouched.
  it("preserves the authored unit spelling", () => {
    const scaled = scaleRecipe(
      recipe([row("oil", [{ value: 2, unit: "tablespoons" }])]),
      2,
    );
    expect(amountsOf(scaled)[0]?.unit).toBe("tablespoons");
  });

  it("scales yield and servings", () => {
    const scaled = scaleRecipe(
      recipe([row("flour", [{ value: 1, unit: "cup" }])], {
        yield: { value: 4, unit: "servings" },
        servings: 4,
      }),
      1.5,
    );
    expect(scaled.yield?.value).toBe(6);
    expect(scaled.servings).toBe(6);
  });

  it("returns the input untouched at 1x", () => {
    const input = recipe([row("flour", [{ value: 1, unit: "cup" }])]);
    expect(scaleRecipe(input, 1)).toBe(input);
  });
});
