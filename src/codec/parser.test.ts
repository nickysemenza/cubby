import { expect, test } from "vitest";
import { parseCompactRecipe } from "./parser";

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
