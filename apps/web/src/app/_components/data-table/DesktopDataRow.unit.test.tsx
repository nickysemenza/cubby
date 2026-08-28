import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DesktopDataRow, type DesktopDataRowProps } from "./DesktopDataRow";
import type { CubbyRow as Row } from "./table-features";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  materializeCubbyColumns,
  useCubbyTable,
} from "./table-features";

interface TestRow {
  id: string;
}

const columnHelper = createCubbyColumnHelper<TestRow>();

function useTestTable(cell?: () => string) {
  const columns = createCubbyColumnCollection<TestRow>((add) => {
    add(
      columnHelper.accessor("id", {
        id: "related:product.vendors",
        header: "Vendors",
        cell,
      }),
    );
  });
  return useCubbyTable({
    data: [{ id: "PRD-TEST" }],
    columns: materializeCubbyColumns(columns),
    getRowId: (row) => row.id,
  });
}

type RowOverrides = Partial<Omit<DesktopDataRowProps<TestRow>, "row">>;

function desktopRowProps(row: Row<TestRow>, overrides: RowOverrides = {}) {
  return {
    row,
    rowIndex: 0,
    isSelected: false,
    isCurrent: false,
    isExpanded: false,
    isFocused: false,
    isDebugEnabled: false,
    rowClassName: "",
    cellClassName: "",
    columnsKey: "",
    ...overrides,
  };
}

describe("DesktopDataRow", () => {
  it("re-renders memoized cells when external row content changes", () => {
    let preview = "…";
    const { result } = renderHook(() => useTestTable(() => preview));
    const row = result.current.getRow("PRD-TEST");
    const props = desktopRowProps(row, {
      columnsKey: "related:product.vendors",
    });
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
    const { result } = renderHook(() => useTestTable());
    const row = result.current.getRow("PRD-TEST");
    render(
      <table>
        <tbody>
          <DesktopDataRow
            {...desktopRowProps(row, {
              onRowClick,
              onRowHover,
              onRowHoverEnd,
            })}
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
    const { result } = renderHook(() => useTestTable());
    const row = result.current.getRow("PRD-TEST");

    render(
      <table>
        <tbody>
          <DesktopDataRow {...desktopRowProps(row, { isCurrent: true })} />
        </tbody>
      </table>,
    );

    const renderedRow = screen.getByRole("row");
    expect(renderedRow).toHaveAttribute("data-current", "true");
    expect(renderedRow).toHaveAttribute("aria-current", "true");
    expect(renderedRow).not.toHaveAttribute("data-state", "selected");
  });
});
