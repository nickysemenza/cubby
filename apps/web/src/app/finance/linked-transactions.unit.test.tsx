import { financialTransactionListResponse } from "@cubby/schemas/financial-transaction";
import { testCompleteDataQuality } from "@cubby/schemas/testing";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { entityListFor } from "~/entities/entity-list.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  type LinkedTransactionsOperations,
  LinkedTransactions,
} from "./linked-transactions";

const transactionList = entityListFor("financialTransaction");

function transactionResponse({
  allocations = [],
}: {
  allocations?: Array<{ purchaseId: string; amount: number }>;
} = {}) {
  return financialTransactionListResponse.parse({
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
        displayName: "Neighborhood Market",
        rawDescription: null,
        sourceCategory: null,
        sourceRefs: [],
        notes: null,
        allocations,
        ledgerTransferId: null,
        accountName: "Household Card",
        createdAt: new Date("2026-08-16T00:00:00.000Z"),
        updatedAt: new Date("2026-08-16T00:00:00.000Z"),
        dataQuality: testCompleteDataQuality(),
      },
    ],
    meta: { pageIndex: 0, pageSize: 100, totalCount: 1 },
  });
}

function operationsFor(response: ReturnType<typeof transactionResponse>) {
  return {
    list: (params) => ({
      ...transactionList.listQueryPlan(params),
      execute: async () => response,
    }),
  } satisfies LinkedTransactionsOperations;
}

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

describe("LinkedTransactions", () => {
  it("uses the embedded list contract and omits redundant account context", async () => {
    const operations = operationsFor(transactionResponse());
    const list = vi.fn(operations.list);
    render(<LinkedTransactions accountId="FAC-2345" operations={{ list }} />, {
      wrapper: harness.wrapper,
    });

    await screen.findByRole("columnheader", {
      name: /^Financial transaction/i,
    });
    expect(screen.queryByRole("columnheader", { name: "Account" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Vendor" })).toBeNull();
    for (const name of ["Status", "Posted date", "Amount"])
      expect(screen.getByRole("columnheader", { name })).toBeInTheDocument();

    const transactionLink = await screen.findByRole("link", {
      name: "Neighborhood Market",
    });
    expect(transactionLink).toHaveAttribute(
      "href",
      "/financial-transactions/FTX-2345",
    );
    expect(transactionLink).toHaveClass("font-medium", "text-foreground");
    const row = transactionLink.closest("tr");
    expect(row).not.toBeNull();
    const statusCell = within(row!).getByText("Posted").closest("td");
    expect(statusCell).not.toBeNull();
    expect(statusCell).toHaveTextContent("Posted");
    expect(statusCell?.textContent?.replace(/\s+/g, " ").trim()).not.toMatch(
      /^posted$/,
    );
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        sort: [{ orderBy: "postedDate", direction: "desc" }],
      }),
    );
  });

  it("keeps account comparison and the allocated purchase slice", async () => {
    render(
      <LinkedTransactions
        purchaseId="PUR-2345"
        operations={operationsFor(
          transactionResponse({
            allocations: [
              { purchaseId: "PUR-2345", amount: 20 },
              { purchaseId: "PUR-9999", amount: 22.5 },
            ],
          }),
        )}
      />,
      { wrapper: harness.wrapper },
    );

    expect(
      await screen.findByRole("columnheader", { name: /^Account/ }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("link", { name: "Household Card" }),
    ).toHaveAttribute("href", "/financial-accounts/FAC-2345");
    expect(screen.getByText("$20.00")).toBeInTheDocument();
    expect(screen.getByText("of $42.50")).toBeInTheDocument();
  });

  it("offers add and edit actions for a purchase settlement", async () => {
    const onAddTransaction = vi.fn();
    const onEditTransaction = vi.fn();
    render(
      <LinkedTransactions
        purchaseId="PUR-2345"
        operations={operationsFor(transactionResponse())}
        onAddTransaction={onAddTransaction}
        onEditTransaction={onEditTransaction}
      />,
      { wrapper: harness.wrapper },
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Add transaction" }),
    );
    expect(onAddTransaction).toHaveBeenCalledOnce();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Edit Neighborhood Market",
      }),
    );
    expect(onEditTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "FTX-2345" }),
    );

    const postedCell = screen
      .getAllByText("Posted")
      .map((element) => element.closest("td"))
      .find((element) => element !== null);
    expect(postedCell).toBeDefined();
    expect(within(postedCell!).getByRole("button")).toBeInTheDocument();
  });
});
