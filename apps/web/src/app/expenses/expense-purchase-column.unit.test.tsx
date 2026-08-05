import {
  unsafeExpenseShortcode,
  unsafePurchaseShortcode,
  unsafeVendorShortcode,
} from "@cubby/schemas/identifiers";
import type { ExpenseOut } from "@cubby/schemas/project";
import { createColumnHelper } from "@tanstack/react-table";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    params,
    className,
  }: {
    children?: ReactNode;
    params?: { shortcode?: string };
    className?: string;
  }) => (
    <a
      href={`/purchases/${params?.shortcode ?? "missing"}`}
      className={className}
    >
      {children}
    </a>
  ),
}));

vi.mock("~/lib/wasm", () => ({
  wasm: {
    format_amount: () => "",
    is_valid_unit: () => true,
    amount_kind: () => "volume",
  },
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { expenseVendorColumn } from "~/app/projects/shared";

const LINKED: ExpenseOut = {
  id: unsafeExpenseShortcode("EXP-4K7M"),
  name: "Dust extractor",
  cost: 500,
  date: "2026-07-20",
  lineKind: "principal",
  lineBasis: "item_line",
  costType: "tools",
  trade: "other",
  url: null,
  notes: null,
  future: false,
  projectId: null,
  projectName: null,
  productId: null,
  productQuantity: null,
  productName: null,
  purchaseId: unsafePurchaseShortcode("PUR-4K7M"),
  purchaseDate: "2026-07-19",
  purchaseDisplayLabel: null,
  vendorId: unsafeVendorShortcode("VEN-4K7M"),
  vendor: "Tool Shop",
  orderId: "ORDER-42",
  orderUrl: null,
  createdAt: new Date("2026-07-20T00:00:00Z"),
  updatedAt: new Date("2026-07-20T00:00:00Z"),
};

const renderCell = (expense: ExpenseOut) => {
  const column = expenseVendorColumn(
    createColumnHelper<ExpenseOut>(),
    vi.fn(async () => undefined),
    { asPurchase: true },
  );
  if (typeof column.cell !== "function")
    throw new Error("expected cell renderer");
  return render(
    column.cell({
      row: { original: expense },
      getValue: () => expense.vendor,
    } as never),
  );
};

describe("expenses Purchase column", () => {
  it("keeps purchase navigation separate from the vendor edit pencil", () => {
    renderCell(LINKED);

    const link = screen.getByRole("link", { name: "ORDER-42" });
    const pencil = screen.getByRole("button", { name: "Edit vendor" });
    expect(link.getAttribute("href")).toBe("/purchases/PUR-4K7M");
    expect(link.contains(pencil)).toBe(false);
  });

  it("shows an empty value with an edit affordance when unattached", () => {
    renderCell({
      ...LINKED,
      purchaseId: null,
      purchaseDate: null,
      vendorId: null,
      vendor: null,
      orderId: null,
    });

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("(none)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit vendor" })).toBeTruthy();
  });
});
