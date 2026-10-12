import { act, render, renderHook, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { page } from "vitest/browser";

import { DesktopDataRow } from "./DesktopDataRow";
import { createCubbyColumnHelper, useCubbyTable } from "./table-features";

const helper = createCubbyColumnHelper<{ id: string; name: string }>();
const columns = helper.columns([
  helper.accessor("name", { header: "Name", size: 140 }),
]);
const data = [{ id: "synthetic-row", name: "Example record" }];

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
