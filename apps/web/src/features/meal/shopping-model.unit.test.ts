import type {
  ShoppingListContribution,
  ShoppingListItem,
} from "@cubby/schemas/meal";
import {
  shoppingListContribution,
  shoppingListItem,
  shoppingListOut,
} from "@cubby/schemas/meal";
import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  buildShoppingColumns,
  buildShoppingRows,
  SHOPPING_CHECKED_STORAGE_KEY,
  shoppingRowsToText,
  toggleInSet,
} from "./shopping-model";

const NONE: ReadonlySet<string> = new Set();

type ContributionOverrides = Partial<
  Omit<ShoppingListContribution, "mealId" | "recipeId">
> & { mealId?: string; recipeId?: string };

type ItemOverrides = Partial<
  Omit<ShoppingListItem, "ingredientId" | "perMeal">
> & { ingredientId?: string | null; perMeal?: ShoppingListContribution[] };

let nextLine = 0;
const contribution = (
  over: ContributionOverrides = {},
): ShoppingListContribution => {
  const { mealId, recipeId, ...rest } = over;
  const input: z.input<typeof shoppingListContribution> = {
    mealId: testShortcode("meal", "MEL-1"),
    mealName: "Dinner",
    date: "2026-06-15",
    recipeId: testShortcode("recipe", "RCP-1"),
    recipeName: "Pancakes",
    scale: 1,
    needValue: 100,
    amount: { value: 100, unit: "g" },
    lineIndex: nextLine++,
    via: [],
    ...rest,
  };
  if (mealId !== undefined) input.mealId = testShortcode("meal", mealId);
  if (recipeId !== undefined)
    input.recipeId = testShortcode("recipe", recipeId);
  return shoppingListContribution.parse(input);
};

const item = (over: ItemOverrides = {}): ShoppingListItem => {
  const { ingredientId, ...rest } = over;
  const input: z.input<typeof shoppingListItem> = {
    ingredientId: testShortcode("ingredient", "ING-1"),
    name: "flour",
    basisUnit: "g",
    needValue: 100,
    haveValue: 500,
    shortfall: 0,
    status: "ok",
    estimatedCost: null,
    usuallyOnHand: false,
    covered: true,
    availabilitySource: "inventory",
    quantityIssues: [],
    membership: "buy",
    perMeal: [contribution()],
    ...rest,
  };
  if (ingredientId !== undefined) {
    input.ingredientId =
      ingredientId === null ? null : testShortcode("ingredient", ingredientId);
  }
  return shoppingListItem.parse(input);
};

describe("buildShoppingRows", () => {
  it("preserves server quantities and stock verdict instead of recomputing from display contributions", () => {
    const [row] = buildShoppingRows(
      [
        item({
          needValue: 160,
          haveValue: 100,
          shortfall: 60,
          status: "short",
          perMeal: [
            contribution({ needValue: 100 }),
            contribution({ needValue: 60 }),
          ],
        }),
      ],
      NONE,
    );
    expect(row).toMatchObject({
      need: 160,
      shortfall: 60,
      status: "short",
      item: { haveValue: 100 },
    });
  });
  it("retains unresolved needs and recorded unknown shortfalls", () => {
    const [row] = buildShoppingRows(
      [
        item({
          needValue: null,
          shortfall: null,
          quantityIssues: ["missingAmount"],
          status: "unconvertible",
        }),
      ],
      NONE,
    );
    expect(row).toMatchObject({
      need: null,
      shortfall: null,
      status: "unconvertible",
    });
  });
  it("sorts checked buy rows last while secondary rows never acquire ticks", () => {
    const rows = buildShoppingRows(
      [
        item({ ingredientId: "ING-A", shortfall: 10 }),
        item({ ingredientId: "ING-B", shortfall: 90 }),
        item({
          ingredientId: "ING-C",
          shortfall: 50,
          membership: "usuallyOnHand",
          usuallyOnHand: true,
        }),
      ],
      new Set([
        testShortcode("ingredient", "ING-B"),
        testShortcode("ingredient", "ING-C"),
      ]),
    );
    expect(rows.map((r) => r.key)).toEqual([
      testShortcode("ingredient", "ING-C"),
      testShortcode("ingredient", "ING-A"),
      testShortcode("ingredient", "ING-B"),
    ]);
    expect(rows[0]?.isChecked).toBe(false);
    expect(rows[2]?.isChecked).toBe(true);
  });
});

describe("buildShoppingColumns", () => {
  const meals = shoppingListOut.shape.meals.parse([
    {
      id: testShortcode("meal", "MEL-2"),
      name: "Dinner",
      date: "2026-06-16",
    },
    {
      id: testShortcode("meal", "MEL-1"),
      name: "Lunch",
      date: "2026-06-15",
    },
  ]);

  it("orders columns by the server's meal order, not by mention order", () => {
    const { columns } = buildShoppingColumns(
      {
        meals,
        items: [
          item({
            perMeal: [
              contribution({ mealId: "MEL-1", lineIndex: 0 }),
              contribution({ mealId: "MEL-2", lineIndex: 1 }),
            ],
          }),
        ],
      },
      NONE,
    );

    expect(columns.map((c) => c.mealId)).toEqual([
      testShortcode("meal", "MEL-2"),
      testShortcode("meal", "MEL-1"),
    ]);
  });

  it("keeps a meal that plans the same recipe twice as two columns", () => {
    const { columns } = buildShoppingColumns(
      {
        meals,
        items: [
          item({
            perMeal: [
              contribution({
                mealId: "MEL-1",
                recipeId: "RCP-1",
                scale: 1,
                lineIndex: 7,
              }),
              contribution({
                mealId: "MEL-1",
                recipeId: "RCP-1",
                scale: 2,
                lineIndex: 8,
              }),
            ],
          }),
        ],
      },
      NONE,
    );

    expect(columns).toHaveLength(2);
    expect(columns.map((c) => c.scale).sort()).toEqual([1, 2]);
  });

  it("omits excluded meals from the column axis", () => {
    const { columns, groups } = buildShoppingColumns(
      {
        meals,
        items: [
          item({
            perMeal: [
              contribution({ mealId: "MEL-1", lineIndex: 0 }),
              contribution({ mealId: "MEL-2", lineIndex: 1 }),
            ],
          }),
        ],
      },
      new Set([testShortcode("meal", "MEL-2")]),
    );

    expect(columns.map((c) => c.mealId)).toEqual([
      testShortcode("meal", "MEL-1"),
    ]);
    expect(groups).toHaveLength(1);
  });

  it("groups a meal's consecutive columns and tiles them exactly", () => {
    const { columns, groups } = buildShoppingColumns(
      {
        meals,
        items: [
          item({
            perMeal: [
              contribution({ mealId: "MEL-1", recipeName: "A", lineIndex: 0 }),
              contribution({ mealId: "MEL-1", recipeName: "B", lineIndex: 1 }),
              contribution({ mealId: "MEL-2", recipeName: "C", lineIndex: 2 }),
            ],
          }),
        ],
      },
      NONE,
    );

    expect(groups.map((g) => g.mealId)).toEqual([
      testShortcode("meal", "MEL-2"),
      testShortcode("meal", "MEL-1"),
    ]);
    expect(groups.reduce((n, g) => n + g.columnKeys.length, 0)).toBe(
      columns.length,
    );
  });

  it("dedupes a line mentioned by several ingredients", () => {
    const { columns } = buildShoppingColumns(
      {
        meals,
        items: [
          item({
            ingredientId: "ING-A",
            perMeal: [contribution({ lineIndex: 3 })],
          }),
          item({
            ingredientId: "ING-B",
            perMeal: [contribution({ lineIndex: 3 })],
          }),
        ],
      },
      NONE,
    );

    expect(columns).toHaveLength(1);
  });
});

describe("toggleInSet", () => {
  it("adds and removes without mutating the input", () => {
    const original: ReadonlySet<string> = new Set(["a"]);
    expect([...toggleInSet(original, "b")].sort()).toEqual(["a", "b"]);
    expect([...toggleInSet(original, "a")]).toEqual([]);
    expect([...original]).toEqual(["a"]);
  });
});

describe("shoppingRowsToText", () => {
  const rangeLabel = { from: "2026-03-01", to: "2026-03-07" };

  it("keeps checked rows and marks them", () => {
    const rows = buildShoppingRows(
      [item({ name: "flour", haveValue: 0, perMeal: [contribution()] })],
      new Set([testShortcode("ingredient", "ING-1")]),
    );

    const text = shoppingRowsToText(rows, rangeLabel);
    expect(text).toContain("2026-03-01 to 2026-03-07");
    expect(text).toContain("[x] flour");
  });

  it("copies staples and warnings without purchase checkboxes", () => {
    const rows = buildShoppingRows(
      [
        item({
          name: "salt",
          membership: "usuallyOnHand",
          usuallyOnHand: true,
          quantityIssues: ["missingAmount"],
          needValue: null,
        }),
      ],
      NONE,
    );
    const text = shoppingRowsToText(rows, rangeLabel, ["Dough: missingYield"]);
    expect(text).toContain("Usually on hand");
    expect(text).toContain("salt");
    expect(text).toContain("Quantity unresolved");
    expect(text).toContain("Dough: missingYield");
    expect(text).not.toContain("[ ] salt");
  });
});

describe("check-off storage key", () => {
  it("does not vary with the date range", () => {
    // The regression this pins: the key used to interpolate from/to, so
    // nudging either end mid-shop swapped in an empty bucket and lost every
    // tick. Row keys never depended on the range, only the storage key did.
    expect(SHOPPING_CHECKED_STORAGE_KEY).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
