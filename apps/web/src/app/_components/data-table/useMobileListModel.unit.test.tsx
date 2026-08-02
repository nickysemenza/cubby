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
    const table = {
      getRowModel: () => ({
        rows: [
          {
            id: "row-1",
            original: { id: "PRD-TEST", name: "Test product" },
            getVisibleCells: () => [
              {
                column: {
                  id: "related:product.vendors",
                  columnDef: {
                    header: "Vendors",
                    cell: () => preview,
                    meta: { mobile: { slot: "meta" } },
                  },
                  accessorFn: undefined,
                },
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
    preview = "Moore Newton";
    rerender({ rowContentVersion: {} });
    rerenderCell(result.current[0]?.metaValues[0]?.value ?? null);
    expect(screen.getByText("Moore Newton")).toBeInTheDocument();
  });
});
