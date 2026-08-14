import type { Table } from "@tanstack/react-table";
import { render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useMobileListModel } from "./useMobileListModel";

interface TestRow {
  id: string;
  name: string;
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
});

describe("title slot", () => {
  it("falls back to the accessor value when the cell renders an element", () => {
    // Every identity column renders a link, not a bare string. When the slot
    // only accepted strings the override silently failed and the card fell
    // through to `extractEntityTitle`, which answers "Unknown" for an entity
    // with no `name` — so an entire list of purchase cards was titled that.
    const column = {
      id: "purchase",
      columnDef: {
        header: "Purchase",
        cell: () => "unused",
        meta: { mobile: { slot: "title" } },
      },
      accessorFn: (row: unknown) => row,
    };
    const table = {
      getVisibleLeafColumns: () => [column],
      getRowModel: () => ({
        rows: [
          {
            id: "row-1",
            // No `name`: this is what sends extractEntityTitle to its fallback.
            original: { id: "PUR-TEST" },
            getVisibleCells: () => [
              {
                column: {
                  ...column,
                  columnDef: {
                    ...column.columnDef,
                    // An element, exactly as a real identity column renders.
                    cell: () => ({ type: "a", props: {}, key: null }),
                  },
                },
                getContext: () => ({}),
                getValue: () => "<identity>",
              },
            ],
          },
        ],
      }),
    } as unknown as Table<TestRow>;

    const { result } = renderHook(() =>
      useMobileListModel({ table, rowContentVersion: {} }),
    );

    expect(result.current[0]?.title).toBe("<identity>");
  });
});
