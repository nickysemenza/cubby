import { testShortcode } from "@cubby/schemas/testing";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { type ComparedRecipe, RecipeCompareGrid } from "./RecipeCompareGrid";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  cleanup();
  harness.dispose();
});

function renderGrid(grid: React.ReactNode) {
  return render(grid, { wrapper: harness.wrapper });
}

const comparedRecipe: ComparedRecipe = {
  recipe: {
    id: testShortcode("recipe", "RCP-TEST"),
    name: "Test recipe",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    meta: null,
    images: [],
    source: null,
    yield: null,
    servings: null,
    tags: null,
    notes: null,
    sections: [],
    totals: null,
  },
  effectiveServings: null,
  costing: null,
  estimates: null,
};

describe("RecipeCompareGrid", () => {
  it("exposes each comparison label as a row header", () => {
    renderGrid(
      <RecipeCompareGrid compared={[comparedRecipe]} onRemove={vi.fn()} />,
    );

    expect(screen.getByRole("rowheader", { name: "Yield" })).toHaveAttribute(
      "scope",
      "row",
    );
    expect(screen.getByRole("rowheader", { name: "Yield" })).toHaveClass(
      "text-left",
      "font-normal",
    );
  });

  it("labels each remove control with the recipe name", () => {
    renderGrid(
      <RecipeCompareGrid compared={[comparedRecipe]} onRemove={vi.fn()} />,
    );

    expect(
      screen.getByRole("button", {
        name: "Remove Test recipe from comparison",
      }),
    ).toHaveClass("size-11", "sm:size-5");
  });
});
