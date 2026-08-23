// @vitest-environment happy-dom

import { unsafeRecipeShortcode } from "@cubby/schemas/identifiers";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { type ComparedRecipe, RecipeCompareGrid } from "./RecipeCompareGrid";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => (
    <a href="#recipe">{children}</a>
  ),
}));

const comparedRecipe: ComparedRecipe = {
  recipe: {
    id: unsafeRecipeShortcode("RCP-TEST"),
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
  headline: null,
  effectiveServings: null,
  costing: null,
};

describe("RecipeCompareGrid", () => {
  it("exposes each comparison label as a row header", () => {
    render(
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
});
