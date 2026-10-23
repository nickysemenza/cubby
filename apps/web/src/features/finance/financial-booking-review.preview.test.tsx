import {
  financialBookingInput,
  financialBookingPreview,
} from "@cubby/schemas/financial-booking";
import { financialTransactionOut } from "@cubby/schemas/financial-transaction";
import { testShortcode } from "@cubby/schemas/testing";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { z } from "zod";

import {
  getEntityListOutputSchema,
  purchaseListItem,
} from "~/entity/generated/entity-lists.gen";
import { overrideStartDispatch } from "~/integrations/tanstack-query/start-transport";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { mock } from "~/lib/test/mock-schema";

import { FinancialBookingReview } from "./financial-booking-review";

let harness: ReturnType<typeof createBrowserTestHarness> | undefined;
let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
  harness?.dispose();
  harness = undefined;
});

// SQL owns signed money and resolved policy; this native owner keeps the real
// credit-purpose/Purchase choices and forwards the accepted review unchanged.
it("reviews a reimbursement against the chosen Purchase and commits its exact approval", async () => {
  harness = createBrowserTestHarness();
  const transactionId = testShortcode("financialTransaction", "FTX-4K7M");
  const purchaseId = testShortcode("purchase", "PUR-4K7M");
  const transaction = mock(financialTransactionOut, {
    overrides: {
      id: transactionId,
      amount: -40,
      kind: "income",
      status: "posted",
      postedDate: "2026-09-12",
      allocations: [],
      coverage: { booking: "missing" },
    },
  });
  const purchase = mock(purchaseListItem, {
    overrides: {
      id: purchaseId,
      displayName: "Synthetic shared lodge",
      images: [],
      displayImages: [],
    },
  });
  const review = mock(financialBookingPreview, {
    overrides: {
      transactionId,
      purchaseId,
      vendorId: null,
      spendingCategoryId: null,
      purchaserId: null,
      economicRole: "reimbursement",
      trade: "other",
      costType: "materials",
      action: "create_aggregate",
      amount: -40,
      date: "2026-09-12",
      name: "Synthetic contribution",
      accountName: "Synthetic review account",
      snapshot: "synthetic-reviewed-credit",
      existingBookedAmount: 100,
    },
  });
  const previews: unknown[] = [];
  const commits: unknown[] = [];
  restore = overrideStartDispatch(async (operation, input) => {
    if (operation === "entity.list") {
      z.object({ entity: z.literal("purchase") }).parse(input);
      return {
        ok: true,
        data: mock(getEntityListOutputSchema("purchase"), {
          overrides: {
            items: [purchase],
            meta: { totalCount: 1, pageIndex: 0, pageSize: 20 },
          },
        }),
      };
    }
    if (operation === "financialTransaction.previewBooking") {
      previews.push(financialBookingInput.parse(input));
      return { ok: true, data: review };
    }
    if (operation === "financialTransaction.commitBooking") {
      commits.push(input);
      return {
        ok: true,
        data: {
          purchaseId,
          expenseId: testShortcode("expense", "EXP-4K7M"),
          replayed: false,
        },
      };
    }
    throw new Error(`Unexpected booking operation ${operation}`);
  });
  await harness.loadRouter();
  render(<FinancialBookingReview transaction={transaction} />, {
    wrapper: harness.wrapper,
  });
  expect(screen.getByRole("button", { name: "Review Expense" })).toBeDisabled();
  await userEvent.click(
    screen.getByRole("combobox", { name: "Credit purpose" }),
  );
  await userEvent.click(
    await screen.findByRole("option", { name: "Friend reimbursement" }),
  );
  await userEvent.click(
    screen.getByRole("combobox", { name: "Existing purchase" }),
  );
  await userEvent.click(
    await screen.findByRole("option", { name: /Synthetic shared lodge/ }),
  );
  expect(commits).toEqual([]);
  await userEvent.click(screen.getByRole("button", { name: "Review Expense" }));
  await screen.findByText(/as a reimbursement credit/);
  expect(previews).toEqual([
    {
      transactionId,
      purchaseId,
      vendorId: null,
      spendingCategoryId: null,
      purchaserId: null,
      economicRole: "reimbursement",
      trade: "other",
      costType: "materials",
    },
  ]);
  expect(commits).toEqual([]);
  await userEvent.click(screen.getByRole("button", { name: "Record Expense" }));
  await waitFor(() => expect(commits).toEqual([review]));
});
