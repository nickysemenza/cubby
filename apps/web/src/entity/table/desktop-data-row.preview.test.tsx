import type { ProductListItem } from "@cubby/schemas/product";
import { productListItemOut } from "@cubby/schemas/product";
import { testShortcode } from "@cubby/schemas/testing";
import { act, render, renderHook, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { page } from "vitest/browser";

import {
  entityReadFixture,
  fieldValueFixture,
} from "~/entity/fields/field-envelope.fixtures";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { DenseCellContext } from "~/ui/common/stacked-value";

import {
  createCubbyColumnHelper,
  useCubbyTable,
} from "../../ui/data-table/table-features";
import { DesktopDataRow } from "./desktop-data-row";
import { InventoryEntriesCell } from "./inventory-entries-cell";

const helper = createCubbyColumnHelper<{ id: string; name: string }>();
const columns = helper.columns([
  helper.accessor("name", { header: "Name", size: 140 }),
]);
const data = [{ id: "synthetic-row", name: "Example record" }];

it("keeps stock context available without adding a third dense row line", () => {
  const harness = createBrowserTestHarness();
  const context = "Inventory recorded; quantity history unknown";
  try {
    render(
      <DenseCellContext.Provider value={{ linksTo: "location" }}>
        <div data-testid="stock-cell" style={{ width: 180 }}>
          <InventoryEntriesCell
            entries={[
              entityReadFixture(
                productListItemOut.shape.inventoryEntry.element,
                {
                  id: testShortcode("inventory", "INV-1234"),
                  fields: {
                    amount: fieldValueFixture(
                      productListItemOut.shape.inventoryEntry.element.shape
                        .fields.shape.amount,
                      { value: 2, unit: "each" },
                    ),
                  },
                  location: entityReadFixture(
                    productListItemOut.shape.inventoryEntry.element.shape
                      .location,
                    {
                      id: testShortcode("location", "LOC-1234"),
                      name: "Example shelf",
                    },
                  ),
                },
              ),
            ]}
            context={context}
            entity="location"
            getRelatedEntity={(
              entry: ProductListItem["inventoryEntry"][number],
            ) => entry.location}
            layout="inline"
            row={{ id: "synthetic-row" }}
          />
        </div>
      </DenseCellContext.Provider>,
      { wrapper: harness.wrapper },
    );
    expect(screen.getByText(context)).toBeInTheDocument();
    expect(screen.getByTitle(context)).toBeInTheDocument();
    expect(
      screen.getByTestId("stock-cell").getBoundingClientRect().height,
    ).toBeLessThanOrEqual(32);
  } finally {
    harness.dispose();
  }
});

it("draws a pinned boundary where interior columns have no rule", async () => {
  await page.viewport(1440, 900);
  render(
    <>
      <div
        data-testid="boundary-reference"
        style={{ borderRight: "1px solid var(--brand-hairline)" }}
      />
      <table>
        <tbody>
          <tr>
            <td
              className="table-pinned-boundary-start"
              data-testid="pinned-boundary"
            >
              Pinned
            </td>
            <td data-testid="interior-rule">Other</td>
            <td>Last</td>
          </tr>
        </tbody>
      </table>
    </>,
  );
  const pinned = getComputedStyle(
    screen.getByTestId("pinned-boundary"),
  ).borderRightColor;
  expect(pinned).toBe(
    getComputedStyle(screen.getByTestId("boundary-reference")).borderRightColor,
  );
  expect(
    getComputedStyle(screen.getByTestId("interior-rule")).borderRightWidth,
  ).toBe("0px");
});

// A selected pinned cell must still occlude horizontally scrolled content.
it("keeps a selected pinned cell's surface opaque", async () => {
  await page.viewport(1440, 900);
  const { result } = renderHook(() =>
    useCubbyTable({
      data,
      columns,
      getRowId: (row) => row.id,
      initialState: { columnPinning: { start: ["name"], end: [] } },
    }),
  );
  act(() =>
    result.current.selectCellRange({
      anchorRowId: "synthetic-row",
      anchorColumnId: "name",
      focusRowId: "synthetic-row",
      focusColumnId: "name",
    }),
  );
  render(
    <table>
      <tbody>
        <DesktopDataRow
          row={result.current.getRow("synthetic-row")}
          rowIndex={0}
          isSelected={false}
          isCurrent={false}
          isExpanded={false}
          isFocused={false}
          isDebugEnabled={false}
          rowClassName=""
          cellClassName=""
          columnsKey="name"
        />
      </tbody>
    </table>,
  );
  const cell = screen.getByRole("cell");
  expect(cell.hasAttribute("data-cell-selected")).toBe(true);
  const color = getComputedStyle(cell).backgroundColor;
  // CSSOM can serialize rgb/oklab/color(): a slash denotes a translucent alpha.
  expect(color).not.toMatch(/\/\s*0?\.\d+\s*\)/);
  expect(color).not.toMatch(/^rgba\([^)]*,\s*0?\.\d+\)$/);
});
