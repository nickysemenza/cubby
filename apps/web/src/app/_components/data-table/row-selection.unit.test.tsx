import { fireEvent, render, screen } from "@testing-library/react";
import { createRef, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { buildSelectColumn } from "./row-selection";
import type {
  CubbyColumnDef as ColumnDef,
  CubbyRow as Row,
  CubbyTable as Table,
} from "./table-features";

interface TestRow {
  id: string;
}

const fakeRow = (id: string, canSelect: boolean, selected = false) =>
  ({
    id,
    original: { id },
    getCanSelect: () => canSelect,
    getIsSelected: () => selected,
    toggleSelected: () => {},
  }) as unknown as Row<TestRow>;

/**
 * Render the select column's cell for `row`, with `rows` as the visible row
 * model. Returns the selection map the cell would have written.
 */
function renderSelectCell({
  row,
  rows,
  anchorId = null,
}: {
  row: Row<TestRow>;
  rows: Row<TestRow>[];
  anchorId?: string | null;
}) {
  const lastSelectedIdRef = createRef<string | null>() as {
    current: string | null;
  };
  lastSelectedIdRef.current = anchorId;
  // Left false: the cell's own capture-phase handler sets it from the click,
  // which is the ordering the real interaction depends on.
  const shiftKeyRef = createRef<boolean>() as { current: boolean };
  shiftKeyRef.current = false;

  let written: Record<string, true> | null = null;
  const table = {
    getRowModel: () => ({ rows }),
    setRowSelection: (
      updater: (prev: Record<string, true>) => Record<string, true>,
    ) => {
      written = updater({});
    },
  } as unknown as Table<TestRow>;

  const column = buildSelectColumn<TestRow>(
    lastSelectedIdRef,
    shiftKeyRef,
  ) as ColumnDef<TestRow> & {
    cell: (ctx: { row: Row<TestRow>; table: Table<TestRow> }) => ReactElement;
  };

  render(<div>{column.cell({ row, table })}</div>);
  return { written: () => written };
}

function renderSelectHeader({ some, all }: { some: boolean; all: boolean }) {
  const column = buildSelectColumn<TestRow>(
    createRef<string | null>() as { current: string | null },
    createRef<boolean>() as { current: boolean },
  );
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
      rows: [fakeRow("candidate", false)],
    });
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("renders a checkbox for a selectable row", () => {
    renderSelectCell({
      row: fakeRow("wish", true),
      rows: [fakeRow("wish", true)],
    });
    expect(screen.getByRole("checkbox")).toBeInTheDocument();
  });

  it("does not mark a fully selected page indeterminate", () => {
    renderSelectHeader({ some: true, all: true });
    expect(screen.getByRole("checkbox")).not.toHaveAttribute(
      "data-indeterminate",
    );
  });

  it("skips unselectable rows inside a shift-click range", () => {
    // This branch writes the selection map DIRECTLY rather than going through
    // `row.toggleSelected`, so without the guard it selects rows the table
    // just refused to give a checkbox — reachable by shift-clicking across an
    // expanded wish's candidate rows.
    const rows = [
      fakeRow("wish-a", true),
      fakeRow("wish-a:candidate", false),
      fakeRow("wish-b", true),
    ];
    const { written } = renderSelectCell({
      row: rows[2]!,
      rows,
      anchorId: "wish-a",
    });

    fireEvent.click(screen.getByRole("checkbox"), { shiftKey: true });

    expect(written()).toEqual({ "wish-a": true, "wish-b": true });
  });
});
