import type { RecipeSource } from "@cubby/schemas/recipe-shared";
import { flexRender } from "@tanstack/react-table";
import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { installFeatures } from "~/features/registry";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  materializeCubbyColumns,
  useCubbyTable,
} from "~/ui/data-table/table-features";

import { detailFieldRenderersFor } from "./detail-field-renderers";
import { createEntityDisplayColumns } from "./entity-display";

installFeatures();

/**
 * The recipe list (`routes/_authenticated/recipes.index.tsx`) is the one page
 * this file guards: every column it declares an override for, and the one
 * generic column the declaration alone produces, must keep exactly the shape
 * asserted here. See `docs/entities.md`'s "declaration wins" rule and the
 * `01-recipe.entity.ts` field roster.
 */

/** Row shape covering every recipe field the list surfaces, mirroring
 * `RecipeListItem` only where `createEntityDisplayColumns` reads it. */
interface RecipeRow {
  tags: string[] | null;
  servings: number | null;
  totals: null;
  updatedAt: Date;
  meta: { times: { totalMinutes: number } } | null;
  totalMinutesLabel: string | null;
  source: RecipeSource | null;
  meals: number;
  notes: string | null;
}

const RECIPE_ROW: RecipeRow = {
  tags: ["dinner", "weeknight"],
  servings: 4,
  totals: null,
  updatedAt: new Date(),
  meta: { times: { totalMinutes: 35 } },
  totalMinutesLabel: "35 min",
  source: { type: "website", url: "https://www.example.com/recipe" },
  meals: 2,
  notes: "Fixture notes",
};

/**
 * Builds the recipe list's columns the same way `recipelist.tsx` does:
 * overrides for the specialized columns that keep a page-local cell
 * (`servings`, `tags`, `meals`); `costTotal`, `caloriesTotal`, `totalMinutes`
 * and `source` come from the declaration's named list renderers, and `notes`
 * stays generic to exercise the declaration's own metadata.
 */
function buildRecipeColumns() {
  const helper = createCubbyColumnHelper<RecipeRow>();
  return createEntityDisplayColumns(
    "recipe",
    helper,
    createCubbyColumnCollection<RecipeRow>((add) => {
      add(
        helper.accessor("tags", {
          id: "tags",
          cell: ({ row }) => (
            <span>{row.original.tags?.join(", ") ?? "No tags"}</span>
          ),
        }),
      );
      add(
        helper.accessor("servings", {
          id: "servings",
          cell: ({ row }) => <span>{row.original.servings} servings</span>,
        }),
      );
      add(
        helper.display({
          id: "meals",
          cell: ({ row }) => <span>{row.original.meals} meals</span>,
        }),
      );
    }),
  );
}

function buildRecipeColumnMeta() {
  return buildRecipeColumns().visit((column) => ({
    id: String(
      column.id ?? ("accessorKey" in column ? column.accessorKey : ""),
    ),
    header: z.string().parse(column.header),
    className: column.meta?.className,
    mobile: column.meta?.mobile,
    explanation: column.meta?.explanation,
    enableSorting: column.enableSorting,
  }));
}

/** Exercise renderers with the real table context, including shared metric scales. */
function renderRecipeCell(columnId: string, row: RecipeRow) {
  const columns = materializeCubbyColumns(buildRecipeColumns());
  const { result } = renderHook(() =>
    useCubbyTable({
      data: [row],
      columns,
      getRowId: () => "fixture",
    }),
  );
  const cell = result.current
    .getRow("fixture")
    .getAllCells()
    .find((candidate) => candidate.column.id === columnId);
  if (!cell) throw new Error(`Expected column ${columnId}.`);
  return flexRender(cell.column.columnDef.cell, cell.getContext());
}

describe("recipe list display columns", () => {
  it("preserves explanation metadata on the manifest-rendered source column", () => {
    const byId = Object.fromEntries(
      buildRecipeColumnMeta().map((column) => [column.id, column]),
    );
    expect(byId.source?.explanation).toEqual({
      entity: "recipe",
      field: "source",
      label: "Source",
    });
  });

  it("renders totalMinutes as the server-composed label", () => {
    render(<>{renderRecipeCell("totalMinutes", RECIPE_ROW)}</>);
    expect(screen.getByText("35 min")).toBeVisible();
  });

  it("renders a pending costTotal through the declared estimate-cost renderer", () => {
    render(<>{renderRecipeCell("costTotal", RECIPE_ROW)}</>);
    expect(screen.getByText("Pending")).toBeVisible();
  });

  it("rejects a legacy costTotal override beside the manifest renderer", () => {
    const helper = createCubbyColumnHelper<RecipeRow>();
    expect(() =>
      createEntityDisplayColumns(
        "recipe",
        helper,
        createCubbyColumnCollection((add) => {
          add(helper.display({ id: "costTotal", cell: () => null }));
        }),
        { only: ["costTotal"] },
      ),
    ).toThrow("Manifest and legacy list renderers both claim recipe.costTotal");
  });

  it("renders Recipe Source through the manifest and stops row activation", () => {
    const onRowClick = vi.fn();
    render(
      <button type="button" onClick={onRowClick}>
        {renderRecipeCell("source", RECIPE_ROW)}
      </button>,
    );
    const link = screen.getByRole("link", { name: /example\.com/i });
    expect(link).toHaveAttribute("href", "https://www.example.com/recipe");
    fireEvent.click(link);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("resolves the fuller detail Recipe Source renderer from the manifest", () => {
    const renderer = detailFieldRenderersFor("recipe")?.source;
    if (!renderer) throw new Error("Expected recipe.source detail renderer");
    const rendered = renderer(RECIPE_ROW as never);
    render(<>{rendered.value}</>);
    expect(screen.getByRole("link", { name: /example\.com/i })).toHaveAttribute(
      "href",
      "https://www.example.com/recipe",
    );
  });
});
