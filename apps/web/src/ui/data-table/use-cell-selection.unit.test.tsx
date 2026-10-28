import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { createPortal } from "react-dom";
import { Toaster, toast } from "sonner";
import { describe, expect, it, vi } from "vitest";

import { textCellData, type PasteFieldValues } from "./cell-data";
import { createCubbyColumnHelper, useCubbyTable } from "./table-features";
import { attachCubbyColumnMeta } from "./table-meta";
import { useCellSelection } from "./use-cell-selection";

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

    render(
      <section
        aria-label="Copy table"
        {...result.current.selection.containerProps}
      >
        <span>Selected receipt text</span>
      </section>,
    );
    // A previous table interaction can leave a collapsed browser range.
    window.getSelection()?.collapse(document.body, 0);
    const range = document.createRange();
    range.selectNodeContents(screen.getByText("Selected receipt text"));
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    expect(window.getSelection()?.toString()).toBe("Selected receipt text");
    // A retained cell range must not swallow the browser's text-copy gesture.
    expect(
      fireEvent.keyDown(screen.getByRole("region", { name: "Copy table" }), {
        key: "c",
        metaKey: true,
      }),
    ).toBe(true);
    window.getSelection()?.removeAllRanges();
  });

  it("retries only failed rows against their original identities after reordering", async () => {
    const saveCell = vi.fn(async () => {});
    const saveRow = vi.fn(
      async (_row: TestRow, _values: PasteFieldValues) => {},
    );
    saveRow.mockRejectedValueOnce(new Error("write refused"));
    const alpha = textCellData<TestRow>("text", (row) => row.alpha, saveCell);
    const beta = textCellData<TestRow>("text", (row) => row.beta, saveCell);
    alpha.rowWrite = { field: "alpha", save: saveRow };
    beta.rowWrite = { field: "beta", save: saveRow };
    const editableColumns = helper.columns([
      helper.accessor("alpha", {
        id: "alpha",
        meta: attachCubbyColumnMeta({ cellData: alpha }),
      }),
      helper.accessor("beta", {
        id: "beta",
        meta: attachCubbyColumnMeta({ cellData: beta }),
      }),
    ]);
    let selectCell = () => {};
    function Harness({ rows }: { rows: TestRow[] }) {
      const table = useCubbyTable({
        data: rows,
        columns: editableColumns,
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
        <>
          <div data-testid="table" {...selection.containerProps} />
          <Toaster />
        </>
      );
    }
    const { rerender } = render(<Harness rows={data} />);
    act(() => selectCell());
    const container = screen.getByTestId("table");
    fireEvent.mouseDown(container);
    fireEvent.paste(container, {
      clipboardData: { getData: () => "New A1\tNew B1\nNew A2\tNew B2" },
    });
    const retry = await screen.findByRole("button", {
      name: "Retry failed rows",
    });
    expect(saveRow).toHaveBeenCalledTimes(2);
    expect(saveCell).not.toHaveBeenCalled();
    expect(screen.getByText(/Row 1, alpha: write refused/)).toBeVisible();
    rerender(<Harness rows={[...data].reverse()} />);
    await act(async () => {
      fireEvent.click(retry);
    });
    expect(saveRow).toHaveBeenCalledTimes(3);
    expect(saveRow).toHaveBeenLastCalledWith(data[0], {
      alpha: "New A1",
      beta: "New B1",
    });
    act(() => {
      toast.dismiss();
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
