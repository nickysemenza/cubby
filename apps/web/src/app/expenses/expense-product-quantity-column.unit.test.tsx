import {
  unsafeExpenseShortcode,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import type { ExpenseOut } from "@cubby/schemas/project";
import { createColumnHelper } from "@tanstack/react-table";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ColumnCellData } from "~/app/_components/data-table/cell-data";

vi.mock("~/lib/wasm", () => ({
  wasm: {
    format_amount: () => "",
    is_valid_unit: () => true,
    amount_kind: () => "volume",
  },
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { expenseProductQuantityColumn } from "~/app/projects/shared";

const EXPENSE: ExpenseOut = {
  id: unsafeExpenseShortcode("EXP-4K7M"),
  name: "Box of fasteners",
  cost: 20,
  date: "2026-07-20",
  lineKind: "principal",
  costType: "materials",
  trade: "other",
  url: null,
  notes: null,
  future: false,
  projectId: null,
  projectName: null,
  productId: unsafeProductShortcode("PRD-4K7M"),
  productQuantity: 2,
  productName: "Fasteners",
  purchaseId: null,
  purchaseDate: null,
  purchaseDisplayLabel: null,
  vendorId: null,
  vendor: null,
  orderId: null,
  orderUrl: null,
  createdAt: new Date("2026-07-20T00:00:00Z"),
  updatedAt: new Date("2026-07-20T00:00:00Z"),
};

const buildColumn = (save = vi.fn(async () => undefined)) => ({
  column: expenseProductQuantityColumn(createColumnHelper<ExpenseOut>(), save),
  save,
});

const renderCell = (
  expense: ExpenseOut,
  save = vi.fn(async () => undefined),
) => {
  const { column } = buildColumn(save);
  if (typeof column.cell !== "function")
    throw new Error("expected cell renderer");
  render(
    column.cell({
      row: { original: expense },
      getValue: () => expense.productQuantity,
    } as never),
  );
  return save;
};

describe("Expense Quantity inline editor", () => {
  it("is read-only until a Product is linked", () => {
    renderCell({
      ...EXPENSE,
      productId: null,
      productName: null,
      productQuantity: null,
    });

    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("uses whole-unit input and allows clearing an evidenced quantity", async () => {
    const save = renderCell(EXPENSE);
    fireEvent.click(screen.getByRole("button"));

    const input = await screen.findByRole("spinbutton");
    expect(input.getAttribute("step")).toBe("1");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(save).toHaveBeenCalledWith(null, EXPENSE));
  });

  it.each([0, -1, 1.5])("rejects an invalid quantity of %s", async (value) => {
    const { column, save } = buildColumn();
    const cellData = column.meta?.cellData as ColumnCellData<ExpenseOut>;

    await expect(
      cellData.applyPaste?.(EXPENSE, { json: value }),
    ).rejects.toThrow("positive whole number");
    expect(save).not.toHaveBeenCalled();
  });
});
