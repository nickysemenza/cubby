import {
  type RecipeOut,
  recipeOut,
  type SectionIngredientOut,
  sectionIngredientOut,
} from "@cubby/schemas/recipe";
import { testEntityId, testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen } from "@testing-library/react";
import { ok } from "neverthrow";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { RecipeCosting } from "~/lib/recipe-costing";
import { RecipeSpecView } from "./RecipeSpecView";
import type { RecipeTreeNode } from "./recipe-tree";

vi.mock("../EntityPreviewLink", () => ({
  dottedEntityLink: "",
  EntityPreviewLink: ({ children }: { children: ReactNode }) => (
    <span>{children}</span>
  ),
}));

vi.mock("~/app/_components/inventory/format-amount", () => ({
  tryFormatAmount: () => "$1",
}));

vi.mock("./IngredientQuantities", () => ({
  buildDisplayQuantities: () => [],
  gramMapFromCosting: () => new Map(),
  IngredientModifier: () => null,
  IngredientQuantities: () => <span>1 cup</span>,
}));

vi.mock("./recipe-utils", () => ({
  entityRefForRow: () => null,
  formatYield: ({ value, unit }: { value: number; unit: string }) =>
    `${value} ${unit}`,
  getIngredientName: (row: SectionIngredientOut) =>
    row.ingredient?.name ?? row.recipe?.name ?? "Unknown",
}));

const ingredient = (id: string, name: string): SectionIngredientOut =>
  sectionIngredientOut.parse({
    id: testEntityId("recipe", `usage-${id}`),
    type: "ingredient",
    amounts: [],
    modifier: null,
    rawLine: null,
    recipe: null,
    ingredient: {
      id: testShortcode("ingredient", `ING-${id}`),
      name,
      aliases: [],
      naKinds: [],
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  });

const rowKey = (id: string) => testEntityId("recipe", `usage-${id}`);

const recipe = (id: string, name: string): RecipeOut =>
  recipeOut.parse({
    id: testShortcode("recipe", `RCP-${id}`),
    name,
    meta: null,
    yield: null,
    servings: null,
    notes: null,
    source: null,
    images: [],
    sections: [],
    tags: [],
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  });

const costing = (): RecipeCosting => ({
  rows: ["flour", "water"].map((id) => ({
    ...ingredient(id, id),
    sectionName: null,
    priceInfo: {
      price: ok({ value: 0, unit: "USD" }),
      gram: ok({ value: id === "flour" ? 100 : 50, unit: "g" }),
      nutrient: ok({}),
    },
    totalsMissing: { price: false, weight: false, nutrients: false },
  })),
  totals: {
    price: 0,
    weight: 150,
    totalIngredients: 2,
    nutrients: {},
    missingByType: { price: [], weight: ["salt"], nutrients: [] },
    diagnostics: [],
  },
  estimatedRows: new Map(),
  bakerPct: new Map(),
  isFlourRows: new Map(),
});

function tree(): RecipeTreeNode {
  const child: RecipeTreeNode = {
    recipe: recipe("child", "Starter"),
    costing: null,
    depth: 1,
    cumulativeFactor: 1,
    batchEstimated: false,
    batchEstimatedReason: null,
    batchGrams: null,
    baseRowId: null,
    sections: [
      {
        id: "child-section",
        name: null,
        steps: [],
        rows: [
          {
            kind: "stub",
            id: rowKey("missing-child"),
            recipeId: testShortcode("recipe", "missing"),
            name: "Missing preferment",
            reason: "missing",
          },
        ],
      },
    ],
  };
  return {
    recipe: recipe("root", "Bread"),
    costing: costing(),
    depth: 0,
    cumulativeFactor: 1,
    batchEstimated: false,
    batchEstimatedReason: null,
    batchGrams: null,
    baseRowId: rowKey("flour"),
    sections: [
      {
        id: "root-section",
        name: null,
        steps: [],
        rows: [
          {
            kind: "ingredient",
            id: rowKey("flour"),
            row: ingredient("flour", "Flour"),
            grams: 100,
            pct: 100,
          },
          {
            kind: "ingredient",
            id: rowKey("water"),
            row: ingredient("water", "Water"),
            grams: 50,
            pct: 50,
          },
          {
            kind: "subrecipe",
            id: rowKey("starter"),
            row: ingredient("starter", "Starter"),
            grams: 20,
            pct: 20,
            child,
          },
        ],
      },
    ],
  };
}

describe("RecipeSpecView variants", () => {
  it("keeps cost and re-anchoring interactive in detail mode", () => {
    render(<RecipeSpecView tree={tree()} />);
    expect(screen.getByText("Cost")).toBeInTheDocument();
    const waterScaling = screen.getByRole("button", { name: "50%" });
    fireEvent.click(waterScaling);
    expect(waterScaling).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/Scaling omits/)).toHaveTextContent("salt");
  });

  it("keeps export mode static while preserving scaling values", () => {
    render(<RecipeSpecView tree={tree()} variant="export" />);
    expect(screen.queryByText("Cost")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.queryByText(/Scaling omits/)).not.toBeInTheDocument();
  });

  it("shares nested panels and stub rendering across variants", () => {
    render(<RecipeSpecView tree={tree()} variant="export" />);
    expect(screen.getAllByText("Starter").length).toBeGreaterThan(0);
    expect(screen.getByText("Missing preferment")).toBeInTheDocument();
    expect(screen.getByText("missing")).toBeInTheDocument();
  });
});
