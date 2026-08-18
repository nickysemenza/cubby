import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import TableHeaderLayout from "./TableHeaderLayout";
import { createCubbyColumnHelper, useCubbyTable } from "./table-features";

interface TestRow {
  id: string;
  name: string;
}

const helper = createCubbyColumnHelper<TestRow>();
const columns = helper.columns([
  helper.display({ id: "select", header: "Select" }),
  helper.display({ id: "image", header: "Image" }),
  helper.accessor("name", {
    id: "name",
    header: "Name",
    size: 180,
    minSize: 80,
    maxSize: 400,
  }),
  helper.display({ id: "actions", header: "Actions" }),
]);

let lastTable: ReturnType<typeof useCubbyTable<TestRow>> | undefined;

function nameResizeHandle() {
  const header = screen
    .getByRole("button", { name: "Reorder name column" })
    .closest("th");
  const handle = header?.querySelector(
    '[title="Drag to resize · double-click to reset"]',
  );
  if (!(handle instanceof HTMLElement))
    throw new Error("missing resize handle");
  return handle;
}

function Harness() {
  const table = useCubbyTable({
    data: [{ id: "row-a", name: "Alpha" }],
    columns,
    getRowId: (row) => row.id,
  });
  lastTable = table;
  return (
    <table>
      <thead>
        <TableHeaderLayout
          table={table}
          styles={{ header: "", sortIcon: "" }}
          isDebugEnabled={false}
        />
      </thead>
    </table>
  );
}

describe("TableHeaderLayout", () => {
  it("does not render reorder grips for Select or Image", () => {
    render(<Harness />);

    expect(
      screen.queryByRole("button", { name: "Reorder select column" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reorder image column" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reorder name column" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reorder actions column" }),
    ).toBeInTheDocument();
  });

  it("commits a native mouse resize without starting column ordering", () => {
    render(<Harness />);
    const handle = nameResizeHandle();
    const orderBefore = lastTable?.state.columnOrder;

    fireEvent.mouseDown(handle, { clientX: 180 });
    fireEvent.mouseMove(document, { clientX: 240 });
    fireEvent.mouseUp(document, { clientX: 240 });

    expect(lastTable?.getColumn("name")?.getSize()).toBe(240);
    expect(lastTable?.state.columnOrder).toEqual(orderBefore);
    expect(
      screen.getByRole("button", { name: "Reorder name column" }),
    ).toBeInTheDocument();
  });

  it("supports touch resize and double-click reset", () => {
    render(<Harness />);
    const handle = nameResizeHandle();

    fireEvent.touchStart(handle, { touches: [{ clientX: 180 }] });
    fireEvent.touchMove(document, { touches: [{ clientX: 220 }] });
    fireEvent.touchEnd(document, { touches: [{ clientX: 220 }] });
    expect(lastTable?.getColumn("name")?.getSize()).toBe(220);

    fireEvent.doubleClick(handle);
    expect(lastTable?.getColumn("name")?.getSize()).toBe(180);
  });
});
