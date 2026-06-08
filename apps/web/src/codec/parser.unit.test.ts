import {
  amount_kind,
  format_amount,
  is_valid_unit,
  parse_ingredient,
} from "@cubby/recipebridge";
import { beforeAll, expect, test } from "vitest";
import { ensureWasm } from "~/lib/wasm";
import { parseCompactRecipe } from "./parser";

// Initialize WASM before all tests
beforeAll(async () => {
  await ensureWasm();
});

test("parsing works", () => {
  const out = parseCompactRecipe({
    name: "Pancakes",
    sections: [
      {
        ingredients: ["1 cup flour", "1 cup milk"],
        instructions: ["Mix ingredients", "Cook on griddle"],
      },
    ],
  });
  // WASM now returns lowercase unit names and additional optional fields
  expect(out).toMatchObject({
    name: "Pancakes",
    sections: [
      {
        ingredients: [
          { name: "flour", amounts: [{ value: 1, unit: "cup" }] },
          { name: "milk", amounts: [{ value: 1, unit: "cup" }] },
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
  // WASM returns lowercase unit names and additional optional fields
  expect(parseA).toMatchObject({
    name: "foo bar",
    amounts: [{ value: 1, unit: "whole" }],
  });
  expect(parseA.amounts[0]!.unit).toEqual("whole");

  const parseB = parse_ingredient("1 clove garlic");

  expect(parseB).toMatchObject({
    name: "garlic",
    amounts: [{ value: 1, unit: "clove" }],
  });
  expect(parseB.amounts[0]!.unit).toEqual("clove");
});

test("wasm amount_kind", () => {
  expect(amount_kind({ value: 1, unit: "Cup" })).toEqual("volume");
  expect(amount_kind({ value: 1, unit: "gram" })).toEqual("weight");
  expect(amount_kind({ value: 1, unit: "dollar" })).toEqual("money");
  expect(amount_kind({ value: 1, unit: "kcal" })).toEqual("calories");
  expect(amount_kind({ value: 1, unit: "second" })).toEqual("time");
  // expect(amount_kind({ value: 1, unit: "farenheit" })).toEqual("temperature");
  expect(amount_kind({ value: 1, unit: "inch" })).toEqual("length");
  // `other`/`nutrient` kinds now carry their inner unit string so the value
  // round-trips through MeasureKind::from_str (was a lossy bare "other").
  expect(amount_kind({ value: 1, unit: "foo" })).toEqual("other:foo");
  expect(amount_kind({ value: 1, unit: "whole" })).toEqual("other:whole");
});

test("wasm is_valid_unit", () => {
  expect(is_valid_unit("gram", [])).toEqual(true);
  expect(is_valid_unit("gra", [])).toEqual(false);
  expect(is_valid_unit("", [])).toEqual(false);
  expect(is_valid_unit("Cup", [])).toEqual(true);
  expect(is_valid_unit("cup", [])).toEqual(true);
  expect(is_valid_unit("each", [])).toEqual(true);
  expect(is_valid_unit("whole", [])).toEqual(true);
  expect(is_valid_unit("foo", ["foo"])).toEqual(true);
  expect(is_valid_unit("foo", ["bar"])).toEqual(false);
});

test("wasm format_amount handles each and whole", () => {
  // WASM should format "each" and "whole" as equivalent count units
  expect(format_amount({ value: 3, unit: "each" })).toMatch(/3/);
  expect(format_amount({ value: 3, unit: "whole" })).toMatch(/3/);
});
