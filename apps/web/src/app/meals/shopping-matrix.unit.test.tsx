import {
  type ShoppingListContribution,
  type ShoppingListItem,
  shoppingListContribution,
  shoppingListItem,
  type UnexpandedSubRecipe,
  unexpandedSubRecipeOut,
} from "@cubby/schemas/meal";
import { testShortcode } from "@cubby/schemas/testing";
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EMPTY_MARK } from "~/components/matrix/matrix-chrome";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { ShoppingMatrix } from "./shopping-matrix";
import { buildShoppingColumns, buildShoppingRows } from "./shopping-model";

const contribution = (
  overrides: Partial<ShoppingListContribution> = {},
): ShoppingListContribution =>
  shoppingListContribution.parse({
    mealId: testShortcode("meal", "MEL-ABCD"),
    mealName: "Dinner",
    date: "2026-06-15",
    recipeId: testShortcode("recipe", "RCP-ABCD"),
    recipeName: "Pancakes",
    scale: 1,
    needValue: 100,
    amount: { value: 100, unit: "g" },
    lineIndex: 0,
    via: [],
    ...overrides,
  });

const item = (overrides: Partial<ShoppingListItem> = {}): ShoppingListItem =>
  shoppingListItem.parse({
    ingredientId: testShortcode("ingredient", "ING-ABCD"),
    name: "flour",
    basisUnit: "g",
    needValue: 100,
    haveValue: 500,
    shortfall: 0,
    estimatedCost: null,
    usuallyOnHand: false,
    covered: true,
    availabilitySource: "inventory",
    quantityIssues: [],
    membership: "buy",
    status: "ok",
    perMeal: [contribution()],
    ...overrides,
  });

const NONE: ReadonlySet<string> = new Set();
const lunchMealId = testShortcode("meal", "MEL-ABCD");
const dinnerMealId = testShortcode("meal", "MEL-EFGH");
const flourIngredientId = testShortcode("ingredient", "ING-FABC");
const saltIngredientId = testShortcode("ingredient", "ING-SFAT");
const doughRecipeId = testShortcode("recipe", "RCP-DUGA");

const meals = [
  { id: testShortcode("meal", "MEL-ABCD"), name: "Lunch", date: "2026-06-15" },
  { id: dinnerMealId, name: "Dinner", date: "2026-06-16" },
] satisfies Parameters<typeof buildShoppingColumns>[0]["meals"];

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

function renderMatrix(
  items: ShoppingListItem[],
  unexpanded: UnexpandedSubRecipe[] = [],
  excluded: ReadonlySet<string> = NONE,
) {
  const data = { meals, items };
  const { columns, groups } = buildShoppingColumns(data, excluded);
  return render(
    <ShoppingMatrix
      rows={buildShoppingRows(items, NONE)}
      columns={columns}
      groups={groups}
      unexpanded={unexpanded}
      excluded={excluded}
      onToggleCheck={() => undefined}
    />,
    { wrapper: harness.wrapper },
  );
}

function rowCells(name: string) {
  const row = screen.getByRole("rowheader", {
    name: new RegExp(name),
  }).parentElement;
  if (!row) throw new Error(`Missing table row for ${name}`);
  return within(row)
    .getAllByRole("cell")
    .map((cell) => cell.textContent);
}

describe("ShoppingMatrix", () => {
  const twoLines = [
    item({
      ingredientId: flourIngredientId,
      name: "flour",
      needValue: 300,
      perMeal: [
        contribution({
          lineIndex: 0,
          mealId: lunchMealId,
          recipeName: "A",
          needValue: 300,
        }),
      ],
    }),
    item({
      ingredientId: saltIngredientId,
      name: "salt",
      needValue: 46,
      shortfall: 46,
      status: "missing",
      covered: false,
      availabilitySource: null,
      haveValue: 0,
      perMeal: [
        contribution({
          lineIndex: 0,
          mealId: lunchMealId,
          recipeName: "A",
          needValue: 40,
        }),
        contribution({
          lineIndex: 1,
          mealId: dinnerMealId,
          recipeName: "B",
          needValue: 6,
        }),
      ],
    }),
  ];

  it("renders one row header per ingredient, scoped to its row", () => {
    renderMatrix(twoLines);

    expect(screen.getByRole("rowheader", { name: /flour/ })).toHaveAttribute(
      "scope",
      "row",
    );
    expect(screen.getByRole("rowheader", { name: /salt/ })).toBeVisible();
  });

  it("marks a line that doesn't need an ingredient, never as a zero", () => {
    renderMatrix(twoLines);

    expect(rowCells("flour")).toEqual([
      "300 g",
      EMPTY_MARK,
      "300 g",
      "500 g",
      "✓",
    ]);
  });

  it("shows the server total alongside each split contribution", () => {
    renderMatrix(twoLines);

    const cells = rowCells("salt");
    expect(cells.slice(0, 2)).toEqual(["40 g", "6 g"]);
    expect(cells[2]).toBe("46 g");
  });

  it("shades only rows split across more than one line", () => {
    const { container } = renderMatrix(twoLines);

    const shaded = [...container.querySelectorAll("tbody td")].filter((td) =>
      /chart-seq/.test(td.className),
    );
    expect(shaded).toHaveLength(2);
    expect(shaded.map((td) => td.textContent)).toEqual(["40 g", "6 g"]);
  });

  it("scales shading to the visible lines when a meal is excluded", () => {
    const { container } = renderMatrix(
      twoLines.map((row) => {
        const selected = {
          ...row,
          perMeal: row.perMeal.filter((c) => c.mealId !== dinnerMealId),
        };
        if (row.name === "salt") {
          selected.needValue = 40;
          selected.shortfall = 40;
        }
        return selected;
      }),
      [],
      new Set([dinnerMealId]),
    );

    expect(
      [...container.querySelectorAll("tbody td")].filter((td) =>
        /chart-seq/.test(td.className),
      ),
    ).toHaveLength(0);
    expect(rowCells("salt")).toEqual(["40 g", "40 g", "0 g", "40 g"]);
  });

  it("spans a meal header over exactly its own lines", () => {
    renderMatrix([
      item({
        perMeal: [
          contribution({
            lineIndex: 0,
            mealId: lunchMealId,
            mealName: "Lunch",
            recipeName: "A",
          }),
          contribution({
            lineIndex: 1,
            mealId: lunchMealId,
            mealName: "Lunch",
            recipeName: "B",
          }),
          contribution({
            lineIndex: 2,
            mealId: dinnerMealId,
            mealName: "Dinner",
            recipeName: "C",
          }),
        ],
      }),
    ]);

    expect(screen.getByRole("columnheader", { name: /Lunch/ })).toHaveAttribute(
      "colspan",
      "2",
    );
    expect(
      screen.getByRole("columnheader", { name: /Dinner/ }),
    ).toHaveAttribute("colspan", "1");
  });

  it("renders an em dash rather than 0 when nothing is on hand", () => {
    renderMatrix([item({ haveValue: null, status: "missing" })]);

    expect(rowCells("flour")).toContain("—");
  });

  it("counts ingredients in the footer instead of summing amounts", () => {
    renderMatrix(twoLines);

    const foot = screen.getByRole("rowheader", {
      name: "2 ingredients",
    }).parentElement;
    if (!foot) throw new Error("Missing shopping matrix footer");
    const cells = within(foot)
      .getAllByRole("cell")
      .map((c) => c.textContent);

    // Per column: how many ingredients that line touches. Never a gram total —
    // adding flour + salt grams down a column is dimensionally meaningless.
    expect(cells.slice(0, 2)).toEqual(["2", "1"]);
    expect(cells).toContain("1 short");
  });

  it("marks a column whose sub-recipe couldn't be expanded", () => {
    renderMatrix(twoLines, [
      unexpandedSubRecipeOut.parse({
        recipeId: doughRecipeId,
        name: "Dough",
        reason: "missingYield",
        amount: null,
        via: [],
        mealId: lunchMealId,
        mealName: "Lunch",
        date: "2026-06-15",
        parentRecipeId: testShortcode("recipe", "RCP-ABCD"),
        parentRecipeName: "A",
        lineIndex: 0,
      }),
    ]);

    expect(screen.getByLabelText("Incomplete: Dough")).toBeVisible();
  });

  it("marks a cell whose value came through a sub-recipe", () => {
    const { container } = renderMatrix([
      item({
        perMeal: [
          contribution({
            lineIndex: 0,
            needValue: 120,
            via: [{ recipeId: doughRecipeId, name: "Dough" }],
          }),
        ],
      }),
    ]);

    const cell = container.querySelector("tbody td");
    if (!cell) throw new Error("Missing first shopping matrix cell");
    expect(cell.textContent).toBe("↳ 120 g");
    expect(cell.getAttribute("title")).toBe("via Dough");
  });
});

describe("pantry staple matrix", () => {
  it("shows required quantities without a shopping checkbox", () => {
    renderMatrix([
      item({
        membership: "usuallyOnHand",
        usuallyOnHand: true,
        availabilitySource: "assumed",
        haveValue: 0,
        shortfall: 100,
        status: "missing",
      }),
    ]);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText("Assumed")).toBeTruthy();
    expect(screen.getAllByText("100 g").length).toBeGreaterThan(0);
  });
  it("keeps an unresolved requirement visible", () => {
    renderMatrix([
      item({
        membership: "usuallyOnHand",
        usuallyOnHand: true,
        needValue: null,
        quantityIssues: ["missingAmount"],
        perMeal: [contribution({ needValue: null, amount: null })],
      }),
    ]);
    expect(screen.getAllByText(/Quantity unresolved/).length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
