import { render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CubbyTable as Table } from "./table-features";
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
