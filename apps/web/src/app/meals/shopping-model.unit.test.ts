import type {
  ShoppingListContribution,
  ShoppingListItem,
} from "@cubby/schemas/meal";
import { describe, expect, it } from "vitest";
import {
  adjustedStatus,
  buildShoppingColumns,
  buildShoppingRows,
  SHOPPING_EPSILON,
  toggleInSet,
} from "./shopping-model";

const NONE: ReadonlySet<string> = new Set();

// Ids are branded on the real types; the fixtures take plain strings and the
// cast happens once, at the factory, rather than at every call site.
type ContributionOverrides = Partial<
  Omit<ShoppingListContribution, "mealId" | "recipeId">
> & { mealId?: string; recipeId?: string };

type ItemOverrides = Partial<
  Omit<ShoppingListItem, "ingredientId" | "perMeal">
> & { ingredientId?: string | null; perMeal?: ShoppingListContribution[] };

let nextLine = 0;
const contribution = (
  over: ContributionOverrides = {},
): ShoppingListContribution =>
  ({
    mealId: "MEL-1",
    mealName: "Dinner",
    date: "2026-06-15",
    recipeId: "RCP-1",
    recipeName: "Pancakes",
    scale: 1,
    needValue: 100,
    lineIndex: nextLine++,
    via: [],
    ...over,
  }) as ShoppingListItem["perMeal"][number];

const item = (over: ItemOverrides = {}): ShoppingListItem =>
  ({
    ingredientId: "ING-1",
    name: "flour",
    basisUnit: "g",
    needValue: 100,
    haveValue: 500,
    shortfall: 0,
    status: "ok",
    perMeal: [contribution()],
    ...over,
  }) as ShoppingListItem;

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
      new Set(["MEL-2"]),
      NONE,
    )[0];

    expect(row?.need).toBe(100);
  });

  it("never re-sums `have` when a meal is excluded", () => {
    // The load-bearing invariant: on-hand is the ingredient's global stock,
    // counted once by the server. Deriving it per contribution is exactly the
    // double-count the aggregation exists to prevent.
    const [all, some] = [NONE, new Set(["MEL-2"])].map(
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

  it("drops rows whose visible need rounds away", () => {
    const rows = buildShoppingRows(
      [
        item({
          perMeal: [contribution({ needValue: SHOPPING_EPSILON / 2 })],
        }),
      ],
      NONE,
      NONE,
    );

    expect(rows).toHaveLength(0);
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
      new Set(["ING-B"]),
    );

    expect(rows.map((r) => r.key)).toEqual(["ING-C", "ING-A", "ING-B"]);
  });
});

describe("adjustedStatus", () => {
  it("keeps the server's verdict when haveValue is null", () => {
    // null is either "no inventory" or "units don't reconcile" — collapsing
    // both to one status would lose the distinction the server drew.
    expect(
      adjustedStatus(item({ haveValue: null, status: "missing" }), 5),
    ).toBe("missing");
    expect(
      adjustedStatus(item({ haveValue: null, status: "unconvertible" }), 5),
    ).toBe("unconvertible");
  });

  it("re-derives ok / short / missing from the adjusted need", () => {
    const stocked = item({ haveValue: 100 });
    expect(adjustedStatus(stocked, 100)).toBe("ok");
    expect(adjustedStatus(stocked, 150)).toBe("short");
    expect(adjustedStatus(item({ haveValue: 0 }), 150)).toBe("missing");
  });
});

describe("buildShoppingColumns", () => {
  const meals = [
    { id: "MEL-2", name: "Dinner", date: "2026-06-16" },
    { id: "MEL-1", name: "Lunch", date: "2026-06-15" },
  ] as Parameters<typeof buildShoppingColumns>[0]["meals"];

  it("orders columns by the server's meal order, not by mention order", () => {
    const { columns } = buildShoppingColumns(
      {
        meals,
        items: [
          item({
            // MEL-1 is mentioned first, but MEL-2 comes first in `meals`.
            perMeal: [
              contribution({ mealId: "MEL-1", lineIndex: 0 }),
              contribution({ mealId: "MEL-2", lineIndex: 1 }),
            ],
          }),
        ],
      },
      NONE,
    );

    expect(columns.map((c) => c.mealId)).toEqual(["MEL-2", "MEL-1"]);
  });

  it("keeps a meal that plans the same recipe twice as two columns", () => {
    // The whole reason `lineIndex` exists: keying on meal+recipe would
    // silently merge two half-batches into one indistinguishable column.
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
      new Set(["MEL-2"]),
    );

    expect(columns.map((c) => c.mealId)).toEqual(["MEL-1"]);
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

    expect(groups.map((g) => g.mealId)).toEqual(["MEL-2", "MEL-1"]);
    // A colSpan built from these has to cover every rendered column.
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
