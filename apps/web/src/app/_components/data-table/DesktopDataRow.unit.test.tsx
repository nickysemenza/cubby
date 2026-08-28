import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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
      isCurrent: false,
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

  it("uses pointer and keyboard intent but does not speculate on touch", () => {
    const onRowClick = vi.fn();
    const onRowHover = vi.fn();
    const onRowHoverEnd = vi.fn();
    const row = {
      id: "row-1",
      original: { id: "PRD-4K7M" },
      getIsSelected: () => false,
      getIsExpanded: () => false,
      getStartVisibleCells: () => [],
      getCenterVisibleCells: () => [],
      getEndVisibleCells: () => [],
    } as unknown as Row<TestRow>;
    render(
      <table>
        <tbody>
          <DesktopDataRow
            row={row}
            rowIndex={0}
            isSelected={false}
            isCurrent={false}
            isExpanded={false}
            isFocused={false}
            isDebugEnabled={false}
            onRowClick={onRowClick}
            onRowHover={onRowHover}
            onRowHoverEnd={onRowHoverEnd}
            rowClassName=""
            cellClassName=""
            columnsKey=""
          />
        </tbody>
      </table>,
    );

    const renderedRow = screen.getByRole("row");
    fireEvent.pointerEnter(renderedRow, { pointerType: "mouse" });
    fireEvent.pointerLeave(renderedRow, { pointerType: "mouse" });
    fireEvent.focus(renderedRow);
    fireEvent.blur(renderedRow);
    fireEvent.pointerEnter(renderedRow, { pointerType: "touch" });
    fireEvent.pointerLeave(renderedRow, { pointerType: "touch" });
    fireEvent.click(renderedRow);

    expect(onRowHover).toHaveBeenCalledTimes(2);
    expect(onRowHoverEnd).toHaveBeenCalledTimes(2);
    expect(onRowClick).toHaveBeenCalledOnce();
  });

  it("marks the inspector's current record without changing bulk selection", () => {
    const row = {
      id: "row-current",
      original: { id: "PRD-CURRENT" },
      getIsSelected: () => false,
      getIsExpanded: () => false,
      getStartVisibleCells: () => [],
      getCenterVisibleCells: () => [],
      getEndVisibleCells: () => [],
    } as unknown as Row<TestRow>;

    render(
      <table>
        <tbody>
          <DesktopDataRow
            row={row}
            rowIndex={0}
            isSelected={false}
            isCurrent
            isExpanded={false}
            isFocused={false}
            isDebugEnabled={false}
            rowClassName=""
            cellClassName=""
            columnsKey=""
          />
        </tbody>
      </table>,
    );

    const renderedRow = screen.getByRole("row");
    expect(renderedRow).toHaveAttribute("data-current", "true");
    expect(renderedRow).toHaveAttribute("aria-current", "true");
    expect(renderedRow).not.toHaveAttribute("data-state", "selected");
  });
});
