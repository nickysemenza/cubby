import type { ExpenseOut } from "@cubby/schemas/project";
import { testCompleteDataQuality, testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { createCubbyColumnHelper } from "~/app/_components/data-table/table-features";
import { expenseProductQuantityColumn } from "~/app/projects/shared";

const EXPENSE: ExpenseOut = {
  id: testShortcode("expense", "EXP-4K7M"),
  name: "Box of fasteners",
  cost: 20,
  date: "2026-07-20",
  lineKind: "principal",
  lineBasis: "item_line",
  costType: "materials",
  trade: "other",
  url: null,
  notes: null,
  future: false,
  projectId: null,
  projectName: null,
  productId: testShortcode("product", "PRD-4K7M"),
  productQuantity: 2,
  productName: "Fasteners",
  purchaseId: null,
  purchaseDate: null,
  purchaseDisplayLabel: null,
  vendorId: null,
  vendorLogo: null,
  vendor: null,
  orderId: null,
  orderUrl: null,
  beneficiaries: [],
  funders: [],
  sourceClaims: [],
  dataQuality: testCompleteDataQuality(),
  createdAt: new Date("2026-07-20T00:00:00Z"),
  updatedAt: new Date("2026-07-20T00:00:00Z"),
};

const buildColumn = (save = vi.fn(async () => undefined)) => ({
  column: expenseProductQuantityColumn(
    createCubbyColumnHelper<ExpenseOut>(),
    save,
  ),
  save,
});

function isExpenseQuantityRenderer(
  cell: ReturnType<typeof buildColumn>["column"]["cell"],
): cell is (context: {
  row: { original: ExpenseOut };
  getValue: () => number | null;
}) => ReactNode {
  return typeof cell === "function";
}

const renderCell = (
  expense: ExpenseOut,
  save = vi.fn(async () => undefined),
) => {
  const { column } = buildColumn(save);
  if (!isExpenseQuantityRenderer(column.cell)) {
    throw new Error("Expected an expense quantity cell renderer.");
  }
  render(
    column.cell({
      row: { original: expense },
      getValue: () => expense.productQuantity,
    }),
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

  it("uses fractional input and allows clearing an evidenced quantity", async () => {
    const save = renderCell(EXPENSE);
    fireEvent.click(screen.getByRole("button"));

    const input = await screen.findByRole("spinbutton");
    // `step="1"` would make the browser reject 0.5 on a field whose unit is the
    // shelf's unit — see the fractional-quantity note on Expense.productQuantity.
    expect(input.getAttribute("step")).toBe("any");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(save).toHaveBeenCalledWith(null, EXPENSE));
  });

  // Fractional since 2026-08-22. The unit is the shelf's unit, and
  // `InventoryEntry.amount` has always been divisible — half a coil binned is
  // -0.5. This editor gates every inline quantity edit in the app, so a
  // whole-number rule here would make fractional rows uneditable everywhere.
  it("accepts a fractional quantity", async () => {
    const { column, save } = buildColumn();
    const cellData = column.meta?.cellData;
    if (!cellData) throw new Error("expected cell data");

    await cellData.applyPaste?.(EXPENSE, { json: 1.5 });
    expect(save).toHaveBeenCalledWith(1.5, EXPENSE);
  });

  it("still refuses a quantity on a row with no linked Product", async () => {
    const { column, save } = buildColumn();
    const cellData = column.meta?.cellData;
    if (!cellData) throw new Error("expected cell data");

    await expect(
      cellData.applyPaste?.({ ...EXPENSE, productId: null }, { json: 2 }),
    ).rejects.toThrow("Link a product");
    expect(save).not.toHaveBeenCalled();
  });

  // Zero is legal on a refund line — money back, no unit moved. This editor
  // cannot see the row's cost, so it must pass zero through and let
  // `assertQuantitySignMatchesCost` reject it where the cost contradicts it;
  // a `!== 0` rule here would make every price concession uneditable.
  it("accepts a quantity of zero", async () => {
    const { column, save } = buildColumn();
    const cellData = column.meta?.cellData;
    if (!cellData) throw new Error("expected cell data");

    await cellData.applyPaste?.(EXPENSE, { json: 0 });
    expect(save).toHaveBeenCalledWith(0, EXPENSE);
  });

  // `productQuantity` is signed: a negative quantity on a $0 line is a discard.
  // This editor gates every inline quantity edit in the app, so rejecting one
  // here would make discards uneditable everywhere.
  it("accepts a negative quantity", async () => {
    const { column, save } = buildColumn();
    const cellData = column.meta?.cellData;
    if (!cellData) throw new Error("expected cell data");

    await cellData.applyPaste?.(EXPENSE, { json: -1 });
    expect(save).toHaveBeenCalledWith(-1, EXPENSE);
  });
});
