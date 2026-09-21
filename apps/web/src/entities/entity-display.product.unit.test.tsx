import type { ProductCategory } from "@cubby/shared";
import type { CellData } from "@tanstack/react-table";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnDef,
} from "~/app/_components/data-table/table-features";

import { categorySummaryFixture } from "../../tooling/product-category-fixtures";
import { createEntityDisplayColumns } from "./entity-display";

/**
 * The product list ("apps/web/src/app/products/productlist.tsx") is the one
 * page this file guards: every column it declares an override for, and every
 * generic column the declaration alone produces, must keep exactly the shape
 * asserted here. See `docs/entities.md`'s "declaration wins" rule and the
 * `00-product.entity.ts` field roster.
 */

/** Row shape covering every product field the list surfaces, mirroring
 * `ProductListItem` only where `createEntityDisplayColumns` reads it. */
interface ProductRow {
  category: ProductCategory | null;
  manufacturer: string;
  primaryGtin: string | null;
  fdc_id: number | null;
  model: string | null;
  notes: string | null;
  stockTracked: boolean | null;
  dataQuality: { status: string; gaps: unknown[] };
  externalIds: { source: string }[];
  price: number | null;
  expenseTotal: number;
  servingAsLocations: number;
  componentCount: number;
  expectedQuantity: number;
  quantityVariance: number | null;
  purchaseDate: string | null;
  tags: string[];
  expenseCount: number;
  usdaUnavailable: boolean | null;
  onHandUnits: number | null;
}

const PRODUCT_ROW: ProductRow = {
  category: categorySummaryFixture("tools"),
  manufacturer: "Acme",
  primaryGtin: "012345678905",
  fdc_id: 173944,
  model: "X-100",
  notes: "Fixture notes",
  stockTracked: true,
  dataQuality: { status: "complete", gaps: [] },
  externalIds: [{ source: "amazon" }],
  price: 12.5,
  expenseTotal: 42,
  servingAsLocations: 1,
  componentCount: 0,
  expectedQuantity: 3,
  quantityVariance: 0,
  purchaseDate: "2026-09-01",
  tags: ["kitchen"],
  expenseCount: 2,
  usdaUnavailable: null,
  onHandUnits: 3,
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
 * Builds the product list's columns the same way `productlist.tsx` does:
 * overrides for every field it renders specially, matched by column id —
 * including the two that `createEntityDisplayColumns` would otherwise
 * reject outright (`servingAsLocations` and `expectedQuantity` — the alias
 * for the `ledgerExpectedQuantity` field — are both `readKey: null`, since
 * their real values are nested under `quantityLedger` on the list row).
 * `dataQuality` is rendered by its manifest-declared `data-quality` renderer. `usdaUnavailable` and `onHandUnits` are
 * left generic to exercise the declaration's own width/format/mobile/sorting
 * metadata, same as the shared `declared width/format/mobile/sorting` block.
 */
function buildProductColumns() {
  const helper = createCubbyColumnHelper<ProductRow>();
  return createEntityDisplayColumns(
    "product",
    helper,
    createCubbyColumnCollection<ProductRow>((add) => {
      add(
        helper.display({
          id: "category",
          cell: ({ row }) => <span>{row.original.category?.name}</span>,
        }),
      );
      add(
        helper.display({
          id: "manufacturer",
          cell: ({ row }) => <span>{row.original.manufacturer}</span>,
        }),
      );
      add(
        helper.display({
          id: "primaryGtin",
          cell: ({ row }) => <span>{row.original.primaryGtin}</span>,
        }),
      );
      add(
        helper.display({
          id: "fdc_id",
          cell: ({ row }) => <span>{row.original.fdc_id}</span>,
        }),
      );
      add(
        helper.display({
          id: "model",
          cell: ({ row }) => <span>{row.original.model}</span>,
        }),
      );
      add(
        helper.display({
          id: "notes",
          cell: ({ row }) => <span>{row.original.notes}</span>,
        }),
      );
      add(
        helper.display({
          id: "stockTracked",
          cell: ({ row }) => <span>{String(row.original.stockTracked)}</span>,
        }),
      );
      add(
        helper.display({
          id: "externalIds",
          cell: ({ row }) => <span>{row.original.externalIds.length}</span>,
        }),
      );
      add(
        helper.display({
          // A header FUNCTION, not a plain string — the one shape
          // `createEntityDisplayColumns` lets through unreplaced by the
          // declared label (which stays "Valuation price", for the detail
          // page's sake). Matches productlist.tsx's own override exactly.
          id: "price",
          header: () => "Price",
          cell: ({ row }) => <span>{row.original.price}</span>,
        }),
      );
      add(
        helper.display({
          id: "expenseTotal",
          cell: ({ row }) => <span>{row.original.expenseTotal}</span>,
        }),
      );
      add(
        helper.display({
          id: "servingAsLocations",
          cell: ({ row }) => <span>{row.original.servingAsLocations}</span>,
        }),
      );
      add(
        helper.display({
          id: "components",
          cell: ({ row }) => <span>{row.original.componentCount}</span>,
        }),
      );
      add(
        helper.display({
          id: "expectedQuantity",
          cell: ({ row }) => <span>{row.original.expectedQuantity}</span>,
        }),
      );
      add(
        helper.display({
          id: "quantityVariance",
          cell: ({ row }) => <span>{row.original.quantityVariance}</span>,
        }),
      );
      add(
        helper.display({
          id: "purchaseDate",
          cell: ({ row }) => <span>{row.original.purchaseDate}</span>,
        }),
      );
      add(
        helper.display({
          id: "tags",
          cell: ({ row }) => <span>{row.original.tags.join(", ")}</span>,
        }),
      );
      add(
        helper.display({
          id: "expenses",
          enableSorting: true,
          cell: ({ row }) => <span>{row.original.expenseCount}</span>,
        }),
      );
    }),
  );
}

/** Renders one column's cell against a fixture row — filtered to a single
 * column and invoked inside the same `.visit()` callback, so its `cell` is
 * used exactly where its `TValue` is still concrete (see
 * `materializeCubbyColumns`'s doc in table-features.ts). */
function renderProductCell(columnId: string, row: ProductRow) {
  const columns = buildProductColumns();
  const matched = columns.filter((column) => column.id === columnId);
  const rendered = matched.visit((column) => renderRowCell(column.cell, row));
  const [first] = rendered;
  if (rendered.length !== 1 || first === undefined) {
    throw new Error(`Expected exactly one column with id ${columnId}.`);
  }
  return first;
}

/** True type guard (not a bare `typeof`-narrowed cast): the domain type here
 * is exactly a column's `header`, a TanStack `ColumnDefTemplate` — a string
 * or a template function taking header context. */
function isHeaderFunction<TProps extends object>(
  header: string | ((props: TProps) => ReactNode) | undefined,
): header is (props: TProps) => ReactNode {
  return typeof header === "function";
}

/** Most columns' header is the declared label (a plain string); "price"
 * alone keeps a header FUNCTION (see `buildProductColumns`), the one shape
 * `createEntityDisplayColumns` lets through unreplaced. */
function headerText<TRecord extends object, TValue extends CellData>(
  header: CubbyColumnDef<TRecord, TValue>["header"],
): string {
  const parsed = z.string().safeParse(header);
  if (parsed.success) return parsed.data;
  if (!isHeaderFunction(header)) {
    throw new Error("Expected a string or header-template function.");
  }
  // SAFETY: "price" is this fixture's only header function
  // (`() => "Price"`), and it ignores its HeaderContext entirely — an empty
  // stand-in context is never read.
  return z.string().parse(header({} as never));
}

function buildProductColumnMeta() {
  return buildProductColumns().visit((column) => ({
    id: String(
      column.id ?? ("accessorKey" in column ? column.accessorKey : ""),
    ),
    header: headerText(column.header),
    className: column.meta?.className,
    mobile: column.meta?.mobile,
    enableSorting: column.enableSorting,
  }));
}

describe("product list display columns", () => {
  it("builds exactly the declared columns, in listOrder", () => {
    const ids = buildProductColumnMeta().map((d) => d.id);
    expect(ids).toEqual([
      "category",
      "manufacturer",
      "primaryGtin",
      "fdc_id",
      "model",
      "notes",
      "stockTracked",
      "dataQuality",
      "externalIds",
      "price",
      "expenseTotal",
      "servingAsLocations",
      "components",
      "expectedQuantity",
      "quantityVariance",
      "purchaseDate",
      "tags",
      "expenses",
      "usdaUnavailable",
      "onHandUnits",
    ]);
  });

  it("takes every header from the declared label, including on overrides", () => {
    const byId = Object.fromEntries(
      buildProductColumnMeta().map((d) => [d.id, d.header]),
    );
    expect(byId).toEqual({
      category: "Classification",
      manufacturer: "Manufacturer",
      // Was "UPC" — the list column has always headed this "Barcode / ISBN".
      primaryGtin: "Barcode / ISBN",
      // Was "USDA FDC ID" — the list column has always headed this "FDC".
      fdc_id: "FDC",
      model: "Model",
      notes: "Notes",
      // Was "Stock Tracked" (the key-derived default) — the list column has
      // always headed this "Stock tracking".
      stockTracked: "Stock tracking",
      // Was "Data Quality" (the key-derived default, different case) — the
      // list column has always headed this "Data quality".
      dataQuality: "Data quality",
      externalIds: "External IDs",
      // The declared label is "Valuation price" (the detail page's own
      // label for this field), but the list has always headed this "Price"
      // — the override opts out via a header FUNCTION, the one shape this
      // substitution leaves alone.
      price: "Price",
      expenseTotal: "Net basis",
      servingAsLocations: "In service",
      components: "Components",
      expectedQuantity: "Expected",
      quantityVariance: "Variance",
      purchaseDate: "Purchase date",
      tags: "Tags",
      expenses: "Expenses",
      usdaUnavailable: "Usda Unavailable",
      onHandUnits: "On Hand Units",
    });
  });

  it("derives enableSorting from the generated sort roster per column id", () => {
    const byId = Object.fromEntries(
      buildProductColumnMeta().map((d) => [d.id, d.enableSorting]),
    );
    // In `generatedEntitySort.product.fields`.
    expect(byId.category).toBe(true);
    expect(byId.manufacturer).toBe(true);
    expect(byId.primaryGtin).toBe(true);
    expect(byId.fdc_id).toBe(true);
    expect(byId.model).toBe(true);
    expect(byId.notes).toBe(true);
    expect(byId.price).toBe(true);
    expect(byId.expenseTotal).toBe(true);
    expect(byId.expectedQuantity).toBe(true);
    expect(byId.quantityVariance).toBe(true);
    expect(byId.purchaseDate).toBe(true);
    // The override's own `enableSorting: true` survives even though
    // "expenses" is also in the roster (belt-and-suspenders in the page).
    expect(byId.expenses).toBe(true);
    // Not in the roster.
    expect(byId.stockTracked).toBe(false);
    // The manifest renderer's column sorts by score; its id is the sort field.
    expect(byId.dataQuality).toBe(true);
    expect(byId.externalIds).toBe(false);
    expect(byId.servingAsLocations).toBe(false);
    expect(byId.components).toBe(false);
    expect(byId.tags).toBe(false);
    expect(byId.usdaUnavailable).toBe(false);
    expect(byId.onHandUnits).toBe(false);
  });

  it("carries the declared width/mobile metadata for a generic column", () => {
    const byId = Object.fromEntries(
      buildProductColumnMeta().map((d) => [d.id, d]),
    );
    // `usdaUnavailable` declares no width/mobile at all — hidden by default
    // but still built (same shape as the task entity's
    // `dueEndDate`/`sortOrder`); `onHandUnits` is the mobile card's trailing
    // value.
    expect(byId.usdaUnavailable?.className).toBeUndefined();
    expect(byId.usdaUnavailable?.mobile).toBeUndefined();
    expect(byId.onHandUnits?.className).toBeUndefined();
    expect(byId.onHandUnits?.mobile).toMatchObject({ slot: "trailing" });
  });

  it("renders the category override's own cell against the row", () => {
    render(<>{renderProductCell("category", PRODUCT_ROW)}</>);
    expect(screen.getByText("Tools")).toBeVisible();
  });

  it("renders the expectedQuantity override (the ledgerExpectedQuantity alias) against the row", () => {
    render(<>{renderProductCell("expectedQuantity", PRODUCT_ROW)}</>);
    expect(screen.getByText("3")).toBeVisible();
  });

  it("rejects an override for a field the declaration no longer lists (the stored expectedQuantity field left the list)", () => {
    const helper = createCubbyColumnHelper<
      ProductRow & { rawExpectedQuantity: number | null }
    >();
    expect(() =>
      createEntityDisplayColumns(
        "product",
        helper,
        createCubbyColumnCollection((add) => {
          for (const id of [
            "category",
            "manufacturer",
            "primaryGtin",
            "fdc_id",
            "model",
            "notes",
            "stockTracked",
            "externalIds",
            "price",
            "expenseTotal",
            "servingAsLocations",
            "components",
            "expectedQuantity",
            "quantityVariance",
            "purchaseDate",
            "tags",
            "expenses",
          ]) {
            add(helper.display({ id, cell: () => null }));
          }
          // Not a declared column id at all (the raw stored field has no
          // `display.list` any more) — must be rejected as undeclared.
          add(helper.display({ id: "rawExpectedQuantity", cell: () => null }));
        }),
      ),
    ).toThrow("Undeclared display renderer for product.rawExpectedQuantity");
  });
});
