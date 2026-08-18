import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DesktopDataRow } from "./DesktopDataRow";
import type { CubbyRow as Row } from "./table-features";

interface TestRow {
  id: string;
}

describe("DesktopDataRow", () => {
  it("re-renders memoized cells when external row content changes", () => {
    let preview = "…";
    const cell = {
      id: "related:product.vendors",
      column: {
        id: "related:product.vendors",
        columnDef: { cell: () => preview, meta: {} },
        getIsPinned: () => false,
        getSize: () => 256,
      },
      getContext: () => ({
        table: {
          getStartVisibleLeafColumns: () => [],
          getEndVisibleLeafColumns: () => [],
        },
      }),
      getIsSelected: () => false,
      getCanSelect: () => true,
      getIsFocused: () => false,
      getTabIndex: () => -1,
      getSelectionStartHandler: () => undefined,
      getSelectionExtendHandler: () => undefined,
    };
    const row = {
      id: "row-1",
      original: { id: "PRD-TEST" },
      getIsSelected: () => false,
      getIsExpanded: () => false,
      getStartVisibleCells: () => [],
      getCenterVisibleCells: () => [cell],
      getEndVisibleCells: () => [],
    } as unknown as Row<TestRow>;
    const props = {
      row,
      rowIndex: 0,
      isSelected: false,
      isExpanded: false,
      isFocused: false,
      isDebugEnabled: false,
      rowClassName: "",
      cellClassName: "",
      columnsKey: "related:product.vendors",
    };
    const { rerender } = render(
      <table>
        <tbody>
          <DesktopDataRow {...props} rowContentVersion={{}} />
        </tbody>
      </table>,
    );

    expect(screen.getByText("…")).toBeInTheDocument();
    preview = "Moore Newton";
    rerender(
      <table>
        <tbody>
          <DesktopDataRow {...props} rowContentVersion={{}} />
        </tbody>
      </table>,
    );
    expect(screen.getByText("Moore Newton")).toBeInTheDocument();
  });
});
