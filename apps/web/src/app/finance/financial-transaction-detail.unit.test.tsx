import { financialTransactionOut } from "@cubby/schemas/financial-transaction";
import { testShortcode } from "@cubby/schemas/testing";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { FinancialTransactionDetail } from "./financial-transaction-detail";

const transaction = financialTransactionOut.parse({
  id: testShortcode("financialTransaction", "FTX-4K7M"),
  accountId: testShortcode("financialAccount", "FAC-4K7M"),
  purchaseId: null,
  kind: "purchase",
  status: "posted",
  amount: 42,
  transactionDate: "2026-01-02",
  postedDate: "2026-01-03",
  merchant: "Fixture Market",
  rawDescription: "Fixture Market purchase",
  sourceCategory: null,
  sourceRefs: [{ source: "fixture", externalId: "row-1" }],
  notes: null,
  allocations: [
    { purchaseId: testShortcode("purchase", "PUR-4K7M"), amount: 20 },
    { purchaseId: testShortcode("purchase", "PUR-7M4K"), amount: 22 },
  ],
  ledgerTransferId: null,
  accountName: "Fixture checking",
  vendorInference: null,
  displayName: "Fixture Market",
  createdAt: new Date("2026-01-03"),
  updatedAt: new Date("2026-01-03"),
});

describe("FinancialTransactionDetail", () => {
  let harness: ReturnType<typeof createBrowserTestHarness>;
  beforeEach(() => {
    harness = createBrowserTestHarness();
  });
  afterEach(() => harness.dispose());

  it("renders multi-allocation overview fields and purchase filters", () => {
    render(<FinancialTransactionDetail transaction={transaction} />, {
      wrapper: harness.wrapper,
    });
    expect(screen.getByText("Settles")).toBeVisible();
    expect(screen.getByText("Source")).toBeVisible();
    expect(screen.queryByText("Statement description")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "PUR-4K7M" })).toHaveAttribute(
      "href",
      "/purchases/PUR-4K7M",
    );
    expect(
      screen.getByRole("link", {
        name: /Show all transactions allocated to PUR-4K7M/,
      }),
    ).toHaveAttribute("href", "/financial-transactions?purchaseId=PUR-4K7M");
  });
});
