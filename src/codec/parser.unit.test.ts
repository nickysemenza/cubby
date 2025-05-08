import { expect, test } from "vitest";
import { parseCompactRecipe } from "./parser";
import { format_amount, parse_ingredient } from "recipebridge/pkg";
import { is_valid_unit } from "recipebridge/pkg/recipebridge";

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
  expect(parseA.amounts[0]!.unit).toEqual("Whole");

  const parseB = parse_ingredient("1 clove garlic");

  expect(parseB).toEqual({
    name: "garlic",
    amounts: [{ value: 1, unit: "clove" }],
  });
  expect(parseB.amounts[0]!.unit).toEqual("clove");
});

test("wasm is_valid_unit", () => {
  expect(is_valid_unit("gram", [])).toEqual(true);
  expect(is_valid_unit("gra", [])).toEqual(false);
  expect(is_valid_unit("", [])).toEqual(false);
  expect(is_valid_unit("Cup", [])).toEqual(true);
  expect(is_valid_unit("cup", [])).toEqual(true);
  expect(is_valid_unit("foo", ["foo"])).toEqual(true);
  expect(is_valid_unit("foo", ["bar"])).toEqual(false);
});
