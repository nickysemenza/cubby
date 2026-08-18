import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createCubbyColumnHelper, useCubbyTable } from "./table-features";
import { useCellSelection } from "./useCellSelection";

interface TestRow {
  id: string;
  alpha: string;
  beta: string;
  gamma: string;
}

const helper = createCubbyColumnHelper<TestRow>();
const columns = helper.columns([
  helper.accessor("alpha", { id: "alpha", header: "Alpha" }),
  helper.accessor("beta", { id: "beta", header: "Beta" }),
  helper.accessor("gamma", { id: "gamma", header: "Gamma" }),
]);
const data: TestRow[] = [
  { id: "row-a", alpha: "A1", beta: "B1", gamma: "G1" },
  { id: "row-b", alpha: "A2", beta: "B2", gamma: "G2" },
];
const noopScroll = () => undefined;

describe("useCellSelection", () => {
  it("derives clipboard coordinates in pinned display order", () => {
    const { result } = renderHook(() => {
      const table = useCubbyTable({
        data,
        columns,
        getRowId: (row) => row.id,
        initialState: {
          columnPinning: { start: ["gamma"], end: [] },
        },
      });
      const selection = useCellSelection({
        enabled: true,
        rows: table.getRowModel().rows,
        table,
        scrollToFlatRow: noopScroll,
      });
      return { selection, table };
    });

    act(() => {
      result.current.table.selectCellRange({
        anchorRowId: "row-a",
        anchorColumnId: "gamma",
        focusRowId: "row-b",
        focusColumnId: "alpha",
      });
    });

    expect(result.current.table.atoms.cellSelection?.get()).toHaveLength(1);
    expect(result.current.selection.selection).toEqual({
      anchor: { row: 0, col: 0 },
      focus: { row: 1, col: 1 },
    });
  });
});
