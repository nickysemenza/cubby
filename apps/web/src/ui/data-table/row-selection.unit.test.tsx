import { flexRender, type RowSelectionState } from "@tanstack/react-table";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { buildSelectColumn, reconcileRowSelection } from "./row-selection";
import type { CubbyRow as Row } from "./table-features";
import { createCubbyColumnHelper, useCubbyTable } from "./table-features";

interface TestRow {
  id: string;
  selectable?: boolean;
}

const columnHelper = createCubbyColumnHelper<TestRow>();
const dataColumns = columnHelper.columns([
  buildSelectColumn<TestRow>(),
  columnHelper.accessor("id", { id: "id", header: "ID" }),
]);

function useTestTable(
  data: TestRow[],
  initialRowSelection?: RowSelectionState,
) {
  return useCubbyTable({
    data,
    columns: dataColumns,
    getRowId: (row) => row.id,
    enableRowSelection: (row) => row.original.selectable ?? true,
    initialState: { rowSelection: initialRowSelection },
  });
}

/**
 * Render the select column's cell for a row.
 */
function renderSelectCell(row: Row<TestRow>) {
  const cell = row.getVisibleCells()[0];
  if (!cell) throw new Error("Select cell was not created");
  render(
    <div>{flexRender(cell.column.columnDef.cell, cell.getContext())}</div>,
  );
}

function renderSelectHeader() {
  const { result } = renderHook(() =>
    useTestTable(
      [
        { id: "first", selectable: true },
        { id: "second", selectable: true },
      ],
      { first: true, second: true },
    ),
  );
  const header = result.current.getHeaderGroups()[0]?.headers[0];
  if (!header) throw new Error("Select column header was not created");
  render(
    <div>
      {flexRender(header.column.columnDef.header, header.getContext())}
    </div>,
  );
}

describe("buildSelectColumn", () => {
  it("renders no checkbox for a row the table won't select", () => {
    // A heterogeneous tree's foreign child (see `EntityListTreeConfig.
    // rowIsEntity`). A rendered-but-inert checkbox reads as an affordance
    // that silently does nothing.
    const { result } = renderHook(() =>
      useTestTable([{ id: "candidate", selectable: false }]),
    );
    renderSelectCell(result.current.getRow("candidate"));
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("renders a checkbox for a selectable row", () => {
    const { result } = renderHook(() => useTestTable([{ id: "wish" }]));
    renderSelectCell(result.current.getRow("wish"));
    expect(screen.getByRole("checkbox")).toBeInTheDocument();
  });

  it("does not mark a fully selected page indeterminate", () => {
    renderSelectHeader();
    expect(screen.getByRole("checkbox")).not.toHaveAttribute(
      "data-indeterminate",
    );
  });

  it("forwards the native shift event to v9 range selection", () => {
    const { result } = renderHook(() => useTestTable([{ id: "wish-b" }]));
    renderSelectCell(result.current.getRow("wish-b"));

    fireEvent.click(screen.getByRole("checkbox"), { shiftKey: true });

    const selection = result.current.atoms.rowSelection;
    if (!selection) throw new Error("Row selection atom was not created");
    expect(selection.get()).toEqual({ "wish-b": true });
  });

  it("skips unselectable intermediate rows in a native Shift range", () => {
    const helper = createCubbyColumnHelper<{
      id: string;
      selectable: boolean;
    }>();
    const columns = helper.columns([
      helper.accessor("id", { id: "id", header: "ID" }),
    ]);
    const data = [
      { id: "wish-a", selectable: true },
      { id: "candidate", selectable: false },
      { id: "wish-b", selectable: true },
    ];
    const { result } = renderHook(() =>
      useCubbyTable({
        data,
        columns,
        getRowId: (row) => row.id,
        enableRowSelection: (row) => row.original.selectable,
      }),
    );

    act(() => {
      result.current
        .getRow("wish-a")
        .getToggleSelectedHandler({ selectChildren: false })({
        target: { checked: true },
        nativeEvent: { shiftKey: false },
      });
      result.current
        .getRow("wish-b")
        .getToggleSelectedHandler({ selectChildren: false })({
        target: { checked: true },
        nativeEvent: { shiftKey: true },
      });
    });

    expect(result.current.atoms.rowSelection?.get()).toEqual({
      "wish-a": true,
      "wish-b": true,
    });
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

  it("keeps the same object when every selected row remains available", () => {
    const current = { first: true, second: true } as const;
    expect(
      reconcileRowSelection(current, new Set(["first", "second", "third"])),
    ).toBe(current);
  });
});
