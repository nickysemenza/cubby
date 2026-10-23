import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import TableHeaderLayout from "~/entity/table/table-header-layout";

import {
  applyColumnLayout,
  moveColumn,
  useTableColumnLayout,
} from "./column-layout";
import {
  createCubbyColumnHelper,
  createCubbyColumnCollection,
  useCubbyTable,
} from "./table-features";
import TableLayoutCustomizer from "./table-layout-customizer";
import type { CubbyTableMeta } from "./table-meta";

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
  it("hides, restores, reorders and pins whole bands without splitting their columns", () => {
    const grouped = helper.columns([
      helper.accessor("name", { id: "name", header: "Name" }),
      helper.accessor("trade", {
        id: "spend",
        header: "Spend",
        meta: { columnGroup: "Purchasing" },
      }),
      helper.display({
        id: "products",
        header: "Products",
        meta: { columnGroup: "Brand" },
      }),
      helper.display({
        id: "purchases",
        header: "Purchases",
        meta: { columnGroup: "Purchasing" },
      }),
    ]);
    function GroupHarness() {
      const layout = useTableColumnLayout({
        columns: createCubbyColumnCollection<TestRow>((add) =>
          grouped.forEach(add),
        ),
      });
      const table = useCubbyTable({
        columns: layout.columns,
        data: [],
        initialState: layout.defaultLayout,
      });
      return (
        <>
          <TableLayoutCustomizer table={table} />
          <table>
            <thead>
              <TableHeaderLayout
                table={table}
                styles={{ header: "", sortIcon: "" }}
                isDebugEnabled={false}
              />
            </thead>
          </table>
          <output data-testid="painted">
            {table
              .getVisibleLeafColumns()
              .map((column) => column.id)
              .join(",")}
          </output>
          <output data-testid="pins">
            {table.state.columnPinning.start?.join(",")}
          </output>
          <button
            onClick={() =>
              moveColumn(table, {
                kind: "reorder",
                id: "spend",
                over: "products",
              })
            }
          >
            Invalid cross-group move
          </button>
          <button
            onClick={() =>
              applyColumnLayout(table, {
                ...layout.defaultLayout,
                columnOrder: ["name", "spend", "products", "purchases"],
                columnPinning: { start: ["spend"], end: ["purchases"] },
              })
            }
          >
            Apply interleaved layout
          </button>
        </>
      );
    }
    render(<GroupHarness />);
    const painted = () => screen.getByTestId("painted");
    expect(painted()).toHaveTextContent("name,spend,purchases,products");
    expect(
      screen.getByRole("columnheader", { name: "Purchasing" }),
    ).toHaveAttribute("colspan", "2");
    fireEvent.click(
      screen.getByRole("button", { name: "Invalid cross-group move" }),
    );
    expect(painted()).toHaveTextContent("name,spend,purchases,products");
    fireEvent.click(
      screen.getByRole("button", { name: "Move Purchases earlier" }),
    );
    expect(painted()).toHaveTextContent("name,purchases,spend,products");
    fireEvent.click(
      screen.getByRole("button", { name: "Hide Purchasing group" }),
    );
    expect(painted()).toHaveTextContent("name,products");
    expect(
      screen.queryByRole("columnheader", { name: "Purchasing" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Show Purchasing group" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Move Purchasing group later" }),
    );
    expect(painted()).toHaveTextContent("name,products,purchases,spend");
    fireEvent.click(screen.getByRole("button", { name: "Pin Spend to start" }));
    expect(screen.getByTestId("pins")).toHaveTextContent("purchases,spend");
    fireEvent.click(
      screen.getByRole("button", { name: "Pin Products to start" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Move Spend earlier" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Move Purchasing group later" }),
    );
    expect(screen.getByTestId("pins")).toHaveTextContent(
      "products,spend,purchases",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Apply interleaved layout" }),
    );
    expect(screen.getByTestId("pins")).toHaveTextContent("spend,purchases");
  });
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
