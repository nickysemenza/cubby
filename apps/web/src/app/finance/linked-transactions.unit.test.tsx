import { financialTransactionListResponse } from "@cubby/schemas/financial-transaction";
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { entityListFor } from "~/entities/entity-list.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  type LinkedTransactionsOperations,
  LinkedTransactions,
} from "./linked-transactions";

const transactionList = entityListFor("financialTransaction");
const linkedTransactionResponse = financialTransactionListResponse.parse({
  items: [
    {
      id: "FTX-2345",
      accountId: "FAC-2345",
      purchaseId: null,
      kind: "purchase",
      status: "posted",
      amount: 42.5,
      transactionDate: "2026-08-16",
      postedDate: "2026-08-16",
      merchant: "Neighborhood Market",
      rawDescription: null,
      sourceCategory: null,
      sourceRefs: [],
      notes: null,
      allocations: [],
      ledgerTransferId: null,
      accountName: "Household Card",
      createdAt: new Date("2026-08-16T00:00:00.000Z"),
      updatedAt: new Date("2026-08-16T00:00:00.000Z"),
    },
  ],
  meta: { pageIndex: 0, pageSize: 100, totalCount: 1 },
});

const operations: LinkedTransactionsOperations = {
  list: (params) => ({
    ...transactionList.queryOptions(params),
    queryFn: async () => linkedTransactionResponse,
  }),
};

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

describe("LinkedTransactions", () => {
  it("keeps every fixed-layout column readable and renders shared status labels", async () => {
    render(
      <LinkedTransactions accountId="FAC-2345" operations={operations} />,
      {
        wrapper: harness.wrapper,
      },
    );

    expect(
      await screen.findByRole("columnheader", { name: "Transaction" }),
    ).toHaveClass("w-40");
    expect(screen.getByRole("columnheader", { name: "Account" })).toHaveClass(
      "w-32",
    );
    expect(screen.getByRole("columnheader", { name: "Status" })).toHaveClass(
      "w-24",
    );
    expect(screen.getByRole("columnheader", { name: "Posted" })).toHaveClass(
      "w-24",
    );
    expect(screen.getByRole("columnheader", { name: "Amount" })).toHaveClass(
      "w-36",
      "text-right",
    );

    const transactionLink = screen.getByRole("link", {
      name: "Neighborhood Market",
    });
    expect(transactionLink).toHaveAttribute(
      "href",
      "/financial-transactions/FTX-2345",
    );
    expect(transactionLink).toHaveClass("block", "truncate");
    expect(transactionLink).toHaveAttribute("title", "Neighborhood Market");

    const accountLink = screen.getByRole("link", { name: "Household Card" });
    expect(accountLink).toHaveAttribute("href", "/financial-accounts/FAC-2345");
    const row = transactionLink.closest("tr");
    if (!row) throw new Error("Expected transaction row");
    const statusCell = within(row).getAllByRole("cell")[2];
    expect(statusCell).toHaveTextContent("Posted");
    expect(statusCell).not.toHaveTextContent(/^posted$/);
  });
});
