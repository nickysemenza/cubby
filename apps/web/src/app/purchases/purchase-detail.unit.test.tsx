import { purchaseOut } from "@cubby/schemas/purchase";
import { testShortcode } from "@cubby/schemas/testing";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { PurchaseDetail } from "./purchase-detail";

const purchase = purchaseOut.parse({
  id: testShortcode("purchase", "PUR-TEST"),
  vendorId: testShortcode("vendor", "VEN-TEST"),
  orderId: "ORDER-123",
  displayLabel: "Fixture purchase",
  date: "2026-01-02",
  statedTotal: 42,
  notes: "Fixture notes",
  vendorName: "Fixture vendor",
  vendorLogo: null,
  orderUrl: "https://example.test/orders/ORDER-123",
  expenseCount: 1,
  unpricedExpenseCount: 0,
  expenseTotal: 42,
  reconciliation: "match",
  financialReconciliation: {
    status: "unknown",
    transactionCount: 0,
    postedTransactionCount: 0,
    outstandingTransactionCount: 0,
    postedTotal: 0,
    projectedTotal: 0,
    postedRefundTotal: 0,
    delta: null,
  },
  documentCount: 0,
  images: [],
  dataQuality: {
    status: "complete",
    facets: [],
    gaps: [],
    exceptions: [],
    relatedGaps: [],
    relatedExceptions: [],
  },
  displayName: "Fixture purchase",
  createdAt: new Date("2026-01-02"),
  updatedAt: new Date("2026-01-02"),
});

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => {
  harness.dispose();
});

describe("Purchase detail display declaration", () => {
  it("preserves overview labels, order links and the vendor cohort action", () => {
    const { container } = render(<PurchaseDetail record={purchase} />, {
      wrapper: harness.wrapper,
    });
    expect(
      Array.from(
        container.querySelectorAll(".basic-info-ledger .eyebrow"),
        (element) => element.textContent,
      ),
    ).toEqual([
      "Vendor",
      "Order #",
      "Display label",
      "Date",
      "Stated total",
      "Notes",
    ]);
    expect(
      screen.getByRole("link", {
        name: "Show all purchases from Fixture vendor",
      }),
    ).toHaveAttribute("href", "/purchases?vendor=VEN-TEST");
    expect(screen.getByRole("link", { name: /order/i })).toHaveAttribute(
      "href",
      purchase.orderUrl,
    );
  });
});
