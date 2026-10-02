import type { RecipeSource } from "@cubby/schemas/recipe-shared";
import type { CellData } from "@tanstack/react-table";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnDef,
} from "~/ui/data-table/table-features";

import { detailFieldRenderersFor } from "./detail-field-renderers";
import { createEntityDisplayColumns } from "./entity-display";

/**
 * The recipe list ("apps/web/src/app/recipes/recipelist.tsx") is the one page
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
  source: { type: "website", url: "https://www.example.com/recipe" },
  meals: 2,
  notes: "Fixture notes",
};

/**
 * Narrows a column's `cell` to a callable renderer taking only `{ row }` —
 * every plain-scalar column `createEntityDisplayColumns` builds itself, and
 * the same shape every override here uses. Copied from the shared
 * `entity-display.unit.test.tsx` fixture rather than imported: it captures
 * `TValue` per call site (see `materializeCubbyColumns`'s doc in
 * table-features.ts), so it can't be hoisted to a shared helper module either.
 */
function isRowRenderer<TRecord extends object, TValue extends CellData>(
  cell: CubbyColumnDef<TRecord, TValue>["cell"],
): cell is (context: { row: { original: TRecord } }) => ReactNode {
  return typeof cell === "function";
}

function renderRowCell<TRecord extends object, TValue extends CellData>(
  cell: CubbyColumnDef<TRecord, TValue>["cell"],
  record: TRecord,
): ReactNode {
  if (!isRowRenderer<TRecord, TValue>(cell)) {
    throw new Error("Expected a row cell renderer.");
  }
  return cell({ row: { original: record } });
}

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

/** Renders one column's cell against a fixture row — filtered to a single
 * column and invoked inside the same `.visit()` callback, so its `cell` is
 * used exactly where its `TValue` is still concrete (see
 * `materializeCubbyColumns`'s doc in table-features.ts). */
function renderRecipeCell(columnId: string, row: RecipeRow) {
  const columns = buildRecipeColumns();
  const matched = columns.filter((column) => column.id === columnId);
  const rendered = matched.visit((column) => renderRowCell(column.cell, row));
  const [first] = rendered;
  if (rendered.length !== 1 || first === undefined) {
    throw new Error(`Expected exactly one column with id ${columnId}.`);
  }
  return first;
}

describe("recipe list display columns", () => {
  it("builds exactly the declared columns, in listOrder", () => {
    const ids = buildRecipeColumnMeta().map((d) => d.id);
    expect(ids).toEqual([
      "dataQuality",
      "servings",
      "tags",
      "notes",
      "costTotal",
      "caloriesTotal",
      "meals",
      "source",
      "totalMinutes",
      "dataGaps",
    ]);
  });

  it("takes every header from the declared label, including on overrides", () => {
    const byId = Object.fromEntries(
      buildRecipeColumnMeta().map((d) => [d.id, d.header]),
    );
    expect(byId).toEqual({
      tags: "Tags",
      servings: "Servings",
      costTotal: "Cost total",
      caloriesTotal: "Calories total",
      totalMinutes: "Total minutes",
      source: "Source",
      meals: "Meals",
      notes: "Notes",
      dataQuality: "Quality",
      dataGaps: "Data gaps",
    });
  });

  it("derives enableSorting from the generated sort roster per column id", () => {
    const byId = Object.fromEntries(
      buildRecipeColumnMeta().map((d) => [d.id, d.enableSorting]),
    );
    // In `generatedEntitySort.recipe.fields`.
    expect(byId.tags).toBe(true);
    expect(byId.servings).toBe(true);
    expect(byId.costTotal).toBe(true);
    expect(byId.caloriesTotal).toBe(true);
    expect(byId.totalMinutes).toBe(true);
    expect(byId.source).toBe(true);
    // Not in the roster.
    expect(byId.meals).toBe(false);
    expect(byId.notes).toBe(false);
  });

  it("carries no declared width/mobile metadata for the one generic column (notes)", () => {
    const byId = Object.fromEntries(
      buildRecipeColumnMeta().map((d) => [d.id, d]),
    );
    expect(byId.notes?.className).toBeUndefined();
    expect(byId.notes?.mobile).toBeUndefined();
  });

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

  it("renders totalMinutes through the declared total-time renderer", () => {
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
    // SAFETY: the generated registry resolved this renderer from the recipe
    // manifest, and the fixture is a recipe detail record.
    const rendered = renderer(RECIPE_ROW as never);
    render(<>{rendered.value}</>);
    expect(screen.getByRole("link", { name: /example\.com/i })).toHaveAttribute(
      "href",
      "https://www.example.com/recipe",
    );
  });

  it("rejects a legacy source override beside the manifest renderer", () => {
    const helper = createCubbyColumnHelper<RecipeRow>();
    expect(() =>
      createEntityDisplayColumns(
        "recipe",
        helper,
        createCubbyColumnCollection((add) => {
          add(helper.display({ id: "source", cell: () => null }));
        }),
        { only: ["source"] },
      ),
    ).toThrow("Manifest and legacy list renderers both claim recipe.source");
  });

  it("rejects an override for a field the declaration doesn't list (totals is list: false)", () => {
    const helper = createCubbyColumnHelper<RecipeRow & { totals: unknown }>();
    expect(() =>
      createEntityDisplayColumns(
        "recipe",
        helper,
        createCubbyColumnCollection((add) => {
          add(helper.display({ id: "tags", cell: () => null }));
          add(helper.display({ id: "servings", cell: () => null }));
          add(helper.display({ id: "meals", cell: () => null }));
          add(helper.display({ id: "totals", cell: () => null }));
        }),
      ),
    ).toThrow("Undeclared display renderer for recipe.totals");
  });
});
