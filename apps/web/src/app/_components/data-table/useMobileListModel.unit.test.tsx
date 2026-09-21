import { render, renderHook, screen } from "@testing-library/react";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import type { CubbyTable as Table } from "./table-features";
import { useMobileListModel } from "./useMobileListModel";

interface TestRow {
  id: string;
  name: string;
  previewId?: string;
}

describe("useMobileListModel", () => {
  it("rebuilds pre-rendered cells when external row content changes", () => {
    let preview = "…";
    const column = {
      id: "related:product.vendors",
      columnDef: {
        header: "Vendors",
        cell: () => preview,
        meta: {
          mobile: { slot: "meta" },
          provenance: {
            kind: "derived",
            sources: [
              { entity: null, label: "Vendor projection", relation: null },
            ],
          },
        },
      },
      accessorFn: undefined,
    };
    const table = fromPartial<Table<TestRow>>({
      getRowModel: () => ({
        rows: [
          {
            id: "row-1",
            original: { id: "PRD-TEST", name: "Test product" },
            getVisibleCells: () => [
              {
                column,
                getContext: () => ({}),
                getValue: () => undefined,
              },
            ],
          },
        ],
      }),
    });

    const firstVersion = {};
    const { result, rerender } = renderHook(
      ({ rowContentVersion }) =>
        useMobileListModel({ table, rowContentVersion }),
      { initialProps: { rowContentVersion: firstVersion } },
    );

    const { rerender: rerenderCell } = render(
      result.current[0]?.metaValues[0]?.value ?? null,
    );
    expect(screen.getByText("…")).toBeInTheDocument();
    expect(
      screen.getByRole("note", { name: "From Vendor projection" }),
    ).toBeInTheDocument();
    preview = "<vendor name>";
    rerender({ rowContentVersion: {} });
    rerenderCell(result.current[0]?.metaValues[0]?.value ?? null);
    expect(screen.getByText("<vendor name>")).toBeInTheDocument();
  });

  it("uses a per-row canonical detail route for heterogeneous lists", () => {
    const column = {
      id: "name",
      columnDef: { header: "Name", cell: () => "Candidate" },
      accessorFn: () => "Candidate",
    };
    const table = fromPartial<Table<TestRow>>({
      getVisibleLeafColumns: () => [column],
      getRowModel: () => ({
        rows: [
          {
            id: "WSH-ONE:PRD-TWO",
            original: {
              id: "WSH-ONE:PRD-TWO",
              name: "Candidate",
              previewId: "PRD-TWO",
            },
            getVisibleCells: () => [],
          },
        ],
      }),
    });

    const { result } = renderHook(() =>
      useMobileListModel({
        table,
        entity: "wish",
        getDetailsHref: (row) => `/products/${row.previewId}`,
      }),
    );

    expect(result.current[0]?.detailsHref).toBe("/products/PRD-TWO");
  });

  it("suppresses implicit entity routes for specialist mobile interactions", () => {
    const column = {
      id: "name",
      columnDef: { header: "Name", cell: () => "Ingredient" },
      accessorFn: () => "Ingredient",
    };
    const table = fromPartial<Table<TestRow>>({
      getVisibleLeafColumns: () => [column],
      getRowModel: () => ({
        rows: [
          {
            id: "ING-ONE",
            original: { id: "ING-ONE", name: "Ingredient" },
            getVisibleCells: () => [],
          },
        ],
      }),
    });

    const { result } = renderHook(() =>
      useMobileListModel({
        table,
        entity: "ingredient",
        getDetailsHref: () => "/ingredients/ING-ONE",
        disableDetailsHref: true,
      }),
    );

    expect(result.current[0]?.detailsHref).toBeUndefined();
  });
});
