import {
  financialBookingPreview,
  financialBookingResult,
} from "@cubby/schemas/financial-booking";
import { z } from "zod";
import { financialAccountCreateInput } from "@cubby/schemas/financial-account";
import { financialTransactionCreateInput } from "@cubby/schemas/financial-transaction";
import { spendingCategoryCreateInput } from "@cubby/schemas/spending-category";
import { vendorCreateInput } from "@cubby/schemas/vendor";
import { gotoAuthenticatedPage, selectComboboxItem } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

// A stale screen must not book changed bank evidence. Retries must preserve the
// approved decision, and negative income must expose reimbursement review.
test("reviews spending and reimbursement in the browser with stale and replay guards", async ({
  page,
  baseURL,
}) => {
  const headers = { Origin: baseURL! };
  const waitForOperation = (operation: "previewBooking" | "commitBooking") =>
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/browser/dispatch") &&
        response.request().method() === "POST" &&
        z
          .object({ json: z.object({ operation: z.string() }) })
          .parse(response.request().postDataJSON()).json.operation ===
          `financialTransaction.${operation}`,
    );
  const create = async (
    path: string,
    data:
      | z.input<typeof financialAccountCreateInput>
      | z.input<typeof financialTransactionCreateInput>
      | z.input<typeof spendingCategoryCreateInput>
      | z.input<typeof vendorCreateInput>,
  ) => {
    const response = await page.request.post(`/api/v1/${path}`, {
      headers,
      data: z.json().parse(data),
    });
    expect(response.status(), await response.text()).toBe(201);
    return z
      .object({ item: z.object({ id: z.string() }) })
      .parse(await response.json()).item.id;
  };
  const categoryId = await create("spending-categories", {
    name: "Synthetic reviewed dining",
    evidenceExpectation: "not_expected",
    productExpectation: "not_expected",
  });
  const vendorName = "Synthetic review cafe";
  await create("vendors", {
    name: vendorName,
    evidenceExpectation: "not_expected",
  });
  const accountId = await create("financial-accounts", {
    name: "Synthetic review card",
    identity: { kind: "credit_card", issuer: null, network: "visa" },
  });
  const transactionId = await create("financial-transactions", {
    accountId,
    amount: 120,
    merchant: vendorName,
    kind: "purchase",
    status: "posted",
    postedDate: "2026-09-10",
    spendingCategoryId: categoryId,
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
  await page
    .getByRole("button", { name: "Review Expense", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Record Expense", exact: true }),
  ).toBeVisible();
  const changed = await page.request.patch(
    `/api/v1/financial-transactions/${transactionId}`,
    { headers, data: { amount: 125 } },
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
  const unbooked = await page.request.get(
    `/api/v1/financial-transactions/${transactionId}`,
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
  const replay = await page.request.post(
    "/api/v1/financialTransaction/commitBooking",
    { headers, data: review },
  );
  expect(replay.ok(), await replay.text()).toBeTruthy();
  expect(financialBookingResult.parse(await replay.json())).toEqual({
    ...result,
    replayed: true,
  });
  const altered = await page.request.post(
    "/api/v1/financialTransaction/commitBooking",
    { headers, data: { ...review, name: "Synthetic altered approval" } },
  );
  expect(altered.ok()).toBeFalsy();
  const purchaseResponse = await page.request.get(
    `/api/v1/purchases/${result.purchaseId}`,
  );
  const purchase = z
    .object({ displayName: z.string(), expenseTotal: z.number() })
    .parse(await purchaseResponse.json());
  expect(purchase.expenseTotal).toBe(125);
  const creditId = await create("financial-transactions", {
    accountId,
    amount: -40,
    merchant: "Synthetic friend contribution",
    kind: "income",
    status: "posted",
    postedDate: "2026-09-12",
  });
  await gotoAuthenticatedPage(
    page,
    `/financial-transactions/${creditId}`,
    page.getByRole("button", { name: "Review Expense", exact: true }),
  );
  await page
    .getByRole("combobox", { name: "Credit purpose", exact: true })
    .selectOption("reimbursement");
  await selectComboboxItem(
    page,
    page.getByRole("combobox", { name: "Existing purchase", exact: true }),
    purchase.displayName,
    { query: vendorName, code: result.purchaseId },
  );
  await page
    .getByRole("button", { name: "Review Expense", exact: true })
    .click();
  await expect(page.getByText(/as a reimbursement credit/)).toBeVisible();
  const creditResponse = waitForOperation("commitBooking");
  await page
    .getByRole("button", { name: "Record Expense", exact: true })
    .click();
  const credit = await creditResponse;
  expect(credit.ok(), await credit.text()).toBeTruthy();
  expect(
    z
      .object({
        json: z.object({ ok: z.literal(true), data: financialBookingResult }),
      })
      .parse(await credit.json()).json.data.purchaseId,
  ).toBe(result.purchaseId);
  const netResponse = await page.request.get(
    `/api/v1/purchases/${result.purchaseId}`,
  );
  expect(
    z
      .object({ expenseTotal: z.number(), statedTotal: z.null() })
      .parse(await netResponse.json()),
  ).toEqual({ expenseTotal: 85, statedTotal: null });
});
