import { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { metadataQueryClient } from "#web/tests/entity-metadata.ts";
import { fieldValueFixture } from "~/entity/fields/field-envelope.fixtures";
import { entityReadFixture } from "~/entity/fields/field-envelope.fixtures";
import { getEntityListOutputSchema } from "~/server/generated/entity-lists.server.gen";
const financialTransactionListResponse = getEntityListOutputSchema(
  "financialTransaction",
);
import { testCompleteDataQuality } from "@cubby/schemas/testing";
import {
  cleanup,
  fireEvent,
  render as testingRender,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { entityListFor } from "~/entity/entity-list";
import { installFeatures } from "~/features/registry";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  type LinkedTransactionsOperations,
  LinkedTransactions,
} from "./linked-transactions";

let queryClient: Awaited<ReturnType<typeof metadataQueryClient>>;
beforeEach(async () => {
  queryClient = await metadataQueryClient();
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});

function MetadataProvider({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function render(ui: ReactNode, options?: Parameters<typeof testingRender>[1]) {
  const BrowserWrapper = options?.wrapper;
  return testingRender(ui, {
    ...options,
    wrapper: ({ children }) =>
      BrowserWrapper ? (
        <BrowserWrapper>
          <MetadataProvider>{children}</MetadataProvider>
        </BrowserWrapper>
      ) : (
        <MetadataProvider>{children}</MetadataProvider>
      ),
  });
}

installFeatures();

const transactionList = entityListFor("financialTransaction");

function transactionResponse({
  allocations = [],
}: {
  allocations?: Array<{ purchaseId: string; amount: number }>;
} = {}) {
  return financialTransactionListResponse.parse({
    items: [
      entityReadFixture(entityFieldEnvelopeSchemas.financialTransaction.list, {
        fields: {
          merchant: fieldValueFixture(
            entityFieldEnvelopeSchemas.financialTransaction.list.shape.fields
              .shape["merchant"],
            "Neighborhood Market",
          ),
          sourceRefs: fieldValueFixture(
            entityFieldEnvelopeSchemas.financialTransaction.list.shape.fields
              .shape["sourceRefs"],
            [],
          ),
          itemization: fieldValueFixture(
            entityFieldEnvelopeSchemas.financialTransaction.list.shape.fields
              .shape["itemization"],
            "bare",
          ),
          bookingCoverage: fieldValueFixture(
            entityFieldEnvelopeSchemas.financialTransaction.list.shape.fields
              .shape["bookingCoverage"],
            "missing",
          ),
          documentCoverage: fieldValueFixture(
            entityFieldEnvelopeSchemas.financialTransaction.list.shape.fields
              .shape["documentCoverage"],
            "unknown",
          ),
          itemizationCoverage: fieldValueFixture(
            entityFieldEnvelopeSchemas.financialTransaction.list.shape.fields
              .shape["itemizationCoverage"],
            "unknown",
          ),
          productsCoverage: fieldValueFixture(
            entityFieldEnvelopeSchemas.financialTransaction.list.shape.fields
              .shape["productsCoverage"],
            "unknown",
          ),
          spendingCategorySummary: fieldValueFixture(
            entityFieldEnvelopeSchemas.financialTransaction.list.shape.fields
              .shape["spendingCategorySummary"],
            {
              state: "unclassified",
              categories: [],
              lineCount: 0,
              categorizedLineCount: 0,
              uncategorizedLineCount: 0,
              complete: false,
              amountsKnown: false,
            },
          ),
          coverage: fieldValueFixture(
            entityFieldEnvelopeSchemas.financialTransaction.list.shape.fields
              .shape["coverage"],
            {
              expectation: "unknown",
              booking: "missing",
              document: "unknown",
              itemization: "unknown",
              products: "unknown",
            },
          ),
          dataQuality: fieldValueFixture(
            entityFieldEnvelopeSchemas.financialTransaction.list.shape.fields
              .shape["dataQuality"],
            testCompleteDataQuality(),
          ),
        },
        id: "FTX-2345",
        accountId: "FAC-2345",
        purchaseId: null,
        kind: "purchase",
        status: "posted",
        amount: 42.5,
        transactionDate: "2026-08-16",
        postedDate: "2026-08-16",

        displayName: "Neighborhood Market",
        rawDescription: null,
        sourceCategory: null,

        notes: null,
        allocations,
        ledgerTransferId: null,

        spendingCategoryName: null,

        accountName: "Household Card",
        createdAt: new Date("2026-08-16T00:00:00.000Z"),
        updatedAt: new Date("2026-08-16T00:00:00.000Z"),
      }),
    ],
    meta: { pageIndex: 0, pageSize: 100, hasNextPage: false, totalCount: 1 },
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
