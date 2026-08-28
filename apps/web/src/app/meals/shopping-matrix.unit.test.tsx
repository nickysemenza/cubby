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
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { EMPTY_MARK } from "~/components/matrix/matrix-chrome";

import { ShoppingMatrix } from "./shopping-matrix";
import { buildShoppingColumns, buildShoppingRows } from "./shopping-model";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#x">{children}</a>,
}));

const contribution = (
  over: Record<string, unknown> = {},
): ShoppingListContribution =>
  shoppingListContribution.parse({
    mealId: testShortcode("meal", "MEL-ABCD"),
    mealName: "Dinner",
    date: "2026-06-15",
    recipeId: testShortcode("recipe", "RCP-ABCD"),
    recipeName: "Pancakes",
    scale: 1,
    needValue: 100,
    lineIndex: 0,
    via: [],
    ...over,
  });

const item = (over: Record<string, unknown> = {}): ShoppingListItem =>
  shoppingListItem.parse({
    ingredientId: testShortcode("ingredient", "ING-ABCD"),
    name: "flour",
    basisUnit: "g",
    needValue: 100,
    haveValue: 500,
    shortfall: 0,
    estimatedCost: null,
    status: "ok",
    perMeal: [contribution()],
    ...over,
  });

const NONE: ReadonlySet<string> = new Set();

const meals = [
  { id: testShortcode("meal", "MEL-ABCD"), name: "Lunch", date: "2026-06-15" },
  { id: testShortcode("meal", "MEL-EFGH"), name: "Dinner", date: "2026-06-16" },
] satisfies Parameters<typeof buildShoppingColumns>[0]["meals"];

function renderMatrix(
  items: ShoppingListItem[],
  unexpanded: UnexpandedSubRecipe[] = [],
  excluded: ReadonlySet<string> = NONE,
) {
  const data = { meals, items };
  const { columns, groups } = buildShoppingColumns(data, excluded);
  return render(
    <ShoppingMatrix
      rows={buildShoppingRows(items, excluded, NONE)}
      columns={columns}
      groups={groups}
      unexpanded={unexpanded}
      excluded={excluded}
      onToggleCheck={vi.fn()}
    />,
  );
}

const rowCells = (name: string) =>
  within(
    screen.getByRole("rowheader", { name: new RegExp(name) })
      .parentElement as HTMLElement,
  )
    .getAllByRole("cell")
    .map((c) => c.textContent);

describe("ShoppingMatrix", () => {
  const twoLines = [
    item({
      ingredientId: "ING-FABC",
      name: "flour",
      perMeal: [
        contribution({
          lineIndex: 0,
          mealId: "MEL-ABCD",
          recipeName: "A",
          needValue: 300,
        }),
      ],
    }),
    item({
      ingredientId: "ING-SFAT",
      name: "salt",
      haveValue: 0,
      perMeal: [
        contribution({
          lineIndex: 0,
          mealId: "MEL-ABCD",
          recipeName: "A",
          needValue: 40,
        }),
        contribution({
          lineIndex: 1,
          mealId: "MEL-EFGH",
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

  it("sums a split ingredient across its lines", () => {
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
    const { container } = renderMatrix(twoLines, [], new Set(["MEL-EFGH"]));

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
            mealId: "MEL-ABCD",
            mealName: "Lunch",
            recipeName: "A",
          }),
          contribution({
            lineIndex: 1,
            mealId: "MEL-ABCD",
            mealName: "Lunch",
            recipeName: "B",
          }),
          contribution({
            lineIndex: 2,
            mealId: "MEL-EFGH",
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

    const foot = screen.getByRole("rowheader", { name: "2 ingredients" })
      .parentElement as HTMLElement;
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
        recipeId: "RCP-DUGA",
        name: "Dough",
        reason: "missingYield",
        amount: null,
        via: [],
        mealId: "MEL-ABCD",
        mealName: "Lunch",
        date: "2026-06-15",
        parentRecipeId: "RCP-ABCD",
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
            via: [{ recipeId: "RCP-DUGA", name: "Dough" }],
          }),
        ],
      }),
    ]);

    const cell = container.querySelector("tbody td") as HTMLElement;
    expect(cell.textContent).toBe("↳ 120 g");
    expect(cell.title).toBe("via Dough");
  });
});
