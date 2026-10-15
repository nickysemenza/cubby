import { act, render, renderHook, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { page } from "vitest/browser";

import { DesktopDataRow } from "./desktop-data-row";
import { createCubbyColumnHelper, useCubbyTable } from "./table-features";

const helper = createCubbyColumnHelper<{ id: string; name: string }>();
const columns = helper.columns([
  helper.accessor("name", { header: "Name", size: 140 }),
]);
const data = [{ id: "synthetic-row", name: "Example record" }];

it("retains a stronger pinned boundary than interior column rules", async () => {
  await page.viewport(1440, 900);
  render(
    <>
      <div
        data-testid="boundary-reference"
        style={{ borderRight: "1px solid var(--brand-hairline)" }}
      />
      <table className="table-grid-lines">
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
  expect(pinned).not.toBe(
    getComputedStyle(screen.getByTestId("interior-rule")).borderRightColor,
  );
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
