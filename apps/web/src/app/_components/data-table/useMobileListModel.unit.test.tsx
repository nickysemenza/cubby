import { render, renderHook, screen } from "@testing-library/react";
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
        meta: { mobile: { slot: "meta" } },
      },
      accessorFn: undefined,
    };
    const table = {
      // `mobileListShape` reads this to decide whether the list reserves a
      // thumbnail gutter, so a row-model-only stub no longer satisfies the hook.
      getVisibleLeafColumns: () => [column],
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
    } as unknown as Table<TestRow>;

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
    const table = {
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
    } as unknown as Table<TestRow>;

    const { result } = renderHook(() =>
      useMobileListModel({
        table,
        entity: "wish",
        getDetailsHref: (row) => `/products/${row.previewId}`,
      }),
    );

    expect(result.current[0]?.detailsHref).toBe("/products/PRD-TWO");
  });
});
