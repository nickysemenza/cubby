import { entityApi } from "./support/entity-api";
import {
  financialBookingPreview,
  financialBookingResult,
} from "@cubby/schemas/financial-booking";
import { z } from "zod";
import {
  gotoAuthenticatedPage,
  selectComboboxItem,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";
import { dispatchesOperation } from "./support/dispatch-wire";
import { createFixtureGraph, ensureMemberParty } from "./fixtures/core";

// A stale screen must not book changed bank evidence. Retries must preserve the
// approved decision. Reimbursement interaction and signed money have native/SQL owners.
// Optional paperwork must stay absent from both transaction UI and Purchase gaps.
test("reviews spending in the browser with stale and replay guards", async ({
  page,
  baseURL,
}) => {
  const headers = { Origin: baseURL! };
  const waitForOperation = (operation: "previewBooking" | "commitBooking") =>
    page.waitForResponse((response) =>
      dispatchesOperation(
        response.request(),
        `financialTransaction.${operation}`,
      ),
    );
  const vendorName = "Synthetic review cafe";
  const owner = await ensureMemberParty(page, "Synthetic booking member");
  const { transactionId } = await createFixtureGraph(page, async (create) => {
    await create("spendingCategory", {
      name: "Synthetic reviewed dining",
      itemizationExpectation: "not_expected",
      productExpectation: "not_expected",
    });
    await create("vendor", {
      name: vendorName,
      itemizationExpectation: "not_expected",
    });
    const account = await create("financialAccount", {
      name: "Synthetic review card",
      identity: { kind: "credit_card", network: "visa" },
      ledgerPartyId: owner.shortcode,
    });
    const transaction = await create("financialTransaction", {
      accountId: account.id,
      amount: 120,
      merchant: vendorName,
      kind: "purchase",
      status: "posted",
      postedDate: "2026-09-10",
    });
    return { transactionId: transaction.id };
  });
  await gotoAuthenticatedPage(
    page,
    `/financial-transactions/${transactionId}`,
    page.getByRole("button", { name: "Review Expense", exact: true }),
  );
  await selectComboboxItem(
    page,
    page.getByRole("combobox", { name: "Vendor", exact: true }),
    vendorName,
  );
  await selectComboboxItem(
    page,
    page.getByRole("combobox", { name: "Spending category", exact: true }),
    "Synthetic reviewed dining",
  );
  // The booked Expense takes the chosen Trade and Cost type, not fixed
  // defaults.
  await page.getByRole("combobox", { name: "Trade", exact: true }).click();
  await page.getByRole("option", { name: "Flooring", exact: true }).click();
  await page.getByRole("combobox", { name: "Cost type", exact: true }).click();
  await page.getByRole("option", { name: "Services", exact: true }).click();
  await page
    .getByRole("button", { name: "Review Expense", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Record Expense", exact: true }),
  ).toBeVisible();
  const changed = await entityApi(page.request).update(
    "financialTransaction",
    transactionId,
    { amount: 125 },
    { headers },
  );
  expect(changed.ok(), await changed.text()).toBeTruthy();
  const rejectedResponse = waitForOperation("commitBooking");
  await page
    .getByRole("button", { name: "Record Expense", exact: true })
    .click();
  expect(
    z
      .object({ json: z.object({ ok: z.boolean() }) })
      .parse(await (await rejectedResponse).json()).json.ok,
  ).toBe(false);
  const unbooked = await entityApi(page.request).get(
    "financialTransaction",
    transactionId,
    {},
  );
  expect(
    z.object({ allocations: z.array(z.unknown()) }).parse(await unbooked.json())
      .allocations,
  ).toEqual([]);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  const previewResponse = waitForOperation("previewBooking");
  await page
    .getByRole("button", { name: "Review Expense", exact: true })
    .click();
  const review = z
    .object({
      json: z.object({ ok: z.literal(true), data: financialBookingPreview }),
    })
    .parse(await (await previewResponse).json()).json.data;
  expect(review.amount).toBe(125);
  expect(review.trade).toBe("flooring");
  expect(review.costType).toBe("services");
  const committedResponse = waitForOperation("commitBooking");
  await page
    .getByRole("button", { name: "Record Expense", exact: true })
    .click();
  const committed = await committedResponse;
  expect(committed.ok(), await committed.text()).toBeTruthy();
  const result = z
    .object({
      json: z.object({ ok: z.literal(true), data: financialBookingResult }),
    })
    .parse(await committed.json()).json.data;
  await expect(
    page.getByText("Not expected", { exact: true }).first(),
  ).toBeVisible();
  const replay = await page.request.post(
    "/api/operations/financialTransaction.commitBooking",
    {
      headers,
      data: { operation: "financialTransaction.commitBooking", input: review },
    },
  );
  expect(replay.ok(), await replay.text()).toBeTruthy();
  expect(financialBookingResult.parse((await replay.json()).data)).toEqual({
    ...result,
    replayed: true,
  });
  const altered = await page.request.post(
    "/api/operations/financialTransaction.commitBooking",
    {
      headers,
      data: {
        operation: "financialTransaction.commitBooking",
        input: { ...review, name: "Synthetic altered approval" },
      },
    },
  );
  expect(altered.ok()).toBeFalsy();
  const purchaseResponse = await entityApi(page.request).get(
    "purchase",
    result.purchaseId,
    {},
  );
  const purchase = z
    .object({ expenseTotal: z.number() })
    .parse(await purchaseResponse.json());
  expect(purchase.expenseTotal).toBe(125);
});
