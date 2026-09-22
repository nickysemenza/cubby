import type { ExpenseOut } from "@cubby/schemas/project";
import { testCompleteDataQuality, testShortcode } from "@cubby/schemas/testing";
import { render, screen } from "@testing-library/react";
import { useMemo } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import RTable from "~/app/_components/data-table/Table";
import {
  createCubbyColumnHelper,
  useCubbyTable,
} from "~/app/_components/data-table/table-features";
import { expenseVendorColumn } from "~/app/projects/shared";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

const LINKED: ExpenseOut = {
  id: testShortcode("expense", "EXP-4K7M"),
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
  purchaseId: testShortcode("purchase", "PUR-4K7M"),
  purchaseDate: "2026-07-19",
  purchaseDisplayLabel: null,
  vendorId: testShortcode("vendor", "VEN-4K7M"),
  vendorLogo: null,
  vendor: "Tool Shop",
  orderId: "ORDER-42",
  orderUrl: null,
  beneficiaries: [],
  funders: [],
  sourceClaims: [],
  dataQuality: testCompleteDataQuality(),
  createdAt: new Date("2026-07-20T00:00:00Z"),
  updatedAt: new Date("2026-07-20T00:00:00Z"),
};

const helper = createCubbyColumnHelper<ExpenseOut>();

function ExpensePurchaseCell({ expense }: { expense: ExpenseOut }) {
  const columns = useMemo(
    () =>
      helper.columns([
        expenseVendorColumn(helper, async () => undefined, {
          asPurchase: true,
        }),
      ]),
    [],
  );
  const table = useCubbyTable({
    data: [expense],
    columns,
    getRowId: (row) => row.id,
  });
  return <RTable table={table} ariaLabel="Expense purchase" />;
}

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

const renderCell = (expense: ExpenseOut) =>
  render(<ExpensePurchaseCell expense={expense} />, {
    wrapper: harness.wrapper,
  });

describe("expenses Purchase column", () => {
  it("keeps purchase navigation separate from the vendor edit pencil", async () => {
    renderCell(LINKED);

    const link = await screen.findByRole("link", { name: "ORDER-42" });
    const pencil = screen.getByRole("button", { name: "Edit vendor" });
    expect(link.getAttribute("href")).toBe("/purchases/PUR-4K7M");
    expect(link.contains(pencil)).toBe(false);
  });

  it("shows an empty value with an edit affordance when unattached", async () => {
    renderCell({
      ...LINKED,
      purchaseId: null,
      purchaseDate: null,
      vendorId: null,
      vendor: null,
      orderId: null,
    });

    expect(await screen.findByText("(none)")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit vendor" })).toBeTruthy();
  });
});
