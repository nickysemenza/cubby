import { expect, test } from "vitest";
import { parseCompactRecipe } from "./parser";
import { format_amount, parse_ingredient } from "recipebridge/pkg";
import { getIngredientUnit } from "~/app/_components/recipe/recipeutils";

test("parsing works", async () => {
  const out = await parseCompactRecipe({
    name: "Pancakes",
    sections: [
      {
        ingredients: ["1 cup flour", "1 cup milk"],
        instructions: ["Mix ingredients", "Cook on griddle"],
      },
    ],
  });
  expect(out).toEqual({
    name: "Pancakes",
    sections: [
      {
        ingredients: [
          { name: "flour", amounts: [{ value: 1, unit: "Cup" }] },
          { name: "milk", amounts: [{ value: 1, unit: "Cup" }] },
        ],
        instructions: ["Mix ingredients", "Cook on griddle"],
      },
    ],
  });
});

test("formatting with wasm", () => {
  expect(format_amount({ value: 1, unit: "Cup" })).toEqual("1 cup");
  // expect(format_amount({ value: 1, unit: "cup" })).toEqual("1 cup");
});

test("wasm unknown ingrecient", () => {
  const parseA = parse_ingredient("1 foo bar");
  expect(parseA).toEqual({
    name: "foo bar",
    amounts: [{ value: 1, unit: "Whole" }],
  });
  expect(getIngredientUnit(parseA.amounts[0]!)).toEqual("Whole");

  const parseB = parse_ingredient("1 clove garlic");

  expect(parseB).toEqual({
    name: "garlic",
    amounts: [{ value: 1, unit: { Other: "clove" } }],
  });
  expect(getIngredientUnit(parseB.amounts[0]!)).toEqual("clove");
});
