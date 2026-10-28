import { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";
import { testCompleteDataQuality, testShortcode } from "@cubby/schemas/testing";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render as testingRender,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { metadataQueryClient } from "#web/tests/entity-metadata.ts";
import type { ListRowOf } from "~/entity/display/list-renderer-types";
import { entityReadFixture } from "~/entity/fields/field-envelope.fixtures";
import { fieldValueFixture } from "~/entity/fields/field-envelope.fixtures";
import RTable from "~/entity/table/table";
import { expenseVendorColumn } from "~/features/project/shared";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import {
  createCubbyColumnHelper,
  useCubbyTable,
} from "~/ui/data-table/table-features";

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

const LINKED: ExpenseOut = entityReadFixture(
  entityFieldEnvelopeSchemas.expense.list,
  {
    fields: {
      spendingCategoryId: fieldValueFixture(
        entityFieldEnvelopeSchemas.expense.detail.shape.fields.shape[
          "spendingCategoryId"
        ],
        null,
      ),
      lineKind: fieldValueFixture(
        entityFieldEnvelopeSchemas.expense.detail.shape.fields.shape[
          "lineKind"
        ],
        "principal",
      ),
      costType: fieldValueFixture(
        entityFieldEnvelopeSchemas.expense.detail.shape.fields.shape[
          "costType"
        ],
        "tools",
      ),
      trade: fieldValueFixture(
        entityFieldEnvelopeSchemas.expense.detail.shape.fields.shape["trade"],
        "other",
      ),
      projectId: fieldValueFixture(
        entityFieldEnvelopeSchemas.expense.detail.shape.fields.shape[
          "projectId"
        ],
        null,
      ),
      productId: fieldValueFixture(
        entityFieldEnvelopeSchemas.expense.detail.shape.fields.shape[
          "productId"
        ],
        null,
      ),
      purchaseId: fieldValueFixture(
        entityFieldEnvelopeSchemas.expense.detail.shape.fields.shape[
          "purchaseId"
        ],
        testShortcode("purchase", "PUR-4K7M"),
      ),
      vendor: fieldValueFixture(
        entityFieldEnvelopeSchemas.expense.detail.shape.fields.shape["vendor"],
        "Tool Shop",
      ),
      orderId: fieldValueFixture(
        entityFieldEnvelopeSchemas.expense.detail.shape.fields.shape["orderId"],
        "ORDER-42",
      ),
      dataQuality: fieldValueFixture(
        entityFieldEnvelopeSchemas.expense.detail.shape.fields.shape[
          "dataQuality"
        ],
        testCompleteDataQuality(),
      ),
    },
    id: testShortcode("expense", "EXP-4K7M"),
    name: "Dust extractor",
    cost: 500,
    date: "2026-07-20",
    bookingTransactionCode: null,
    economicRole: "vendor",

    spendingCategoryName: null,

    lineBasis: "item_line",

    url: null,
    notes: null,
    future: false,

    projectName: null,

    productQuantity: null,
    productName: null,

    purchaseDate: "2026-07-19",
    purchaseDisplayLabel: null,
    vendorId: testShortcode("vendor", "VEN-4K7M"),
    vendorLogo: null,

    orderUrl: null,
    beneficiaries: [],
    funders: [],
    sourceClaims: [],

    createdAt: new Date("2026-07-20T00:00:00Z"),
    updatedAt: new Date("2026-07-20T00:00:00Z"),
  },
);

const helper = createCubbyColumnHelper<ExpenseOut>();

function ExpensePurchaseCell({ expense }: { expense: ExpenseOut }) {
  const columns = useMemo(
    () =>
      helper.columns([
        expenseVendorColumn(queryClient, helper, async () => undefined, {
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
  return (
    <RTable
      table={table}
      ariaLabel="Expense purchase"
      withoutImages="Fixture: only the Purchase column is under test."
    />
  );
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
    expect(screen.queryByRole("button", { name: "Edit vendor" })).toBeNull();
    fireEvent.pointerOver(link, { pointerType: "mouse" });
    const pencil = screen.getByRole("button", { name: "Edit vendor" });
    expect(link.getAttribute("href")).toBe("/purchases/PUR-4K7M");
    expect(link.contains(pencil)).toBe(false);
  });

  it("shows an empty value with an edit affordance when unattached", async () => {
    renderCell({
      ...LINKED,
      purchaseDate: null,
      vendorId: null,
      fields: {
        ...LINKED.fields,
        purchaseId: fieldValueFixture(
          entityFieldEnvelopeSchemas.expense.list.shape.fields.shape.purchaseId,
          null,
        ),
        vendor: fieldValueFixture(
          entityFieldEnvelopeSchemas.expense.list.shape.fields.shape.vendor,
          null,
        ),
        orderId: fieldValueFixture(
          entityFieldEnvelopeSchemas.expense.list.shape.fields.shape.orderId,
          null,
        ),
      },
    });

    const empty = await screen.findByText("(none)");
    fireEvent.pointerOver(empty, { pointerType: "mouse" });
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit vendor" })).toBeTruthy();
  });
});

type ExpenseOut = ListRowOf<"expense">;
