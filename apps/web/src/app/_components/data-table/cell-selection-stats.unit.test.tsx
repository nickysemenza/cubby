import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { numberCellData } from "./cell-data";
import { getCellSelectionStats } from "./cell-selection-stats";
import { createCubbyColumnHelper, useCubbyTable } from "./table-features";

interface Row {
  id: string;
  cost: number | null;
  quantity: number | null;
  name: string;
}

const helper = createCubbyColumnHelper<Row>();
const rows: Row[] = [
  { id: "a", cost: 12.5, quantity: 2, name: "One" },
  { id: "b", cost: null, quantity: 4, name: "Two" },
];
const columns = helper.columns([
  helper.accessor("cost", {
    id: "cost",
    meta: { cellData: numberCellData("currency", (row) => row.cost) },
  }),
  helper.accessor("quantity", {
    id: "quantity",
    meta: { cellData: numberCellData("number", (row) => row.quantity) },
  }),
  helper.accessor("name", { id: "name" }),
]);

describe("getCellSelectionStats", () => {
  it("uses typed currency values and ignores blanks", () => {
    const { result } = renderHook(() =>
      useCubbyTable({ data: rows, columns, getRowId: (row) => row.id }),
    );
    act(() => {
      result.current.selectCellRange({
        anchorRowId: "a",
        anchorColumnId: "cost",
        focusRowId: "b",
        focusColumnId: "cost",
      });
    });

    expect(getCellSelectionStats(result.current)).toEqual({
      cellCount: 2,
      numericCount: 1,
      kind: "currency",
      sum: 12.5,
      average: 12.5,
    });
  });

  it("does not add mixed numeric units or text cells", () => {
    const { result } = renderHook(() =>
      useCubbyTable({ data: rows, columns, getRowId: (row) => row.id }),
    );
    act(() => {
      result.current.selectCellRange({
        anchorRowId: "a",
        anchorColumnId: "cost",
        focusRowId: "a",
        focusColumnId: "quantity",
      });
    });
    expect(getCellSelectionStats(result.current)).toMatchObject({
      cellCount: 2,
      numericCount: 1,
      kind: null,
      sum: null,
      average: null,
    });
  });
});
