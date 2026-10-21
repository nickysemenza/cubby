import { flexRender } from "@tanstack/react-table";
import { render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { buildSelectColumn, reconcileRowSelection } from "./row-selection";
import { createCubbyColumnHelper, useCubbyTable } from "./table-features";

interface TestRow {
  id: string;
  selectable: boolean;
}

const helper = createCubbyColumnHelper<TestRow>();
const columns = helper.columns([
  buildSelectColumn<TestRow>(),
  helper.accessor("id", { id: "id", header: "ID" }),
]);

describe("buildSelectColumn", () => {
  it("renders no checkbox for a row the table won't select", () => {
    // A heterogeneous tree's foreign child has no selection affordance.
    const { result } = renderHook(() =>
      useCubbyTable({
        data: [{ id: "candidate", selectable: false }],
        columns,
        getRowId: (row) => row.id,
        enableRowSelection: (row) => row.original.selectable,
      }),
    );
    const cell = result.current.getRow("candidate").getVisibleCells()[0];
    if (!cell) throw new Error("Select cell was not created");
    render(
      <div>{flexRender(cell.column.columnDef.cell, cell.getContext())}</div>,
    );
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
});

describe("reconcileRowSelection", () => {
  it("drops stale keys while retaining available selections", () => {
    expect(
      reconcileRowSelection(
        { available: true, deleted: true },
        new Set(["available"]),
      ),
    ).toEqual({ available: true });
  });
});
