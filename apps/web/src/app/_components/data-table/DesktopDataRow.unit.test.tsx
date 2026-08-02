import type { Row } from "@tanstack/react-table";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DesktopDataRow } from "./DesktopDataRow";

interface TestRow {
  id: string;
}

describe("DesktopDataRow", () => {
  it("re-renders memoized cells when external row content changes", () => {
    let preview = "…";
    const row = {
      id: "row-1",
      original: { id: "PRD-TEST" },
      getIsSelected: () => false,
      getIsExpanded: () => false,
      getVisibleCells: () => [
        {
          id: "related:product.vendors",
          column: {
            id: "related:product.vendors",
            columnDef: { cell: () => preview, meta: {} },
          },
          getContext: () => ({}),
        },
      ],
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
