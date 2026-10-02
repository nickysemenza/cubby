import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createCubbyColumnHelper, useCubbyTable } from "./table-features";
import type { CubbyTableMeta } from "./table-meta";
import TableLayoutCustomizer from "./TableLayoutCustomizer";

interface TestRow {
  id: string;
  name: string;
  trade: string;
}

const helper = createCubbyColumnHelper<TestRow>();
const columns = helper.columns([
  helper.display({
    header: "Select",
    id: "select",
    meta: { entityColumnRole: "selection" },
  }),
  helper.display({
    header: "Image",
    id: "image",
    meta: { entityColumnRole: "image" },
  }),
  helper.accessor("name", { header: "Name", id: "name" }),
  helper.accessor("trade", { header: "Trade", id: "trade" }),
  helper.display({
    header: "Actions",
    id: "actions",
    meta: { entityColumnRole: "action" },
  }),
]);
const defaultLayout = {
  columnOrder: ["select", "image", "name", "trade", "actions"],
  columnPinning: { start: ["select", "image"], end: ["actions"] },
  columnVisibility: {
    select: true,
    image: true,
    name: true,
    trade: true,
    actions: true,
  },
  columnSizing: {},
} satisfies NonNullable<CubbyTableMeta["defaultLayout"]>;

function LayoutHarness() {
  const table = useCubbyTable({
    data: [{ id: "PRD-4K7M", name: "Hammer", trade: "tools" }],
    columns,
    getRowId: (row) => row.id,
    initialState: {
      columnOrder: defaultLayout.columnOrder,
      columnPinning: defaultLayout.columnPinning,
      columnVisibility: defaultLayout.columnVisibility,
    },
    meta: { defaultLayout },
  });
  return (
    <>
      <TableLayoutCustomizer table={table} />
      <output data-testid="column-order">
        {table.state.columnOrder.join(",")}
      </output>
    </>
  );
}

describe("TableLayoutCustomizer", () => {
  it("keeps structural columns out of every mutable affordance", () => {
    render(<LayoutHarness />);

    for (const label of ["Select", "Image", "Actions"]) {
      expect(
        screen.queryByRole("button", { name: `Drag ${label}` }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: `Move ${label} later` }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: `Hide ${label}` }),
      ).toBeNull();
    }
    expect(screen.queryByRole("button", { name: "Unpin Image" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unpin Actions" })).toBeNull();
    expect(screen.getByRole("button", { name: "Drag Name" })).toBeVisible();
  });

  it("hides an optional column and restores the defined layout", () => {
    render(<LayoutHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Hide Name" }));
    expect(screen.getByRole("button", { name: "Show Name" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Move Trade earlier" }));
    expect(screen.getByTestId("column-order")).toHaveTextContent(
      "select,image,trade,name,actions",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Restore default layout" }),
    );
    expect(screen.getByTestId("column-order")).toHaveTextContent(
      "select,image,name,trade,actions",
    );
    expect(screen.getByRole("button", { name: "Hide Name" })).toBeVisible();
  });
});
