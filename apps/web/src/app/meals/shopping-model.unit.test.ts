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
  it("sums need from the visible contributions only", () => {
    const row = buildShoppingRows(
      [
        item({
          perMeal: [
            contribution({ mealId: "MEL-1", needValue: 100 }),
            contribution({ mealId: "MEL-2", needValue: 60 }),
          ],
        }),
      ],
      new Set([testShortcode("meal", "MEL-2")]),
      NONE,
    )[0];

    expect(row?.need).toBe(100);
  });

  it("never re-sums `have` when a meal is excluded", () => {
    // The load-bearing invariant: on-hand is the ingredient's global stock,
    // counted once by the server. Deriving it per contribution is exactly the
    // double-count the aggregation exists to prevent.
    const [all, some] = [NONE, new Set([testShortcode("meal", "MEL-2")])].map(
      (excluded) =>
        buildShoppingRows(
          [
            item({
              haveValue: 500,
              perMeal: [
                contribution({ mealId: "MEL-1", needValue: 100 }),
                contribution({ mealId: "MEL-2", needValue: 60 }),
              ],
            }),
          ],
          excluded,
          NONE,
        )[0],
    );

    expect(all?.item.haveValue).toBe(500);
    expect(some?.item.haveValue).toBe(500);
  });

  it("drops a row nothing visible needs", () => {
    const rows = buildShoppingRows(
      [item({ perMeal: [contribution({ needValue: 0 })] })],
      NONE,
      NONE,
    );

    expect(rows).toHaveLength(0);
  });

  it("reports an unconvertible row's shortfall as unknown", () => {
    const row = buildShoppingRows(
      [item({ haveValue: null, status: "unconvertible" })],
      NONE,
      NONE,
    )[0];

    expect(row?.shortfall).toBeNull();
    expect(row?.status).toBe("unconvertible");
  });

  it("still reports the full need for something you simply don't have", () => {
    const row = buildShoppingRows(
      [
        item({
          haveValue: null,
          status: "missing",
          perMeal: [contribution({ needValue: 250 })],
        }),
      ],
      NONE,
      NONE,
    )[0];

    expect(row?.shortfall).toBe(250);
  });

  it("sorts checked last, then most-short-first, then by name", () => {
    const rows = buildShoppingRows(
      [
        item({
          ingredientId: "ING-A",
          name: "apples",
          haveValue: 0,
          perMeal: [contribution({ needValue: 10 })],
        }),
        item({
          ingredientId: "ING-B",
          name: "butter",
          haveValue: 0,
          perMeal: [contribution({ needValue: 90 })],
        }),
        item({
          ingredientId: "ING-C",
          name: "cocoa",
          haveValue: 0,
          perMeal: [contribution({ needValue: 50 })],
        }),
      ],
      NONE,
      new Set([testShortcode("ingredient", "ING-B")]),
    );

    expect(rows.map((r) => r.key)).toEqual([
      testShortcode("ingredient", "ING-C"),
      testShortcode("ingredient", "ING-A"),
      testShortcode("ingredient", "ING-B"),
    ]);
  });
});

describe("status after exclusion", () => {
  const statusFor = (over: ItemOverrides, needValue: number) =>
    buildShoppingRows(
      [item({ ...over, perMeal: [contribution({ needValue })] })],
      NONE,
      NONE,
    )[0]?.status;

  it("keeps the server's verdict when haveValue is null", () => {
    expect(statusFor({ haveValue: null, status: "missing" }, 5)).toBe(
      "missing",
    );
    expect(statusFor({ haveValue: null, status: "unconvertible" }, 5)).toBe(
      "unconvertible",
    );
  });

  it("re-derives ok / short / missing from the adjusted need", () => {
    expect(statusFor({ haveValue: 100 }, 100)).toBe("ok");
    expect(statusFor({ haveValue: 100 }, 150)).toBe("short");
    expect(statusFor({ haveValue: 0 }, 150)).toBe("missing");
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
      NONE,
      new Set([testShortcode("ingredient", "ING-1")]),
    );

    const text = shoppingRowsToText(rows, rangeLabel);
    expect(text).toContain("2026-03-01 to 2026-03-07");
    expect(text).toContain("[x] flour");
  });

  it("says 'have enough' rather than printing a quantity to buy", () => {
    const rows = buildShoppingRows(
      [item({ name: "flour", haveValue: 9999, perMeal: [contribution()] })],
      NONE,
      NONE,
    );

    expect(shoppingRowsToText(rows, rangeLabel)).toContain("have enough");
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
