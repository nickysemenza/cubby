import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { createPortal } from "react-dom";
import { describe, expect, it } from "vitest";

import { createCubbyColumnHelper, useCubbyTable } from "./table-features";
import { useCellSelection } from "./useCellSelection";

interface TestRow {
  id: string;
  alpha: string;
  beta: string;
  gamma: string;
}

const helper = createCubbyColumnHelper<TestRow>();
const columns = helper.columns([
  helper.accessor("alpha", { id: "alpha", header: "Alpha" }),
  helper.accessor("beta", { id: "beta", header: "Beta" }),
  helper.accessor("gamma", { id: "gamma", header: "Gamma" }),
]);
const data: TestRow[] = [
  { id: "row-a", alpha: "A1", beta: "B1", gamma: "G1" },
  { id: "row-b", alpha: "A2", beta: "B2", gamma: "G2" },
];
const noopScroll = () => undefined;

describe("useCellSelection", () => {
  it("derives clipboard coordinates in pinned display order", () => {
    const { result } = renderHook(() => {
      const table = useCubbyTable({
        data,
        columns,
        getRowId: (row) => row.id,
        initialState: {
          columnPinning: { start: ["gamma"], end: [] },
        },
      });
      const selection = useCellSelection({
        enabled: true,
        rows: table.getRowModel().rows,
        table,
        scrollToFlatRow: noopScroll,
      });
      return { selection, table };
    });

    act(() => {
      result.current.table.selectCellRange({
        anchorRowId: "row-a",
        anchorColumnId: "gamma",
        focusRowId: "row-b",
        focusColumnId: "alpha",
      });
    });

    expect(result.current.table.atoms.cellSelection?.get()).toHaveLength(1);
    expect(result.current.selection.getSelection()).toEqual({
      anchor: { row: 0, col: 0 },
      focus: { row: 1, col: 1 },
    });
  });

  // Regression: React bubbles keys from portaled descendants (the bulk-edit
  // dialog opened from this table) through the container's onKeyDown, so with
  // a cell selected, Space in the dialog opened a cell editor and never
  // pressed the dialog's button (CI: "Date unknown" stayed unpressed).
  it.each([" ", "Enter", "x"])(
    "leaves %j alone when it comes from a portaled dialog",
    (key) => {
      let selectCell = () => {};
      function Harness() {
        const table = useCubbyTable({
          data,
          columns,
          getRowId: (row) => row.id,
        });
        const selection = useCellSelection({
          enabled: true,
          rows: table.getRowModel().rows,
          table,
          scrollToFlatRow: noopScroll,
        });
        selectCell = () =>
          table.selectCellRange({
            anchorRowId: "row-a",
            anchorColumnId: "alpha",
            focusRowId: "row-a",
            focusColumnId: "alpha",
          });
        return (
          <div data-testid="table" {...selection.containerProps}>
            {createPortal(
              <button type="button">Date unknown</button>,
              document.body,
            )}
          </div>
        );
      }
      render(<Harness />);
      act(() => selectCell());
      const button = screen.getByRole("button", { name: "Date unknown" });
      expect(fireEvent.keyDown(button, { key })).toBe(true);
      // The table's own keys still work when they come from inside it.
      expect(fireEvent.keyDown(screen.getByTestId("table"), { key })).toBe(
        key === "Escape",
      );
    },
  );
});
