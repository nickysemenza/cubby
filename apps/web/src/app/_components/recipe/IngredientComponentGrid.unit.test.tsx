import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_MARK } from "~/components/matrix/matrix-chrome";
import { IngredientComponentGrid } from "./IngredientComponentGrid";
import type { RecipeTreeNode } from "./recipe-tree";

// The tree math is covered by recipe-tree's own tests; mocking at that seam
// keeps this about the grid's rendering contract — the Total column, the
// Subtotal/Cost footer rows, the empty mark, and the estimate marker — which
// is what the CrossTabTable migration could plausibly break.
const component = (id: string, name: string) =>
  ({ recipe: { id, name, yield: null }, costing: null }) as RecipeTreeNode;

vi.mock("./recipe-tree", () => ({
  flattenComponents: () => [
    component("RCP-DOUGH", "Dough"),
    component("RCP-ROOT", "Assembly"),
  ],
  buildIngredientMatrix: () => [
    {
      ingredientId: "ing-flour",
      ingredientShortcode: "ING-FLOUR",
      name: "flour",
      byComponent: new Map([["RCP-DOUGH", 500]]),
      total: 500,
      estimated: false,
    },
    {
      ingredientId: "ing-salt",
      ingredientShortcode: "ING-SALT",
      name: "salt",
      byComponent: new Map([
        ["RCP-DOUGH", 10],
        ["RCP-ROOT", 2],
      ]),
      total: 12,
      estimated: true,
    },
  ],
  fullBatchCostByComponent: () => ({
    byComponent: new Map([["RCP-DOUGH", { price: 1.5, priceUpper: 2.25 }]]),
    total: 1.5,
    totalUpper: 2.25,
  }),
  recipeTreeDisplayImage: () => null,
}));

vi.mock("../EntityPreviewLink", () => ({
  dottedEntityLink: "",
  EntityPreviewLink: ({ children }: { children: ReactNode }) => (
    <span>{children}</span>
  ),
}));

vi.mock("./recipe-utils", () => ({
  gramText: (grams: number) => `${grams} g`,
  formatMakes: () => null,
}));

const tree = {} as RecipeTreeNode;

const rowCells = (name: string) =>
  within(screen.getByRole("rowheader", { name }).parentElement as HTMLElement)
    .getAllByRole("cell")
    .map((c) => c.textContent);

describe("IngredientComponentGrid", () => {
  it("renders a column per component and a row per ingredient", () => {
    render(<IngredientComponentGrid tree={tree} />);

    expect(screen.getByRole("columnheader", { name: "Dough" })).toBeVisible();
    expect(screen.getByRole("rowheader", { name: "flour" })).toBeVisible();
    expect(screen.getByRole("rowheader", { name: "salt" })).toBeVisible();
  });

  it("marks a component that doesn't use an ingredient, and totals the row", () => {
    render(<IngredientComponentGrid tree={tree} />);

    // flour is only in the dough — the assembly column must read as absent,
    // never as a zero, and the Total column closes the row.
    expect(rowCells("flour")).toEqual(["500 g", EMPTY_MARK, "500 g"]);
    expect(rowCells("salt")).toEqual(["10 g", "2 g", "12 g ~"]);
  });

  it("renders the Subtotal footer and omits Cost unless asked", () => {
    render(<IngredientComponentGrid tree={tree} />);

    expect(screen.getByRole("rowheader", { name: "Subtotal" })).toBeVisible();
    expect(screen.queryByRole("rowheader", { name: "Cost" })).toBeNull();
    expect(rowCells("Subtotal")).toEqual(["510 g", "2 g", "512 g"]);
  });

  it("adds the Cost footer row when showCost is set", () => {
    render(<IngredientComponentGrid tree={tree} showCost />);

    // The engine tracks an upper bound for ranged amounts; the grid used to
    // drop it and show a point cost where every other surface showed a range.
    expect(rowCells("Cost")).toEqual([
      "$1.50 – $2.25",
      EMPTY_MARK,
      "$1.50 – $2.25",
    ]);
  });
});
