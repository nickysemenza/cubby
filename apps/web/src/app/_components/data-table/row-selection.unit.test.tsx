import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { buildSelectColumn } from "./row-selection";
import type {
  CubbyColumnDef as ColumnDef,
  CubbyRow as Row,
  CubbyTable as Table,
} from "./table-features";
import { createCubbyColumnHelper, useCubbyTable } from "./table-features";

interface TestRow {
  id: string;
}

const fakeRow = (
  id: string,
  canSelect: boolean,
  selected = false,
  onToggle?: (event: unknown) => void,
) =>
  ({
    id,
    original: { id },
    getCanSelect: () => canSelect,
    getIsSelected: () => selected,
    getToggleSelectedHandler: () => onToggle ?? (() => {}),
  }) as unknown as Row<TestRow>;

/**
 * Render the select column's cell for a row.
 */
function renderSelectCell({ row }: { row: Row<TestRow> }) {
  const column = buildSelectColumn<TestRow>() as ColumnDef<TestRow> & {
    cell: (ctx: { row: Row<TestRow> }) => ReactElement;
  };

  render(<div>{column.cell({ row })}</div>);
}

function renderSelectHeader({ some, all }: { some: boolean; all: boolean }) {
  const column = buildSelectColumn<TestRow>();
  render(
    <div>
      {(column.header as (context: unknown) => ReactElement)({
        table: {
          getIsSomePageRowsSelected: () => some,
          getIsAllPageRowsSelected: () => all,
          toggleAllPageRowsSelected: () => {},
        } as unknown as Table<TestRow>,
      })}
    </div>,
  );
}

describe("buildSelectColumn", () => {
  it("renders no checkbox for a row the table won't select", () => {
    // A heterogeneous tree's foreign child (see `EntityListTreeConfig.
    // rowIsEntity`). A rendered-but-inert checkbox reads as an affordance
    // that silently does nothing.
    renderSelectCell({
      row: fakeRow("candidate", false),
    });
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("renders a checkbox for a selectable row", () => {
    renderSelectCell({
      row: fakeRow("wish", true),
    });
    expect(screen.getByRole("checkbox")).toBeInTheDocument();
  });

  it("does not mark a fully selected page indeterminate", () => {
    renderSelectHeader({ some: true, all: true });
    expect(screen.getByRole("checkbox")).not.toHaveAttribute(
      "data-indeterminate",
    );
  });

  it("forwards the native shift event to v9 range selection", () => {
    let received: unknown;
    renderSelectCell({
      row: fakeRow("wish-b", true, false, (event) => {
        received = event;
      }),
    });

    fireEvent.click(screen.getByRole("checkbox"), { shiftKey: true });

    expect(received).toMatchObject({
      target: { checked: true },
      nativeEvent: { shiftKey: true },
    });
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
